// Issue #61: a static body could be repositioned in Jolt, but nothing ever pushed the new pose
// onto its three.js object - the frame loop only walks bodies that can be awake, and a static
// body never is. These run against the real wasm module, driving `onUpdate` by hand.
//
// As in physics-props.test.ts there is ONE PhysicsSystem for the whole file: worlds are capped
// by `maxInterfaces`.
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('static-bodies');
});

function addStaticBox(size: [number, number, number], at: THREE.Vector3) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(
        ps.bodySystem.addBody(mesh, { bodyType: 'static' })
    ) as BodyState;
    return { mesh, state };
}

function addDynamicBox(at: THREE.Vector3) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh)) as BodyState;
    return { mesh, state };
}

test('a static body can be moved, and its three object follows after one frame', () => {
    const { mesh, state } = addStaticBox([4, 1, 4], new THREE.Vector3(0, 0, 0));
    assert.isTrue(state.isStatic, 'body was not created static');
    assert.equal(ps.bodySystem.staticBodies.size, 1);

    state.position = new THREE.Vector3(10, 3, -2);

    // the physics side moves immediately
    assert.closeTo(state.position.x, 10, 1e-4, 'SetPosition did not reach the static body');
    assert.closeTo(state.position.y, 3, 1e-4);
    assert.closeTo(state.position.z, -2, 1e-4);

    // and the render side catches up on the next frame
    ps.onUpdate(STEP);
    assert.closeTo(mesh.position.x, 10, 1e-4, 'the three object never followed the static body');
    assert.closeTo(mesh.position.y, 3, 1e-4);
    assert.closeTo(mesh.position.z, -2, 1e-4);

    // the drain is one-shot: nothing is queued once it has run
    assert.equal(ps.bodySystem.movedStatics.size, 0, 'the moved-static set was not drained');

    // rotating one works the same way
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    state.rotation = turned;
    ps.onUpdate(STEP);
    assert.isBelow(mesh.quaternion.angleTo(turned), 1e-3, 'the three object never turned');

    state.destroy();
});

test('a dynamic body dropped on a moved static rests on it at its new place', () => {
    const platform = addStaticBox([10, 1, 10], new THREE.Vector3(0, 0, 0));
    // move the platform somewhere the body was never created
    platform.state.position = new THREE.Vector3(30, 5, 0);
    ps.onUpdate(STEP);

    const box = addDynamicBox(new THREE.Vector3(30, 12, 0));
    for (let i = 0; i < 240; i++) ps.onUpdate(STEP);

    // top of the platform (y 5, half height 0.5) + half the box
    const expectedY = 5 + 0.5 + 0.5;
    assert.closeTo(
        box.state.position.y,
        expectedY,
        0.15,
        'the box did not come to rest on the moved platform'
    );
    assert.closeTo(box.state.position.x, 30, 0.5, 'the box slid off the moved platform');
    assert.closeTo(box.mesh.position.y, box.state.position.y, 1e-4);

    box.state.destroy();
    platform.state.destroy();
});

test('moving a static does not queue work for bodies that never move', () => {
    const a = addStaticBox([2, 2, 2], new THREE.Vector3(-20, 0, 0));
    const b = addStaticBox([2, 2, 2], new THREE.Vector3(-20, 0, 8));

    ps.onUpdate(STEP);
    assert.equal(ps.bodySystem.movedStatics.size, 0);

    a.state.position = new THREE.Vector3(-20, 4, 0);
    assert.equal(ps.bodySystem.movedStatics.size, 1, 'only the moved static should be queued');

    // removing a queued body must not leave it in the set for the next frame
    a.state.destroy();
    assert.equal(ps.bodySystem.movedStatics.size, 0, 'a destroyed body stayed queued');
    ps.onUpdate(STEP);

    b.state.destroy();
});
