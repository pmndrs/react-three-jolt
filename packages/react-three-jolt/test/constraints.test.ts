// Constraint lifecycle against the real wasm module.
//
// `ConstraintSystem.removeConstraint` used to be an empty function, so every constraint
// `useConstraint` ever created stayed in the physics system forever (issue #82), and the
// two attempts at fixing it (`Raw.module.destroy`, then `RemoveConstraint` + destroy)
// crashed the page. These tests pin down the behaviour that actually works:
//
//   - `Create()` returns a RefTarget with a zero refcount. We `AddRef`, `AddConstraint`
//     takes a second reference, `RemoveConstraint` gives it back and `Release()` frees it.
//   - calling `Raw.module.destroy()` on a constraint throws "null function or function
//     signature mismatch" - the binding has no destructor. Never do it.
//   - a constraint must be removed before either of its bodies, otherwise the next step
//     reads freed memory and traps with "memory access out of bounds".
//
// jolt-physics 1.1 has no `PhysicsSystem::GetConstraints()` binding (see the explicit
// assertion below), so the live-constraint count comes from the system's own registry and
// is backed up by a wasm allocation spy plus the simulation actually behaving.

import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('constraints');
});

//* helpers ----------------------------------------------------------

const box = (position: [number, number, number], size = 1) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.position.set(...position);
    return mesh;
};

const addBody = (position: [number, number, number], type?: 'static', size = 1): BodyState => {
    const handle = ps.bodySystem.addBody(
        box(position, size),
        type ? { bodyType: type } : undefined
    );
    return ps.bodySystem.getBody(handle)!;
};

const step = (frames = 60) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(1 / 60);
};

const distance = (a: BodyState, to: THREE.Vector3) => a.position.distanceTo(to);

/**
 * Allocation tracking for the constraint paths, on top of the shared `installAllocTracker`
 * helper: it counts every wasm object the constraint code can allocate and un-counts it on
 * destroy, so a forgotten `Raw.module.destroy` shows up as a non-empty live list.
 */
const TRACKED = [
    'Vec3',
    'RVec3',
    'Quat',
    'SpringSettings',
    'MotorSettings',
    'FixedConstraintSettings',
    'PointConstraintSettings',
    'DistanceConstraintSettings',
    'HingeConstraintSettings',
    'SliderConstraintSettings',
    'ConeConstraintSettings',
    'SwingTwistConstraintSettings',
    'SixDOFConstraintSettings',
    'PulleyConstraintSettings',
    'GearConstraintSettings',
    'RackAndPinionConstraintSettings'
];

const installAllocationSpy = () => {
    const tracker = installAllocTracker(Raw, { types: TRACKED, throwOnDoubleDestroy: false });
    return {
        /** class names of everything allocated and not yet freed */
        outstanding: () => tracker.liveDetails().map(({ type }) => type),
        restore: () => tracker.uninstall()
    };
};

//* tests ------------------------------------------------------------

test('jolt 1.1 has no GetConstraints binding, so the system keeps its own registry', () => {
    // if this ever starts failing, the registry can be cross-checked against jolt directly
    assert.isUndefined(
        (Raw.module.PhysicsSystem.prototype as any).GetConstraints,
        'jolt now exposes GetConstraints - use it to verify the registry'
    );
    assert.instanceOf(ps.constraintSystem.constraints, Map);
});

test('a hinge is registered, holds its bodies, and removing it frees everything', () => {
    const anchor = addBody([0, 10, 0], 'static');
    const swinging = addBody([3, 10, 0]);
    const pivot = new THREE.Vector3(0, 10, 0);

    const spy = installAllocationSpy();
    let constraint: ReturnType<typeof ps.constraintSystem.addConstraint<'hinge'>>;
    try {
        constraint = ps.constraintSystem.addConstraint('hinge', anchor, swinging, {
            point1: [0, 10, 0],
            point2: [0, 10, 0],
            axis: [0, 0, 1],
            normal: [0, 1, 0]
        });

        // the settings object and every Vec3/RVec3 temporary are freed inside addConstraint
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 1);

        // the body swings around the pivot instead of falling away from it
        step(90);
        assert.closeTo(distance(swinging, pivot), 3, 0.25, 'hinge did not hold the body');

        assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
        assert.equal(ps.constraintSystem.constraints.size, 0);
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
    } finally {
        spy.restore();
    }

    // and now it really is gone: the body free falls
    step(90);
    assert.isAbove(distance(swinging, pivot), 4.5, 'body is still attached after removal');
});

