// Real-WASM regression test for issue #299, found in browser QA of the SleepWake and Motors
// examples: clicking a sleeping box did nothing, and the hinge/slider position motors did
// nothing when their leva target changed.
//
// Root cause, in both cases: a call that only ever reaches `Body` (never `BodyInterface`)
// cannot activate a sleeping body, and Jolt's solver skips inactive bodies entirely -
//   - `BodyState.addImpulse`/`applyForce`/`applyTorque` called `Body.AddImpulse`/`AddForce`/
//     `AddTorque` directly.
//   - `HingeConstraint.SetTargetAngle`/`SetTargetAngularVelocity` and
//     `SliderConstraint.SetTargetPosition`/`SetTargetVelocity`/`SetMotorState` - which is what
//     the Motors demo called directly on the constraint `useConstraint` hands back - never touch
//     either constrained body's active state at all, motor or no motor.
//
// Every test below puts the body (or bodies) to sleep *before* calling the API under test, and
// asserts `IsActive()` immediately after - no step needed - which is the only thing that proves
// the call actually reached Jolt's activation path instead of merely writing a value nobody
// will read until something unrelated wakes the body up. Each test then steps the world and
// checks the physical outcome (a position/angle actually converging, a velocity actually
// nonzero) so a fix that "activates" the body but leaves the value wrong cannot pass by
// accident.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-activation-299');
});

const step = (frames: number) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
};

// every test uses its own lane/rig so bodies never interact across tests
let laneX = 0;

/** A dynamic box, asleep on arrival - no need to wait out the natural sleep timer. */
function sleepingBox(y = 5): BodyState {
    laneX += 5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(laneX, y, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, { mass: 1 }))!;
    ps.bodyInterface.DeactivateBody(state.BodyID);
    assert.isFalse(state.body.IsActive(), 'test setup: body should start asleep');
    return state;
}

/**
 * A static anchor and a dynamic arm swinging around it on an invisible hinge, asleep on
 * arrival. The arm is a separate box 3 units from the anchor (like the "hinge holds its
 * bodies" constraint test) rather than a rod overlapping the anchor's own shape - a rod would
 * fight the motor with contact forces of its own as it swings through the anchor's box.
 */
function sleepingHingeRig(): { anchor: BodyState; arm: BodyState; pivot: THREE.Vector3 } {
    laneX += 10;
    const pivot = new THREE.Vector3(laneX, 10, 0);
    const anchorMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    anchorMesh.position.copy(pivot);
    const anchor = ps.bodySystem.getBody(
        ps.bodySystem.addBody(anchorMesh, { bodyType: 'static' })
    )!;
    const armMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    armMesh.position.set(laneX + 3, 10, 0);
    const arm = ps.bodySystem.getBody(ps.bodySystem.addBody(armMesh, { mass: 1 }))!;

    ps.bodyInterface.DeactivateBody(arm.BodyID);
    assert.isFalse(arm.body.IsActive(), 'test setup: arm should start asleep');
    return { anchor, arm, pivot };
}

/** A static rail and a dynamic carriage sliding along it, asleep on arrival. */
function sleepingSliderRig(): { rail: BodyState; carriage: BodyState } {
    laneX += 10;
    const railMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    railMesh.position.set(laneX, 10, 0);
    const rail = ps.bodySystem.getBody(ps.bodySystem.addBody(railMesh, { bodyType: 'static' }))!;
    const carriageMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    carriageMesh.position.set(laneX, 10, 0.5);
    const carriage = ps.bodySystem.getBody(ps.bodySystem.addBody(carriageMesh, { mass: 1 }))!;

    ps.bodyInterface.DeactivateBody(carriage.BodyID);
    assert.isFalse(carriage.body.IsActive(), 'test setup: carriage should start asleep');
    return { rail, carriage };
}

//* BodyState mutators (the SleepWake "click to wake" bug) ============================

test('addImpulse wakes a sleeping body and moves it', () => {
    const box = sleepingBox();
    const before = box.position.y;
    box.addImpulse(new THREE.Vector3(0, 8, 0));
    assert.isTrue(box.body.IsActive(), 'addImpulse did not wake the body');
    step(15);
    assert.notEqual(box.position.y, before, 'the impulse never actually moved the body');
});

test('addImpulse with { activate: false } leaves the body asleep, unlike the default', () => {
    const box = sleepingBox();
    box.addImpulse(new THREE.Vector3(0, 8, 0), { activate: false });
    assert.isFalse(box.body.IsActive(), '{ activate: false } woke the body anyway');
});

test('applyForce wakes a sleeping body and moves it', () => {
    const box = sleepingBox();
    const before = box.position.y;
    box.applyForce(new THREE.Vector3(0, 500, 0));
    assert.isTrue(box.body.IsActive(), 'applyForce did not wake the body');
    step(15);
    assert.notEqual(box.position.y, before, 'the force never actually moved the body');
});

test('applyForce with { activate: false } leaves the body asleep, unlike the default', () => {
    const box = sleepingBox();
    box.applyForce(new THREE.Vector3(0, 500, 0), { activate: false });
    assert.isFalse(box.body.IsActive(), '{ activate: false } woke the body anyway');
});

