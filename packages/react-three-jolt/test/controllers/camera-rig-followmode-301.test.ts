// Issue #301 follow-up: the maintainer wants the Character example's camera to feel like a real
// over-the-shoulder third-person chase cam - "behind it... and collide with things" - and to stay
// behind the character as it turns, not just as it translates.
//
// Of the two automatic `CameraFollowMode`s (issue #75), only `'movement'` is a candidate:
// `'lookAt'` keeps a *fixed* point framed past the anchor, which is a different feature (an
// orbit-around-a-landmark camera), not a chase cam. `'movement'` eases the boom's yaw to trail the
// followed body's horizontal *velocity* (camera-rig-system.ts's `movementYaw()`), not its
// rotation/facing quaternion directly - there is no followMode that reads `attachment.rotation` or
// `characterSystem`'s heading. This works out for `CharacterControllerSystem` in practice because
// `CharacterControllerSystem.move()` (character-controller.ts) sets the character's own facing
// quaternion FROM the movement direction it is given
// (`setFromUnitVectors(new THREE.Vector3(0,0,-1), direction)`) - so for this character controller,
// "trail the velocity" and "trail the facing" are the same rotation, and `'movement'` is the right
// answer. A character that could strafe (move one way while facing another) would need a followMode
// this library does not have (one driven by rotation instead of velocity) - noted rather than
// hacked in.
//
// Caveat this file also pins: `'movement'` mode *recentres* the boom's yaw exactly opposite the
// travel direction over time - it does not preserve an initial `cameraPosition` x-offset ("over the
// shoulder" skew). A `cameraPosition` like `[0.8, 1.2, 4]` still gives a shoulder-offset *starting*
// pose, but once the character is moving steadily the camera settles in directly behind, not offset
// to one side. That is expected, not a bug: there is no way to keep a fixed local skew while also
// pointing "directly behind travel" - the two are different targets.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CameraRigManager } from '../../src/controllers/systems/camera-rig/camera-rig-system';
import { type BodyState, initJolt, PhysicsSystem } from '../../src/index';

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

const movingBody = (velocity: THREE.Vector3): BodyState => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const handle = ps.bodySystem.addBody(mesh, { bodyType: 'kinematic' });
    const body = ps.bodySystem.getBody(handle)!;
    body.velocity = velocity;
    return body;
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-followmode-301');
});

/** camera position relative to the anchor, and the camera's world-space forward direction. */
function readRelativePose(rig: CameraRigManager) {
    const camera = rig.getCamera('main')!;
    camera.updateWorldMatrix(true, false);
    const cameraPos = camera.getWorldPosition(new THREE.Vector3());
    const anchorPos = rig.anchor.getWorldPosition(new THREE.Vector3());
    const offset = cameraPos.clone().sub(anchorPos);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    return { offset, forward };
}

test('over-the-shoulder chase cam: camera starts behind + above + to one side, facing forward', () => {
    // character "facing -Z" - CharacterControllerSystem.move() would set this same rotation from
    // this same direction (setFromUnitVectors((0,0,-1), direction))
    const body = movingBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        cameraPosition: [0.8, 1.2, 4],
        followMode: 'movement',
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');
    ps.onUpdate(1 / 60);

    const { offset, forward } = readRelativePose(rig);
    // behind (+Z, the side the character's back is on when it faces -Z) ...
    assert.isAbove(offset.z, 3, `camera is not behind the character (offset.z ${offset.z})`);
    // ... above ...
    assert.isAbove(offset.y, 0.5, `camera is not above the character (offset.y ${offset.y})`);
    // ... and to one shoulder
    assert.isAbove(
        Math.abs(offset.x),
        0.3,
        `camera is not offset to a shoulder (offset.x ${offset.x})`
    );
    // looking forward, roughly the way the character faces (-Z)
    assert.isBelow(
        forward.z,
        -0.8,
        `camera does not look forward (-Z) (forward ${forward.toArray()})`
    );

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('the camera stays behind the character as it turns 90 degrees', () => {
    // moving (and so, for this character controller, facing) toward -Z
    const body = movingBody(new THREE.Vector3(0, 0, -5));
    const rig = new CameraRigManager(newScene(), ps, {
        cameraPosition: [0.8, 1.2, 4],
        followMode: 'movement',
        followTarget: body,
        allowCameraClipping: true
    });
    rig.setActiveCamera('main');
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    let pose = readRelativePose(rig);
    assert.isAbove(
        pose.offset.z,
        3,
        `camera did not settle in behind -Z travel (offset.z ${pose.offset.z})`
    );
    assert.isBelow(
        pose.forward.z,
        -0.9,
        `camera does not face the travel direction (forward ${pose.forward.toArray()})`
    );

    // turn 90 degrees: now moving (and facing) toward -X
    body.velocity = new THREE.Vector3(-5, 0, 0);
    for (let i = 0; i < 150; i++) ps.onUpdate(1 / 60);

    pose = readRelativePose(rig);
    // trailing -X motion means the camera ends up on the +X side, behind the new direction
    assert.isAbove(pose.offset.x, 3, `camera did not follow the turn (offset.x ${pose.offset.x})`);
    assert.isBelow(
        pose.forward.x,
        -0.9,
        `camera does not face the new travel direction (forward ${pose.forward.toArray()})`
    );
    // still above the character - the turn only changes yaw
    assert.isAbove(
        pose.offset.y,
        0.5,
        `camera lost its height after the turn (offset.y ${pose.offset.y})`
    );

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});