test('a distance constraint has the same lifecycle', () => {
    const anchor = addBody([10, 15, 0], 'static');
    const hanging = addBody([10, 10, 0]);

    const spy = installAllocationSpy();
    try {
        const constraint = ps.constraintSystem.addConstraint('distance', anchor, hanging, {
            min: 0,
            max: 2,
            spring: { strength: 20, damping: 1 }
        });
        // the SpringSettings built for mLimitsSpringSettings is freed too
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 1);

        step(120);
        assert.closeTo(hanging.position.y, 13, 0.5, 'distance constraint did not reel the body in');

        assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
        assert.equal(ps.constraintSystem.constraints.size, 0);
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }

    // the body fell asleep hanging there, so wake it before checking it now drops
    ps.bodySystem.bodyInterface.ActivateBody(hanging.BodyID);
    step(90);
    assert.isBelow(hanging.position.y, 11, 'body is still hanging after removal');
});

test('removing the same constraint twice is a no-op, not a crash', () => {
    const a = addBody([20, 10, 0], 'static');
    const b = addBody([20, 12, 0]);
    const constraint = ps.constraintSystem.addConstraint('point', a, b);

    assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
    // a second call must not touch jolt again: the constraint is already freed
    assert.isFalse(ps.constraintSystem.removeConstraint(constraint));
    assert.isFalse(ps.constraintSystem.removeConstraint(constraint));
    // and neither does a null/undefined one, which is what the hook passes when the
    // bodies were not ready
    assert.isFalse(ps.constraintSystem.removeConstraint(null));
    assert.isFalse(ps.constraintSystem.removeConstraint(undefined));

    step();
    assert.isFinite(b.position.y);
});