test('applyTorque wakes a sleeping body and spins it up', () => {
    const box = sleepingBox();
    box.applyTorque(new THREE.Vector3(0, 50, 0));
    assert.isTrue(box.body.IsActive(), 'applyTorque did not wake the body');
    step(5);
    assert.isAbove(
        box.angularVelocity.length(),
        0.01,
        'the torque never actually spun the body up'
    );
});

test('applyTorque with { activate: false } leaves the body asleep, unlike the default', () => {
    const box = sleepingBox();
    box.applyTorque(new THREE.Vector3(0, 50, 0), { activate: false });
    assert.isFalse(box.body.IsActive(), '{ activate: false } woke the body anyway');
});

//* Constraint motor targets (the Motors "nothing happens" bug) =======================

// Both hinge rigs pivot around a *vertical* axis with the arm swinging in the horizontal
// plane: gravity acts straight down, so it produces zero torque about a vertical axis (its
// moment arm is always horizontal). That keeps the position motor's target reachable exactly
// rather than settling into a gravity-loaded sag against the motor's (finite-stiffness,
// spring-based) servo - the point of this test is proving activation, not tuning a spring.

test('setHingeTargetAngle wakes a sleeping hinge rig and drives it to the new angle', () => {
    const { anchor, arm, pivot } = sleepingHingeRig();
    const hinge = ps.constraintSystem.addConstraint('hinge', anchor, arm, {
        point1: pivot,
        point2: pivot,
        axis: [0, 1, 0],
        normal: [0, 0, 1],
        motor: { type: 'position', target: 0, maxTorque: 5000 }
    });

    ps.constraintSystem.setHingeTargetAngle(hinge, 1.2);
    assert.isTrue(arm.body.IsActive(), 'setHingeTargetAngle did not wake the arm');

    step(180);
    assert.closeTo(hinge.GetCurrentAngle(), 1.2, 0.2, 'the hinge never reached its new target');
});

test('setHingeTargetAngularVelocity wakes a sleeping hinge rig and spins it', () => {
    const { anchor, arm, pivot } = sleepingHingeRig();
    const hinge = ps.constraintSystem.addConstraint('hinge', anchor, arm, {
        point1: pivot,
        point2: pivot,
        axis: [0, 1, 0],
        normal: [0, 0, 1],
        motor: { type: 'velocity', velocity: 0, maxTorque: 5000 }
    });

    ps.constraintSystem.setHingeTargetAngularVelocity(hinge, 4);
    assert.isTrue(arm.body.IsActive(), 'setHingeTargetAngularVelocity did not wake the arm');

    const angleBefore = hinge.GetCurrentAngle();
    step(20);
    assert.notEqual(
        hinge.GetCurrentAngle(),
        angleBefore,
        'the hinge never actually started spinning at the new velocity'
    );
});

test('setSliderTargetPosition wakes a sleeping slider rig and drives it to the new position', () => {
    const { rail, carriage } = sleepingSliderRig();
    const slider = ps.constraintSystem.addConstraint('slider', rail, carriage, {
        axis: [0, 0, 1],
        min: -5,
        max: 5,
        motor: { type: 'position', target: 0, maxForce: 5000 }
    });

    ps.constraintSystem.setSliderTargetPosition(slider, 3);
    assert.isTrue(carriage.body.IsActive(), 'setSliderTargetPosition did not wake the carriage');

    step(90);
    assert.closeTo(slider.GetCurrentPosition(), 3, 0.25, 'the slider never reached its new target');
});

test('setSliderTargetVelocity wakes a sleeping slider rig and drives it', () => {
    const { rail, carriage } = sleepingSliderRig();
    const slider = ps.constraintSystem.addConstraint('slider', rail, carriage, {
        axis: [0, 0, 1],
        min: -5,
        max: 5,
        motor: { type: 'velocity', velocity: 0, maxForce: 5000 }
    });

    ps.constraintSystem.setSliderTargetVelocity(slider, 2);
    assert.isTrue(carriage.body.IsActive(), 'setSliderTargetVelocity did not wake the carriage');

    const positionBefore = slider.GetCurrentPosition();
    step(20);
    assert.notEqual(
        slider.GetCurrentPosition(),
        positionBefore,
        'the slider never actually started moving at the new velocity'
    );
});

test('setMotorState wakes a sleeping rig', () => {
    const { anchor, arm, pivot } = sleepingHingeRig();
    const hinge = ps.constraintSystem.addConstraint('hinge', anchor, arm, {
        point1: pivot,
        point2: pivot,
        axis: [0, 0, 1],
        normal: [0, 1, 0],
        motor: { type: 'position', target: 0, maxTorque: 5000 }
    });

    ps.bodyInterface.DeactivateBody(arm.BodyID);
    assert.isFalse(arm.body.IsActive(), 'test setup: arm should be asleep again');

    ps.constraintSystem.setMotorState(hinge, 'velocity');
    assert.isTrue(arm.body.IsActive(), 'setMotorState did not wake the arm');
});
