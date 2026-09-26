// Regression test for the redesigned Motors example (issue #299): the maintainer's QA report
// was "one rotates, the others do nothing, and the sliders have no action besides the
// spinner". Root cause was the activation bug fixed in qa-activation-299.test.ts - the demo
// called `HingeConstraint.SetTargetAngle`/`SliderConstraint.SetTargetPosition` directly on the
// constraint `useConstraint` hands back, which never activates a body that fell asleep at its
// previous target.
//
// This file builds the exact three rigs the example now renders - same gravity, same masses,
// same axis/limits, same motor spring/torque settings - and drives them the way
// `apps/examples/src/examples/Motors.tsx` does: through `ConstraintSystem`'s
// `setHingeTargetAngle`/`setHingeTargetAngularVelocity`/`setSliderTargetPosition`, after
// putting the rig to sleep first, so a regression in either the activation fix or the
// example's own motor tuning shows up here instead of only in the browser.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const RIG_Y = 6;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-motors-299');
    ps.setGravity(22); // matches <Physics gravity={22}> in the example
});

const step = (frames: number) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
};

let laneX = 0;

/** hub (static) + arm (mass 1, 5x0.4x0.4), both at the same position - matches the example. */
function hingeRig(): { hub: BodyState; arm: BodyState; pos: THREE.Vector3 } {
    laneX += 20;
    const pos = new THREE.Vector3(laneX, RIG_Y, 0);
    const hubMesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 12));
    hubMesh.position.copy(pos);
    const hub = ps.bodySystem.getBody(ps.bodySystem.addBody(hubMesh, { bodyType: 'static' }))!;
    const armMesh = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 0.4));
    armMesh.position.copy(pos);
    const arm = ps.bodySystem.getBody(ps.bodySystem.addBody(armMesh, { mass: 1 }))!;
    return { hub, arm, pos };
}

/** rail (static) + block (mass 1), both at the same position - matches the example. */
function sliderRig(): { rail: BodyState; block: BodyState; pos: THREE.Vector3 } {
    laneX += 20;
    const pos = new THREE.Vector3(laneX, RIG_Y, 0);
    const railMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7, 0.3));
    railMesh.position.copy(pos);
    const rail = ps.bodySystem.getBody(ps.bodySystem.addBody(railMesh, { bodyType: 'static' }))!;
    const blockMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 1.6));
    blockMesh.position.copy(pos);
    const block = ps.bodySystem.getBody(
        ps.bodySystem.addBody(blockMesh, { mass: 1 /* linearDamping applied below */ })
    )!;
    block.linearDamping = 0.2;
    return { rail, block, pos };
}

test('hinge · velocity rig spins once retargeted after falling asleep', () => {
    const { hub, arm, pos } = hingeRig();
    const hinge = ps.constraintSystem.addConstraint('hinge', hub, arm, {
        point1: pos,
        axis: [0, 0, 1],
        motor: { type: 'velocity', velocity: 0, maxTorque: 4000 }
    });

    ps.bodyInterface.DeactivateBody(arm.BodyID);
    assert.isFalse(arm.body.IsActive(), 'test setup: arm should start asleep');

    ps.constraintSystem.setHingeTargetAngularVelocity(hinge, 6);
    assert.isTrue(arm.body.IsActive(), 'setHingeTargetAngularVelocity did not wake the arm');

    const angleBefore = hinge.GetCurrentAngle();
    step(30);
    assert.notEqual(
        hinge.GetCurrentAngle(),
        angleBefore,
        'the hinge never actually started spinning'
    );
});

test('hinge · position rig reaches its target angle after falling asleep', () => {
    const { hub, arm, pos } = hingeRig();
    const hinge = ps.constraintSystem.addConstraint('hinge', hub, arm, {
        point1: pos,
        axis: [0, 0, 1],
        motor: {
            type: 'position',
            target: 0,
            maxTorque: 4000,
            spring: { strength: 12, damping: 1 }
        }
    });

    step(60); // let it hold its initial (0) target and fall asleep
    ps.bodyInterface.DeactivateBody(arm.BodyID);
    assert.isFalse(arm.body.IsActive(), 'test setup: arm should be asleep before the retarget');

    ps.constraintSystem.setHingeTargetAngle(hinge, -1.5);
    assert.isTrue(arm.body.IsActive(), 'setHingeTargetAngle did not wake the arm');

    step(150);
    assert.closeTo(
        hinge.GetCurrentAngle(),
        -1.5,
        0.3,
        'the hinge never reached its new target angle'
    );
});

test('slider · position rig reaches its target offset after falling asleep', () => {
    const { rail, block, pos } = sliderRig();
    const slider = ps.constraintSystem.addConstraint('slider', rail, block, {
        point1: pos,
        axis: [0, 1, 0],
        min: -3,
        max: 3,
        motor: {
            type: 'position',
            target: 0,
            maxForce: 4000,
            spring: { strength: 12, damping: 1 }
        }
    });

    step(60);
    ps.bodyInterface.DeactivateBody(block.BodyID);
    assert.isFalse(block.body.IsActive(), 'test setup: block should be asleep before the retarget');

    ps.constraintSystem.setSliderTargetPosition(slider, 2.5);
    assert.isTrue(block.body.IsActive(), 'setSliderTargetPosition did not wake the block');

    step(90);
    assert.closeTo(
        slider.GetCurrentPosition(),
        2.5,
        0.3,
        'the slider never reached its new target position'
    );
});