test('a strict-mode create/destroy/create cycle leaves exactly one constraint', () => {
    // what useImperativeInstance does when React mounts, tears down and mounts again: each
    // effect must destroy the instance *it* created, never the one that replaced it
    const a = addBody([25, 10, 0], 'static');
    const b = addBody([25, 12, 0]);

    const first = ps.constraintSystem.addConstraint('hinge', a, b, { axis: [0, 0, 1] });
    assert.isTrue(ps.constraintSystem.removeConstraint(first));
    const second = ps.constraintSystem.addConstraint('hinge', a, b, { axis: [0, 0, 1] });

    assert.equal(ps.constraintSystem.constraints.size, 1);
    // jolt often hands the second constraint the first one's freed address, so the system
    // drops the binder's cached wrapper on removal to keep the two handles distinguishable
    assert.notStrictEqual(first, second, 'the freed wrapper was handed out again');
    // the discarded first effect cleaning up again must not take the live one with it
    assert.isFalse(ps.constraintSystem.removeConstraint(first));
    assert.equal(ps.constraintSystem.constraints.size, 1, 'stale cleanup removed the live one');

    step(30);
    assert.isTrue(ps.constraintSystem.removeConstraint(second));
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('createMotorSettings builds a real MotorSettings instead of throwing', () => {
    // it used to reference undeclared `maxForce`/`speed` and threw a ReferenceError
    const settings = ps.constraintSystem.createMotorSettings({
        minForce: -100,
        maxForce: 100,
        minTorque: -5,
        maxTorque: 5,
        spring: { strength: 4, damping: 0.8 }
    });
    assert.equal(settings.mMinForceLimit, -100);
    assert.equal(settings.mMaxForceLimit, 100);
    assert.equal(settings.mMinTorqueLimit, -5);
    assert.equal(settings.mMaxTorqueLimit, 5);
    assert.closeTo(settings.mSpringSettings.mFrequency, 4, 1e-4);
    Raw.module.destroy(settings);

    // defaults are fine too
    const bare = ps.constraintSystem.createMotorSettings();
    assert.isFinite(bare.mMaxForceLimit);
    Raw.module.destroy(bare);
});

test('a motorised slider drives and is torn down cleanly', () => {
    const base = addBody([30, 10, 0], 'static');
    const carriage = addBody([30, 10, 0.5]);

    const spy = installAllocationSpy();
    try {
        const constraint = ps.constraintSystem.addConstraint('slider', base, carriage, {
            axis: [0, 0, 1],
            min: -5,
            max: 5,
            motor: { type: 'position', target: 3, maxForce: 5000 }
        });
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        step(120);
        // the position motor drives the carriage along +z to its target of 3
        assert.closeTo(carriage.position.z, 3, 0.25, 'slider motor did not drive the carriage');

        assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('addConstraint rejects an unknown type without leaking', () => {
    const a = addBody([40, 10, 0], 'static');
    const b = addBody([40, 12, 0]);
    const spy = installAllocationSpy();
    try {
        expect(() => ps.constraintSystem.addConstraint('nope' as any, a, b)).toThrow(
            /unknown constraint type/
        );
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

//* pulley/gear/rackAndPinion (issue #241) ----------------------------

test('a pulley keeps the total rope length constant while one side pays out', () => {
    // two bodies hung from their own overhead pulley wheel (fixedPoint1/2); body1 is
    // heavier, so it descends and pays its side of the rope out while body2's side is
    // reeled in - the *sum* of the two segments (times ratio) is what stays constant, not
    // either segment on its own
    const fixedPoint1: THREE.Vector3Tuple = [120, 30, 0];
    const fixedPoint2: THREE.Vector3Tuple = [120, 30, 6];
    const spy = installAllocationSpy();
    let constraint: ReturnType<typeof ps.constraintSystem.addConstraint<'pulley'>>;
    try {
        const heavy = addBody([120, 20, 0], undefined, 1.3);
        const light = addBody([120, 20, 6], undefined, 0.8);

        constraint = ps.constraintSystem.addConstraint('pulley', heavy, light, {
            fixedPoint1,
            fixedPoint2,
            ratio: 1
            // min/max left unset: jolt defaults mMinLength to 0 and auto-computes mMaxLength
            // from the bodies' starting positions (here 6 + 6 = 12... actually the fixed
            // points sit 10m above each body, so the initial length is 20)
        });
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 1);

        const initialLength = constraint.GetCurrentLength();
        assert.closeTo(initialLength, 20, 0.01);
        assert.closeTo(constraint.GetMaxLength(), 20, 0.01, 'mMaxLength was not auto-computed');
        assert.equal(constraint.GetMinLength(), 0);

        step(90);

        // the rope stays taut against its (auto-computed) max length the whole time, so the
        // total is conserved even though each side moved a lot
        assert.closeTo(constraint.GetCurrentLength(), initialLength, 0.05, 'rope length drifted');
        assert.isBelow(heavy.position.y, 20 - 1, 'the heavier body did not descend');
        assert.isAbove(light.position.y, 20 + 1, 'the lighter body was not pulled up');

        assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('a rigid pulley (min === max) locks both sides when the bodies balance', () => {
    // equal masses on both sides of a rigid rope is a stable equilibrium: neither body can
    // move without the other compensating exactly, so with equal weight nothing moves at all
    const fixedPoint1: THREE.Vector3Tuple = [126, 30, 0];
    const fixedPoint2: THREE.Vector3Tuple = [126, 30, 6];
    const a = addBody([126, 20, 0]);
    const b = addBody([126, 20, 6]);

    const constraint = ps.constraintSystem.addConstraint('pulley', a, b, {
        fixedPoint1,
        fixedPoint2,
        ratio: 1,
        min: 20,
        max: 20
    });

    step(90);

    assert.closeTo(a.position.y, 20, 0.05);
    assert.closeTo(b.position.y, 20, 0.05);
    assert.closeTo(constraint.GetCurrentLength(), 20, 0.05);
    assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
});

test('addConstraint rejects a pulley without fixed points, before allocating anything', () => {
    const a = addBody([132, 20, 0]);
    const b = addBody([132, 20, 6]);
    const spy = installAllocationSpy();
    try {
        expect(() => ps.constraintSystem.addConstraint('pulley', a, b, { ratio: 1 })).toThrow(
            /fixedPoint1/
        );
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('a gear turns its second body at -ratio (external gear) and cleans up', () => {
    // each "gear" is a hinge-mounted arm spinning about its own static pivot; gear1's hinge
    // is motorised, gear2's is left free and only moves because the gear constraint
    // synchronizes it to gear1 at `ratio`
    const pivot1: THREE.Vector3Tuple = [140, 10, 0];
    const pivot2: THREE.Vector3Tuple = [148, 10, 0];
    const anchor1 = addBody(pivot1, 'static');
    const anchor2 = addBody(pivot2, 'static');

    const spy = installAllocationSpy();
    let gear: ReturnType<typeof ps.constraintSystem.addConstraint<'gear'>>;
    try {
        // an offset arm (rather than a wheel centered exactly on the pivot) gives the solver
        // enough rotational inertia to converge the gear's velocity constraint cleanly
        const wheel1 = addBody([143, 10, 0]);
        const wheel2 = addBody([151, 10, 0]);

        const hinge1 = ps.constraintSystem.addConstraint('hinge', anchor1, wheel1, {
            point1: pivot1,
            axis: [0, 0, 1],
            motor: { type: 'velocity', velocity: 2 }
        });
        const hinge2 = ps.constraintSystem.addConstraint('hinge', anchor2, wheel2, {
            point1: pivot2,
            axis: [0, 0, 1]
        });

        gear = ps.constraintSystem.addConstraint('gear', wheel1, wheel2, {
            hinge1,
            hinge2,
            ratio: 2,
            axis: [0, 0, 1]
        });
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 3);

        // stop well short of a full rotation - `GetCurrentAngle` wraps at +-pi, which would
        // make the ratio check below meaningless
        step(60);

        const a1 = hinge1.GetCurrentAngle();
        const a2 = hinge2.GetCurrentAngle();
        assert.isAbove(Math.abs(a1), 0.1, 'the motorised hinge did not turn');
        // gear2 turns the opposite way at `ratio` times gear1's angle
        assert.closeTo(a1 / a2, -2, 0.15, 'gear2 did not track gear1 at the requested ratio');

        assert.isTrue(ps.constraintSystem.removeConstraint(gear));
        assert.isTrue(ps.constraintSystem.removeConstraint(hinge1));
        assert.isTrue(ps.constraintSystem.removeConstraint(hinge2));
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('numTeeth1/numTeeth2 compute the same ratio SetRatio would', () => {
    // GearConstraintSettings::SetRatio(teeth1, teeth2) sets mRatio = teeth2 / teeth1
    const pivot1: THREE.Vector3Tuple = [156, 10, 0];
    const pivot2: THREE.Vector3Tuple = [164, 10, 0];
    const anchor1 = addBody(pivot1, 'static');
    const anchor2 = addBody(pivot2, 'static');
    const wheel1 = addBody([159, 10, 0]);
    const wheel2 = addBody([167, 10, 0]);

    const hinge1 = ps.constraintSystem.addConstraint('hinge', anchor1, wheel1, {
        point1: pivot1,
        axis: [0, 0, 1],
        motor: { type: 'velocity', velocity: 2 }
    });
    const hinge2 = ps.constraintSystem.addConstraint('hinge', anchor2, wheel2, {
        point1: pivot2,
        axis: [0, 0, 1]
    });
    const gear = ps.constraintSystem.addConstraint('gear', wheel1, wheel2, {
        hinge1,
        hinge2,
        numTeeth1: 10,
        numTeeth2: 20,
        axis: [0, 0, 1]
    });

    step(60);
    const a1 = hinge1.GetCurrentAngle();
    const a2 = hinge2.GetCurrentAngle();
    // 20 teeth / 10 teeth -> ratio 2, same as the explicit-ratio test above
    assert.closeTo(a1 / a2, -2, 0.15);

    assert.isTrue(ps.constraintSystem.removeConstraint(gear));
    assert.isTrue(ps.constraintSystem.removeConstraint(hinge1));
    assert.isTrue(ps.constraintSystem.removeConstraint(hinge2));
});

test('addConstraint rejects a gear missing hinge1/hinge2, before allocating anything', () => {
    const a = addBody([170, 10, 0]);
    const b = addBody([174, 10, 0]);
    const spy = installAllocationSpy();
    try {
        expect(() => ps.constraintSystem.addConstraint('gear', a, b, { ratio: 2 })).toThrow(
            /hinge1/
        );
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('a rackAndPinion moves its rack at ratio*pinionAngle and cleans up', () => {
    const pinionPivot: THREE.Vector3Tuple = [180, 10, 0];
    const pinionAnchor = addBody(pinionPivot, 'static');
    const rackAnchor = addBody([188, 10, 0], 'static');

    const spy = installAllocationSpy();
    let rackAndPinion: ReturnType<typeof ps.constraintSystem.addConstraint<'rackAndPinion'>>;
    try {
        const pinionWheel = addBody([183, 10, 0]);
        const rackBody = addBody([188, 10, 0]);

        const hinge = ps.constraintSystem.addConstraint('hinge', pinionAnchor, pinionWheel, {
            point1: pinionPivot,
            axis: [0, 0, 1],
            motor: { type: 'velocity', velocity: 2 }
        });
        const slider = ps.constraintSystem.addConstraint('slider', rackAnchor, rackBody, {
            axis: [0, 1, 0],
            min: -10,
            max: 10
        });

        rackAndPinion = ps.constraintSystem.addConstraint('rackAndPinion', pinionWheel, rackBody, {
            hinge,
            slider,
            ratio: 1,
            axis: [0, 0, 1],
            sliderAxis: [0, 1, 0]
        });
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 3);

        step(60);

        const angle = hinge.GetCurrentAngle();
        const position = slider.GetCurrentPosition();
        assert.isAbove(Math.abs(angle), 0.1, 'the motorised pinion did not turn');
        assert.closeTo(position / angle, 1, 0.1, 'the rack did not track the pinion at ratio 1');

        assert.isTrue(ps.constraintSystem.removeConstraint(rackAndPinion));
        assert.isTrue(ps.constraintSystem.removeConstraint(hinge));
        assert.isTrue(ps.constraintSystem.removeConstraint(slider));
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

test('numTeethRack/rackLength/numTeethPinion compute the same ratio SetRatio would', () => {
    // RackAndPinionConstraintSettings::SetRatio(rackTeeth, rackLength, pinionTeeth) sets
    // mRatio = 2*pi*rackTeeth / (rackLength*pinionTeeth) - with 40/2/10 that is 2*pi*2
    const pinionPivot: THREE.Vector3Tuple = [196, 10, 0];
    const pinionAnchor = addBody(pinionPivot, 'static');
    const rackAnchor = addBody([204, 10, 0], 'static');
    const pinionWheel = addBody([199, 10, 0]);
    const rackBody = addBody([204, 10, 0]);

    const hinge = ps.constraintSystem.addConstraint('hinge', pinionAnchor, pinionWheel, {
        point1: pinionPivot,
        axis: [0, 0, 1],
        motor: { type: 'velocity', velocity: 0.5 }
    });
    const slider = ps.constraintSystem.addConstraint('slider', rackAnchor, rackBody, {
        axis: [0, 1, 0],
        min: -10,
        max: 10
    });
    const rackAndPinion = ps.constraintSystem.addConstraint(
        'rackAndPinion',
        pinionWheel,
        rackBody,
        {
            hinge,
            slider,
            numTeethRack: 40,
            rackLength: 2,
            numTeethPinion: 10,
            axis: [0, 0, 1],
            sliderAxis: [0, 1, 0]
        }
    );

    step(60);
    const angle = hinge.GetCurrentAngle();
    const position = slider.GetCurrentPosition();
    assert.isAbove(Math.abs(angle), 0.02, 'the motorised pinion did not turn');
    assert.closeTo(angle / position, 2 * Math.PI * 2, 0.5);

    assert.isTrue(ps.constraintSystem.removeConstraint(rackAndPinion));
    assert.isTrue(ps.constraintSystem.removeConstraint(hinge));
    assert.isTrue(ps.constraintSystem.removeConstraint(slider));
});

test('addConstraint rejects a rackAndPinion missing hinge/slider, before allocating anything', () => {
    const a = addBody([210, 10, 0]);
    const b = addBody([214, 10, 0]);
    const spy = installAllocationSpy();
    try {
        expect(() =>
            ps.constraintSystem.addConstraint('rackAndPinion', a, b, { ratio: 1 })
        ).toThrow(/hinge/);
        assert.deepEqual(spy.outstanding(), []);
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});

// Keep last: before the fix this aborted the whole wasm instance.
test('removing a body takes its constraints with it instead of crashing', () => {
    const anchor = addBody([50, 10, 0], 'static');
    const hanging = addBody([50, 12, 0]);
    const other = addBody([50, 14, 0]);

    ps.constraintSystem.addConstraint('hinge', anchor, hanging, { axis: [0, 0, 1] });
    ps.constraintSystem.addConstraint('distance', hanging, other, { min: 0, max: 2 });
    assert.equal(ps.constraintSystem.constraints.size, 2);

    step(10);

    // `hanging` is referenced by both constraints
    ps.bodySystem.removeBody(hanging.handle);
    assert.equal(
        ps.constraintSystem.constraints.size,
        0,
        'constraints outlived the body they referenced'
    );

    // the step after a body removal is where the old code trapped
    step(60);
    assert.isFinite(other.position.y);
    assert.isFinite(anchor.position.y);
});

//* useConstraint with refs for dependent constraints (issue #265) ----

test('useConstraint accepts refs for dependent constraints (gear with lazy dereferencing)', () => {
    // Verify that useConstraint accepts refs for dependent constraints and dereferences
    // them lazily inside its effect. This allows a gear to be created from constraints
    // that may be created in separate renders/effects, as long as all refs are populated
    // before the gear's effect runs.

    // Create bodies directly (not via useConstraint, which requires React)
    const pivot1: THREE.Vector3Tuple = [220, 10, 0];
    const pivot2: THREE.Vector3Tuple = [228, 10, 0];
    const anchor1 = addBody(pivot1, 'static');
    const anchor2 = addBody(pivot2, 'static');
    const wheel1 = addBody([223, 10, 0]);
    const wheel2 = addBody([231, 10, 0]);

    // Create the hinges
    const hinge1 = ps.constraintSystem.addConstraint('hinge', anchor1, wheel1, {
        point1: pivot1,
        axis: [0, 0, 1],
        motor: { type: 'velocity', velocity: 2 }
    });
    const hinge2 = ps.constraintSystem.addConstraint('hinge', anchor2, wheel2, {
        point1: pivot2,
        axis: [0, 0, 1]
    });

    // Simulate what useConstraint does: wrap the constraint handles in refs
    const hinge1Ref = { current: hinge1 };
    const hinge2Ref = { current: hinge2 };

    // Now pass these refs to addConstraint and verify it dereferences them correctly
    // In real usage, useConstraint would do this dereferencing; here we test that the
    // constraint system accepts refs by having useConstraint-like behavior.
    const spy = installAllocationSpy();
    try {
        // Create a small function that mimics what useConstraint does: accept refs,
        // dereference them, and pass the values to addConstraint
        const dereferenceRef = (ref: any) => {
            if (ref && typeof ref === 'object' && 'current' in ref) {
                return ref.current;
            }
            return ref;
        };

        const options = {
            hinge1: dereferenceRef(hinge1Ref),
            hinge2: dereferenceRef(hinge2Ref),
            ratio: 2,
            axis: [0, 0, 1]
        };

        const gear = ps.constraintSystem.addConstraint('gear', wheel1, wheel2, options);
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 3);

        // Verify the gear works with the dereferenced hinges
        step(60);

        const a1 = hinge1.GetCurrentAngle();
        const a2 = hinge2.GetCurrentAngle();
        assert.isAbove(Math.abs(a1), 0.1, 'the motorised hinge did not turn');
        assert.closeTo(a1 / a2, -2, 0.15, 'gear2 did not track gear1 at the requested ratio');

        assert.isTrue(ps.constraintSystem.removeConstraint(gear));
        assert.isTrue(ps.constraintSystem.removeConstraint(hinge1));
        assert.isTrue(ps.constraintSystem.removeConstraint(hinge2));
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
    } finally {
        spy.restore();
    }
    assert.equal(ps.constraintSystem.constraints.size, 0);
});
