// Issue #75: the PC-style rig only ever *translates* with the anchor, so running off sideways
// leaves you looking at the character's ear until you drag the camera round yourself.
// `followMode: 'movement'` eases the boom's yaw round to trail the character's horizontal
// velocity - the "Mario style" camera - without ever fighting a recent look command.
//
// Geometry: the camera rides the pivot's +Z, so trailing a body heading +X means a yaw of
// `atan2(-1, 0)` = -PI/2, which parks the camera at -X - behind them.

import { type BodyState, initJolt, PhysicsSystem } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CameraRigManager } from '../src/systems/camera-rig/camera-rig-system';

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

// The rig eases `pivot.rotation.y` the short way round but never renormalises it, so a boom that
// has chased the player through a full turn legitimately sits outside -PI..PI. Compare wrapped.
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** A kinematic body the rig can follow, travelling at `velocity` metres per second. */
const movingBody = (velocity: THREE.Vector3): BodyState => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const handle = ps.bodySystem.addBody(mesh, { bodyType: 'kinematic' });
    const body = ps.bodySystem.getBody(handle)!;
    body.velocity = velocity;
    return body;
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-follow');
});

test('movement mode swings the boom in behind a body running +X', () => {
    const body = movingBody(new THREE.Vector3(4, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'movement',
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    assert.equal(rig.controls.yaw, 0, 'the boom did not start unrotated');
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    // trailing +X motion means a yaw of -PI/2
    assert.closeTo(rig.controls.yaw, -Math.PI / 2, 0.25, `yaw stopped at ${rig.controls.yaw}`);
    // and that is where the camera actually ends up: behind the body, on its -X side
    const camera = rig.getCamera('main')!;
    const offset = camera
        .getWorldPosition(new THREE.Vector3())
        .sub(rig.anchor.getWorldPosition(new THREE.Vector3()));
    assert.isBelow(offset.x, -3, 'the camera is not trailing the body');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('movement mode follows a change of direction', () => {
    const body = movingBody(new THREE.Vector3(0, 0, 5));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'movement',
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');
    // the ease is exponential, so a half turn needs a couple of seconds to settle
    for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);
    // trailing +Z motion is a yaw of atan2(0, -1) = PI
    assert.closeTo(Math.abs(wrap(rig.controls.yaw)), Math.PI, 0.3);

    body.velocity = new THREE.Vector3(-5, 0, 0);
    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);
    // trailing -X motion is a yaw of atan2(1, 0) = PI/2
    assert.closeTo(wrap(rig.controls.yaw), Math.PI / 2, 0.25, `yaw stopped at ${rig.controls.yaw}`);

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('a recent look command pauses movement mode', () => {
    const body = movingBody(new THREE.Vector3(4, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'movement',
        followTarget: body,
        manualOverrideTimeout: 1000,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    // the look command itself does not turn the boom (x = 0), it only stamps the clock
    rig.moveBoom({ x: 0, y: 0 });
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, 0, 'movement mode overrode a look command from this instant');

    // let the override lapse and the rig picks the character back up
    rig.setOptions({ manualOverrideTimeout: 0 });
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.closeTo(rig.controls.yaw, -Math.PI / 2, 0.25, 'the rig never resumed following');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('movement mode ignores anything slower than the threshold', () => {
    const body = movingBody(new THREE.Vector3(0.1, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'movement',
        followTarget: body,
        movementThreshold: 0.5,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, 0, 'a crawling body dragged the camera round');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test("the default 'free' mode never turns the boom by itself", () => {
    const body = movingBody(new THREE.Vector3(4, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');
    assert.equal(rig.followMode, 'free');

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.equal(rig.controls.yaw, 0, 'the free rig rotated on its own');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test("movement mode prefers the character's own velocity over the anchor body's", () => {
    // the anchor a CharacterController hands the rig is a kinematic stand-in with no velocity
    const body = movingBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'movement',
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');
    // stand in for CharacterControllerSystem: all the rig reads is `linearVelocity`
    rig.characterSystem = {
        linearVelocity: new THREE.Vector3(4, 0, 0)
    } as unknown as NonNullable<typeof rig.characterSystem>;

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.closeTo(rig.controls.yaw, -Math.PI / 2, 0.25, `yaw stopped at ${rig.controls.yaw}`);

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('lookAt mode parks the camera on the far side of the anchor from the target', () => {
    const body = movingBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        followMode: 'lookAt',
        followTarget: body,
        // the anchor rides 2 above the body at the origin; the point of interest is off at +X
        lookAtTarget: new THREE.Vector3(10, 0, 0),
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');

    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);
    // anchor - target points along -X, so the boom yaw is atan2(-1, 0) = -PI/2
    assert.closeTo(rig.controls.yaw, -Math.PI / 2, 0.25, `yaw stopped at ${rig.controls.yaw}`);

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});
