// Issue #92: "ray base whiskers" for the camera boom. Short rays fan out either side of the boom
// every step and rotate the yaw away from whatever they touch, so the camera slides around a
// corner instead of waiting for the wall to actually get between it and the player and then
// snapping in.
//
// Geometry note for everything below: the boom runs down the pivot's +Z, and `pivot.rotation.y`
// turns it the way three.js turns anything about +Y. A whisker fanned to the +X side of the boom
// that finds a wall therefore has to push `rotation.y` negative - away from the wall.

import { initJolt, PhysicsSystem, Raw } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { installAllocTracker } from '../../react-three-jolt/test/jolt-alloc';
import { CameraRigManager } from '../src/systems/camera-rig/camera-rig-system';

// Everything the rig, the boom, the whisker raycaster and the core query helpers allocate with
// `new Raw.module.*`. Shape classes are absent on purpose: they are reference counted and given
// back with `Release()`, which the tracker cannot see.
const TRACKED_TYPES = [
    'RRayCast',
    'RayCastSettings',
    'RShapeCast',
    'ShapeCastSettings',
    'CollideShapeSettings',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'CastRayClosestHitCollisionCollector',
    'CastRayAllHitCollisionCollector',
    'CastShapeClosestHitCollisionCollector',
    'CastShapeAllHitCollisionCollector',
    'CollideShapeClosestHitCollisionCollector',
    'CollideShapeAllHitCollisionCollector',
    'SphereShapeSettings',
    'BodyID',
    'SubShapeID',
    'Vec3',
    'RVec3',
    'Quat',
    'RMat44'
];

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

/** A wall standing just off the +X side of an unrotated boom, well inside whisker range. */
const addWall = () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 12));
    wall.position.set(2, 0, 0);
    return ps.bodySystem.addBody(wall, { bodyType: 'static' });
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-whiskers');
    // the floor sits below the whiskers, which sweep horizontally through y = 0
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -4, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // build one rig up front so every lazily created singleton exists before anything is counted
    new CameraRigManager(newScene(), ps, { whiskers: true }).destroy();
});

test('a wall beside the boom rotates the yaw away from it', () => {
    const wall = addWall();
    const rig = new CameraRigManager(newScene(), ps, {
        whiskers: true,
        whiskerLength: 4,
        // keep the boom's own distance logic out of the way: this test is about yaw
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    assert.equal(rig.controls.yaw, 0, 'the boom did not start unrotated');
    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);

    assert.isTrue(rig.controls.isWhiskerSteering, 'no whisker ever reached the wall');
    assert.isBelow(
        rig.controls.yaw,
        -0.01,
        `the boom did not steer away from the wall (yaw ${rig.controls.yaw})`
    );

    rig.destroy();
    ps.bodySystem.removeBody(wall);
});

test('the same wall does nothing when whiskers are off', () => {
    const wall = addWall();
    const rig = new CameraRigManager(newScene(), ps, {
        whiskers: false,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, 0, 'the boom rotated with whiskers switched off');
    assert.isFalse(rig.controls.isWhiskerSteering);

    rig.destroy();
    ps.bodySystem.removeBody(wall);
});

test('open space leaves the boom alone and lets the steering rate decay', () => {
    const rig = new CameraRigManager(newScene(), ps, { whiskers: true, allowCameraClipping: true });
    rig.setActiveCamera('main');
    // pretend the previous frames had been steering hard
    rig.controls.whiskerYawVelocity = 1;

    // 0.8 per step (the default damping) takes ~62 steps to fall under the snap-to-zero epsilon
    for (let i = 0; i < 80; i++) ps.onUpdate(1 / 60);
    assert.isFalse(rig.controls.isWhiskerSteering, 'a whisker hit something in an empty world');
    assert.equal(rig.controls.whiskerYawVelocity, 0, 'the steering rate never damped out');

    rig.destroy();
});

test('whiskerStrength scales how hard the boom steers', () => {
    const wall = addWall();
    const run = (whiskerStrength: number) => {
        const rig = new CameraRigManager(newScene(), ps, {
            whiskers: true,
            whiskerLength: 4,
            whiskerStrength,
            allowCameraClipping: true
        });
        rig.setActiveCamera('main');
        for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
        const yaw = rig.controls.yaw;
        rig.destroy();
        return yaw;
    };

    const gentle = run(1);
    const strong = run(4);
    assert.isBelow(strong, gentle, 'a stronger whisker did not steer further');
    ps.bodySystem.removeBody(wall);
});

test('setOptions can turn whiskers on and off on a live rig', () => {
    const wall = addWall();
    const rig = new CameraRigManager(newScene(), ps, { allowCameraClipping: true });
    rig.setActiveCamera('main');
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, 0);

    rig.setOptions({ whiskers: true, whiskerLength: 4 });
    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
    const steered = rig.controls.yaw;
    assert.isBelow(steered, -0.01, 'whiskers did not start working after setOptions');

    rig.setOptions({ whiskers: false });
    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, steered, 'the boom kept steering after whiskers were disabled');

    rig.destroy();
    ps.bodySystem.removeBody(wall);
});

test('200 steps with whiskers on allocate nothing, and destroy() gives it all back', () => {
    const wall = addWall();
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        // warm-up round under the tracked module (it swaps Raw.module, rebuilding joltScratch)
        const warmup = new CameraRigManager(newScene(), ps, { whiskers: true });
        warmup.setActiveCamera('main');
        ps.onUpdate(1 / 60);
        warmup.destroy();
        const baseline = alloc.live();

        const rig = new CameraRigManager(newScene(), ps, {
            whiskers: true,
            whiskerCount: 7,
            whiskerLength: 4,
            collisionRadius: 0.4
        });
        rig.setActiveCamera('main');
        // a first step builds whatever the step path builds once
        ps.onUpdate(1 / 60);
        const settled = alloc.live();

        for (let i = 0; i < 200; i++) ps.onUpdate(1 / 60);
        assert.equal(
            alloc.live(),
            settled,
            `200 whisker steps leaked ${alloc.live() - settled}: ${JSON.stringify(alloc.liveByType())}`
        );

        rig.destroy();
        assert.equal(
            alloc.live(),
            baseline,
            `destroy() left ${alloc.live() - baseline} behind: ${JSON.stringify(alloc.liveByType())}`
        );
        assert.equal(alloc.foreignDestroys(), 0, 'the rig freed something it does not own');
    } finally {
        alloc.uninstall();
        ps.bodySystem.removeBody(wall);
    }
});
