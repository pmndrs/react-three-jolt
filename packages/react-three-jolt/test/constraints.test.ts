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

const addBody = (position: [number, number, number], type?: 'static'): BodyState => {
    const handle = ps.bodySystem.addBody(box(position), type ? { bodyType: type } : undefined);
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
    'SixDOFConstraintSettings'
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
        // biome-ignore lint/suspicious/noExplicitAny: probing for a binding that does not exist
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
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type map
        expect(() => ps.constraintSystem.addConstraint('nope' as any, a, b)).toThrow(
            /unknown constraint type/
        );
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
