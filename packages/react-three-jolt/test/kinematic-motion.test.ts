// Issue #194: `moveKinematic(position, rotation, deltaTime = 0)` derived its velocity from
// `(target - current) / deltaTime`, so the default of 0 produced no motion at all, and callers
// that only wanted to move (not turn) had to pass a rotation anyway. `setKinematicTarget` is the
// version the step loop drives with the real substep dt.
//
// One PhysicsSystem for the whole file (worlds are capped by `maxInterfaces`).
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('kinematic-motion');
});

function addBox(size: [number, number, number], at: THREE.Vector3, bodyType?: 'kinematic') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(
        ps.bodySystem.addBody(mesh, bodyType ? { bodyType } : undefined)
    ) as BodyState;
    return { mesh, state };
}

test('moveKinematic with no deltaTime uses the world step and actually moves the body', () => {
    ps.resetAccumulator();
    const { state } = addBox([4, 1, 4], new THREE.Vector3(0, 20, 0), 'kinematic');
    const target = new THREE.Vector3(6, 20, 0);

    // one frame, one step: the default delta is the world's own timeStep, so the body covers
    // the whole distance in this step. The old default of 0 left it exactly where it started.
    state.moveKinematic(target);
    ps.onUpdate(STEP);

    assert.closeTo(state.position.x, 6, 1e-3, 'moveKinematic did not reach its target');

    // driving it every frame keeps it on target
    for (let i = 1; i <= 60; i++) {
        target.set(6 + i * 0.1, 20, 0);
        state.moveKinematic(target);
        ps.onUpdate(STEP);
        assert.closeTo(state.position.x, target.x, 1e-2, `off target on frame ${i}`);
    }

    state.destroy();
});

test('moveKinematic without a rotation keeps the body pointing where it was', () => {
    ps.resetAccumulator();
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
    const { state } = addBox([4, 1, 4], new THREE.Vector3(-30, 20, 0), 'kinematic');
    state.rotation = turned;
    ps.onUpdate(STEP);

    state.moveKinematic(new THREE.Vector3(-24, 20, 0));
    ps.onUpdate(STEP);

    assert.closeTo(state.position.x, -24, 1e-3);
    assert.isBelow(
        state.rotation.angleTo(turned),
        1e-3,
        'omitting the rotation straightened the body out'
    );

    // and an explicit rotation is still applied
    const upright = new THREE.Quaternion();
    state.moveKinematic(new THREE.Vector3(-24, 20, 0), upright);
    ps.onUpdate(STEP);
    assert.isBelow(state.rotation.angleTo(upright), 1e-3);

    state.destroy();
});

test('setKinematicTarget is applied by the step loop and reaches the target', () => {
    ps.resetAccumulator();
    const { state } = addBox([4, 1, 4], new THREE.Vector3(30, 20, 0), 'kinematic');

    state.setKinematicTarget(new THREE.Vector3(36, 20, 0));
    ps.onUpdate(STEP);
    assert.closeTo(state.position.x, 36, 1e-3, 'the step loop never applied the target');

    // the target is sticky, and a body that has arrived simply stays put
    for (let i = 0; i < 30; i++) ps.onUpdate(STEP);
    assert.closeTo(state.position.x, 36, 1e-3, 'a reached target pushed the body past it');
    assert.isBelow(state.velocity.length(), 1e-3, 'a reached target left velocity behind');

    // clearing it stops the driving, and removing the body drops it from the step loop
    state.clearKinematicTarget();
    assert.isNull(state.kinematicTarget);
    ps.onUpdate(STEP);

    state.setKinematicTarget(new THREE.Vector3(40, 20, 0));
    state.destroy();
    ps.onUpdate(STEP); // must not touch the destroyed body
});

test('a box resting on a platform driven by setKinematicTarget is carried along', () => {
    ps.resetAccumulator();
    // default body settings on purpose: this is the "riders sleep / slide off" half of #194
    const platform = addBox([10, 1, 10], new THREE.Vector3(0, 0, -40), 'kinematic');
    const rider = addBox([1, 1, 1], new THREE.Vector3(0, 1.1, -40));

    // let the rider land and settle (it may well fall asleep, which is the point)
    for (let i = 0; i < 180; i++) ps.onUpdate(STEP);
    const startX = rider.state.position.x;
    const restY = rider.state.position.y;
    assert.closeTo(restY, 1, 0.1, 'the rider never came to rest on the platform');
    // it really is asleep at this point - what follows is also the "riders sleep through the
    // ride" half of #194: MoveKinematic gives the platform a real velocity, and Jolt wakes the
    // bodies touching it. No mAllowSleeping: false needed.
    assert.isTrue(rider.state.isSleeping, 'the rider never went to sleep, weakening this test');

    // drive the platform 4 units along x over two seconds
    for (let i = 1; i <= 120; i++) {
        platform.state.setKinematicTarget(new THREE.Vector3((i / 120) * 4, 0, -40));
        ps.onUpdate(STEP);
    }

    assert.closeTo(platform.state.position.x, 4, 0.1, 'the platform did not reach its target');
    assert.isAbove(
        rider.state.position.x - startX,
        2,
        'the rider was not carried by the moving platform'
    );
    assert.closeTo(rider.state.position.y, restY, 0.2, 'the rider fell off the platform');

    rider.state.destroy();
    platform.state.destroy();
});
