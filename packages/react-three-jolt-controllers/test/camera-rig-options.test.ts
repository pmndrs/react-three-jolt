// Issue #86: the rig used to be built with the boom's hard coded defaults, attached to the
// physics loop, and only then mutated into shape by whoever created it - so the first frame (or
// several, through `useCameraRig`'s effects) ran against a half configured boom. Options now go
// in through the constructor / `initialize()`, and `setOptions()` updates a live rig instead of
// rebuilding it.

import { initJolt, PhysicsSystem } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CameraRigManager } from '../src/systems/camera-rig/camera-rig-system';

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-options');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

test('every option reaches the boom before the first pre-step runs', () => {
    // spy on the boom's frame update and record what the boom looked like the first time the
    // physics loop reached it. Before #86 this saw the defaults (distance 5, pitch limits
    // -1.5/0.5) because the caller had not had a chance to mutate the boom yet.
    const seen: {
        distance?: number;
        minPitch?: number;
        maxPitch?: number;
        smoothing?: number;
        collisionRadius?: number;
        attached?: boolean;
    } = {};

    const rig = new CameraRigManager(newScene(), ps, {
        distance: 12,
        minPitch: -1,
        maxPitch: 0.25,
        smoothing: 0.25,
        collisionRadius: 0.75,
        followTarget: ps.bodySystem.getBody(
            ps.bodySystem.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
        )!
    });
    rig.setActiveCamera('main');

    const boom = rig.controls;
    const realFrameUpdate = boom.handleFrameUpdate.bind(boom);
    boom.handleFrameUpdate = (deltaTime?: number) => {
        if (seen.distance === undefined) {
            seen.distance = boom.currentDistance;
            seen.minPitch = boom.minPitch;
            seen.maxPitch = boom.maxPitch;
            seen.smoothing = boom.slerpFactor;
            seen.attached = rig.isAttached;
        }
        return realFrameUpdate(deltaTime);
    };

    ps.onUpdate(1 / 60);

    assert.equal(seen.distance, 12, 'the boom was stepped before its length was set');
    assert.equal(seen.minPitch, -1, 'the boom was stepped before its pitch limits were set');
    assert.equal(seen.maxPitch, 0.25, 'the boom was stepped before its pitch limits were set');
    assert.equal(seen.smoothing, 0.25, 'the boom was stepped before its smoothing was set');
    assert.isTrue(seen.attached, 'the rig was stepped before its follow target was attached');

    rig.destroy();
});

test('the constructor snaps the camera space to the requested length and pitch', () => {
    const rig = new CameraRigManager(newScene(), ps, { distance: 8, pitch: -0.5 });
    const space = rig.controls.cameraSpace;

    assert.equal(rig.controls.currentDistance, 8);
    assert.closeTo(space.rotation.x, -0.5, 1e-9);
    // cameraSpace sits at (0, d*sin(-pitch), d*cos(-pitch))
    assert.closeTo(space.position.y, 8 * Math.sin(0.5), 1e-6);
    assert.closeTo(space.position.z, 8 * Math.cos(0.5), 1e-6);
    assert.closeTo(space.position.length(), 8, 1e-6);

    rig.destroy();
});

test('pitch is clamped into the configured limits, and the limits drive the look command', () => {
    const rig = new CameraRigManager(newScene(), ps, {
        pitch: -2,
        minPitch: -0.4,
        maxPitch: 0.1,
        lookSpeed: 1
    });
    assert.closeTo(rig.controls.cameraSpace.rotation.x, -0.4, 1e-9, 'initial pitch not clamped');

    // a big downward look command would take the pitch past minPitch, so it must be refused
    rig.controls.move({ x: 0, y: -1000 });
    assert.isAtLeast(rig.controls.cameraSpace.rotation.x, -0.4, 'look pushed pitch past minPitch');

    rig.destroy();
});

test('a camera placed away from the origin defines the boom length, pitch and yaw (#86)', () => {
    // "initialize the boom with a camera which would attach the camera to the boom, but also
    // properly rotate the pivot, set the height, and rotate the cameraSpace to properly look at
    // the target" - issue #86.
    const rig = new CameraRigManager(newScene(), ps, { cameraPosition: [4, 4, 4] });
    const expectedDistance = Math.sqrt(48);

    assert.closeTo(rig.controls.currentDistance, expectedDistance, 1e-6);
    assert.closeTo(rig.controls.yaw, Math.atan2(4, 4), 1e-6, 'the pivot was not rotated');
    assert.closeTo(
        rig.controls.pitch,
        -Math.asin(4 / expectedDistance),
        1e-6,
        'the camera space was not pitched'
    );

    // the camera itself ends up exactly where it was asked to be, in rig space
    const camera = rig.getCamera('main')!;
    const world = camera.getWorldPosition(new THREE.Vector3());
    assert.closeTo(world.x, 4, 1e-5);
    assert.closeTo(world.y, 4, 1e-5);
    assert.closeTo(world.z, 4, 1e-5);

    rig.destroy();
});

test('the default rig is unchanged: 5 metres back, level, unrotated', () => {
    const rig = new CameraRigManager(newScene(), ps);
    assert.equal(rig.controls.currentDistance, 5);
    assert.equal(rig.controls.yaw, 0);
    assert.equal(rig.controls.pitch, 0);
    assert.closeTo(rig.controls.cameraSpace.position.z, 5, 1e-9);
    rig.destroy();
});

test('setOptions updates a live rig instead of rebuilding it', () => {
    const rig = new CameraRigManager(newScene(), ps, { distance: 5 });
    rig.setActiveCamera('main');
    const boom = rig.controls;
    const camera = rig.getCamera('main');

    rig.setOptions({ distance: 20, smoothing: 1, allowCameraClipping: true });
    // same boom, same camera: nothing was thrown away
    assert.strictEqual(rig.controls, boom);
    assert.strictEqual(rig.getCamera('main'), camera);

    assert.equal(boom.targetDistance, 20);
    // a live change eases rather than snapping, so it needs a frame
    for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);
    assert.closeTo(boom.currentDistance, 20, 1e-6, 'the boom never eased out to the new length');

    rig.destroy();
});

test('setOptions is a no-op once the rig is destroyed', () => {
    const rig = new CameraRigManager(newScene(), ps, { distance: 7 });
    rig.destroy();
    assert.doesNotThrow(() => rig.setOptions({ distance: 30, collisionRadius: 2 }));
});
