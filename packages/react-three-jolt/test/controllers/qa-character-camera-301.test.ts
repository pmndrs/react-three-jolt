// Issue #301: the maintainer reported the Character example's camera as "totally broken" and
// suspected the recent CameraRig option refactor (#86) had changed the defaults out from under
// it. It had - but the library's new default is intentional and already pinned by
// `camera-rig-options.test.ts`'s "the default rig is unchanged: 5 metres back, level, unrotated".
//
// Before #86, `CameraRigManager`'s constructor hard coded
// `this.createCamera('main', { space: 'base', position: new THREE.Vector3(4, 4, 4) })` - every
// `<CameraRig>` got an elevated, ~45 degree yaw / ~-35 degree pitch third-person view for free,
// with no way to ask for anything else. #86 turned that hard coded position into the
// `cameraPosition` option so it *could* be asked for, but gave the option itself a neutral
// `(0, 0, 0)` default - flat, level, directly behind the anchor. `CharacterVirtualDemo.tsx` mounts
// `<CameraRig />` with no props, so it silently lost the framing it used to get automatically.
//
// The fix is in the example, not the library: `<CameraRig cameraPosition={[4, 4, 4]} />` asks for
// exactly the pose the old hard coded constructor produced, through the option #86 built for
// exactly this purpose. These tests build the same rig, with the same numbers, through the
// library's public API (no React) and step it with a moving anchor, so the claim "cameraPosition
// restores the old view, and keeps it as the character moves" is proven rather than reasoned about.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CameraRigManager } from '../../src/controllers/systems/camera-rig/camera-rig-system';
import { type BodyState, initJolt, PhysicsSystem } from '../../src/index';

let ps: PhysicsSystem;
const newScene = () => new THREE.Scene();

/** Stand-in for the kinematic anchor a `CharacterControllerSystem` hands the rig. */
const anchorBody = (position: THREE.Vector3): BodyState => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const handle = ps.bodySystem.addBody(mesh, { bodyType: 'kinematic' });
    const body = ps.bodySystem.getBody(handle)!;
    body.position = position;
    return body;
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-character-camera-301');
});

test('regression baseline: the example`s old config (`<CameraRig />`, no props) is flat', () => {
    // this is what CharacterVirtualDemo.tsx rendered before this fix - the "totally broken",
    // unhelpful eye-level camera the maintainer reported in #301
    const body = anchorBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, { followTarget: body });
    rig.setActiveCamera('main');

    assert.equal(rig.controls.currentDistance, 5);
    assert.equal(rig.controls.yaw, 0, 'no elevated diagonal framing without cameraPosition');
    assert.equal(rig.controls.pitch, 0, 'no downward tilt without cameraPosition');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('the fix: cameraPosition=[4,4,4] restores the pre-#86 elevated third-person view', () => {
    const body = anchorBody(new THREE.Vector3(0, 0, 0));
    // matches `<CharacterController><CameraRig cameraPosition={[4, 4, 4]} /></CharacterController>`
    const rig = new CameraRigManager(newScene(), ps, {
        cameraPosition: [4, 4, 4],
        followTarget: body
    });
    rig.setActiveCamera('main');

    const expectedDistance = Math.sqrt(48);
    assert.closeTo(
        rig.controls.currentDistance,
        expectedDistance,
        1e-6,
        'boom did not take its length from cameraPosition'
    );
    assert.closeTo(
        rig.controls.yaw,
        Math.atan2(4, 4),
        1e-6,
        'boom did not take its yaw from cameraPosition'
    );
    assert.closeTo(
        rig.controls.pitch,
        -Math.asin(4 / expectedDistance),
        1e-6,
        'boom did not take its pitch from cameraPosition - the flat regression'
    );

    // one physics step so `updateSpaces` has placed the anchor from the followed body
    ps.onUpdate(1 / 60);

    const camera = rig.getCamera('main')!;
    const world = camera.getWorldPosition(new THREE.Vector3());
    // the anchor sits at body.position + the default anchorOffset (0, 2, 0); the boom then adds
    // back exactly the (4, 4, 4) the pre-#86 hard coded camera used to sit at
    assert.closeTo(world.x, 4, 1e-4);
    assert.closeTo(world.y, 6, 1e-4);
    assert.closeTo(world.z, 4, 1e-4);

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});

test('the camera keeps its elevated offset as the anchor moves', () => {
    const body = anchorBody(new THREE.Vector3(0, 0, 0));
    const rig = new CameraRigManager(newScene(), ps, {
        cameraPosition: [4, 4, 4],
        followTarget: body
    });
    rig.setActiveCamera('main');
    ps.onUpdate(1 / 60);

    body.position = new THREE.Vector3(10, 0, -20);
    ps.onUpdate(1 / 60);

    const camera = rig.getCamera('main')!;
    const world = camera.getWorldPosition(new THREE.Vector3());
    assert.closeTo(world.x, 14, 1e-4, 'camera did not translate with the anchor');
    assert.closeTo(world.y, 6, 1e-4, 'camera did not translate with the anchor');
    assert.closeTo(world.z, -16, 1e-4, 'camera did not translate with the anchor');

    rig.destroy();
    ps.bodySystem.removeBody(body.handle);
});
