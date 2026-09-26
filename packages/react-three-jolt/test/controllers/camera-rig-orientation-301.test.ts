// Issue #301 follow-up: the maintainer reported the Character example's camera as "WAY off...
// rotated and askew", and the original #301 fix (cameraPosition={[4,4,4]} + the ownsCamera route
// flag on fix/character-camera-301) only restores the camera's WORLD POSITION - it does nothing
// about its ORIENTATION.
//
// Root cause: `CameraRigManager.addCamera()` used to call `camera.lookAt(this.target)` while the
// camera sat in `base`'s frame (its position there is whatever `cameraPosition` asked for), but
// the camera never stays in that frame - `CameraBoom.camera`'s setter immediately resets its
// position to (0,0,0) and reparents it into `cameraSpace` (a child of `pivot`, itself a child of
// `base`) without ever touching the rotation that `lookAt()` had just baked into it. From then on
// `pivot`'s yaw and `cameraSpace`'s pitch (both derived from the very same `cameraPosition`, see
// `CameraBoom.applyOptions`) compound ON TOP OF that stale, wrong-frame rotation instead of being
// the camera's only source of orientation - so the more elevated/angled the requested
// `cameraPosition`, the further off the final view actually is. Before issue #86 (commit
// d342776) `CameraRigManager` never called `CameraBoom.initialize()` with real numbers, so
// `pivot`/`cameraSpace` stayed at identity rotation and the stale bake was the *only* rotation
// applied - mildly wrong, but not "askew". #86 is what turned this dormant bug into a visibly
// broken one.
//
// The fix: `CameraBoom.camera`'s setter now resets the camera's own quaternion to identity before
// handing orientation entirely to `pivot`/`cameraSpace`, and `CameraRigManager.addCamera()` skips
// the `lookAt()` bake for the camera being built for the boom (the `forBoom` flag) since it would
// only ever be immediately overwritten.
//
// This test fails before that fix (forward-target alignment ~0.5-0.9, not >0.99) and passes
// after, for several `cameraPosition`s including an asymmetric "over the shoulder" one.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CameraRigManager } from '../../src/controllers/systems/camera-rig/camera-rig-system';
import { type BodyState, initJolt, PhysicsSystem } from '../../src/index';

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

const anchorBody = (position: THREE.Vector3): BodyState => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const handle = ps.bodySystem.addBody(mesh, { bodyType: 'kinematic' });
    const body = ps.bodySystem.getBody(handle)!;
    body.position = position;
    return body;
};

/**
 * A static wall thick enough (z 4..6) to enclose the default (no `cameraPosition`) boom's resting
 * camera spot (0,2,5) - see camera-rig-whiskers.test.ts and investigate-camera-rig-301.test.ts for
 * why the placement has to actually reach the camera's own collision sphere, not merely cross the
 * target-to-camera sightline.
 */
const addWall = (centerZ = 5) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(12, 12, 2));
    wall.position.set(0, 2, centerZ);
    return ps.bodySystem.addBody(wall, { bodyType: 'static' });
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-orientation-301');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

function forwardTargetAlignment(rig: CameraRigManager) {
    const camera = rig.getCamera('main')!;
    camera.updateWorldMatrix(true, false);
    const position = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const toTarget = rig.controls.targetWorldSpace.clone().sub(position).normalize();
    return forward.dot(toTarget);
}

const cases: { name: string; cameraPosition: [number, number, number] }[] = [
    { name: 'the pre-#86 hard coded elevated view', cameraPosition: [4, 4, 4] },
    {
        name: 'an over-the-shoulder offset (small x, modest y, well back on z)',
        cameraPosition: [0.8, 1.2, 4]
    },
    { name: 'a flat, purely-behind offset (no x/y skew at all)', cameraPosition: [0, 0, 6] },
    { name: 'a low, close-in offset', cameraPosition: [-0.5, 0.3, 2] }
];

for (const { name, cameraPosition } of cases) {
    test(`orientation: ${name} looks at the target (forward.toTarget > 0.99)`, () => {
        const body = anchorBody(new THREE.Vector3(0, 0, 0));
        const rig = new CameraRigManager(newScene(), ps, { cameraPosition, followTarget: body });
        rig.setActiveCamera('main');
        for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);

        const alignment = forwardTargetAlignment(rig);
        assert.isAbove(
            alignment,
            0.99,
            `camera does not face the target for cameraPosition ${cameraPosition} (alignment ${alignment})`
        );

        rig.destroy();
        ps.bodySystem.removeBody(body.handle);
    });
}

test('orientation fix does not disturb the boom pose itself', () => {
    const body = anchorBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        cameraPosition: [4, 4, 4],
        followTarget: body
    });
    rig.setActiveCamera('main');
    ps.onUpdate(1 / 60);

    const camera = rig.getCamera('main')!;
    const world = camera.getWorldPosition(new THREE.Vector3());
    // anchorOffset (0,2,0) + the (4,4,4) boom offset - same numbers qa-character-camera-301.test.ts pins
    assert.closeTo(world.x, 4, 1e-4);
    assert.closeTo(world.y, 6, 1e-4);
    assert.closeTo(world.z, 4, 1e-4);

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('collision still works after the orientation fix: a wall enclosing the resting spot shortens the boom', () => {
    const body = anchorBody(new THREE.Vector3(0, 0, 0));
    const wall = addWall(5);
    const rig = new CameraRigManager(newScene(), ps, { followTarget: body });
    rig.setActiveCamera('main');

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    assert.isTrue(
        rig.controls.isShapecasting,
        'the boom never entered the shapecast-obstructed state'
    );
    assert.isBelow(
        rig.controls.currentDistance,
        4.5,
        `boom did not shorten for the wall (distance ${rig.controls.currentDistance})`
    );
    // and it still faces the target correctly while shortened
    assert.isAbove(
        forwardTargetAlignment(rig),
        0.99,
        'camera lost its orientation while shapecasting'
    );

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
    ps.bodySystem.removeBody(wall);
});
