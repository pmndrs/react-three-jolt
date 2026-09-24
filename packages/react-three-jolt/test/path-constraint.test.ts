// Path constraint (#242) against the real wasm module.
//
// jolt-physics 1.1.0's WASM binder has no JS constructor for `PathConstraintPathHermite` (see
// `createCurvePath`'s docstring in `constraint-system.ts` for how that was verified), so
// `path` constraints are built on the constructible `PathConstraintPathJS` escape hatch
// instead, sampling the caller's three.js curve directly. These tests pin down the parts that
// are easy to get backwards: the JS callbacks actually get called by the solver, the body
// really does stay pinned to the curve, the motor drives `GetPathFraction()` in the arc-length
// units `createCurvePath` documents, and the constraint's lifecycle matches every other
// constraint type (no leaks, safe double-removal, body freed on `removeConstraint`).

import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('path-constraint');
});

//* helpers ------------------------------------------------------------

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

// a flat, closed loop in the XZ plane - radius 5, centred on the origin
const RADIUS = 5;
const circle = new THREE.CatmullRomCurve3(
    [
        new THREE.Vector3(RADIUS, 0, 0),
        new THREE.Vector3(0, 0, RADIUS),
        new THREE.Vector3(-RADIUS, 0, 0),
        new THREE.Vector3(0, 0, -RADIUS)
    ],
    true,
    'catmullrom',
    0.5
);
const CIRCLE_LENGTH = circle.getLength();

const TRACKED = ['Vec3', 'RVec3', 'Quat', 'MotorSettings', 'PathConstraintSettings'];

const installAllocationSpy = () => {
    const tracker = installAllocTracker(Raw, { types: TRACKED, throwOnDoubleDestroy: false });
    return {
        outstanding: () => tracker.liveDetails().map(({ type }) => type),
        restore: () => tracker.uninstall()
    };
};

//* tests ----------------------------------------------------------------

test('a body constrained to a circle stays within tolerance of it, and cleans up on removal', () => {
    const rail = addBody([0, 0, 0], 'static');
    const cart = addBody([RADIUS, 0, 0]);

    const spy = installAllocationSpy();
    let constraint: ReturnType<typeof ps.constraintSystem.addConstraint<'path'>>;
    try {
        constraint = ps.constraintSystem.addConstraint('path', rail, cart, {
            path: circle,
            closed: true
        });

        // the settings object and every Vec3/Quat temporary are freed inside addConstraint -
        // the `PathConstraintPathJS` itself is a RefTarget the constraint now owns, and is
        // deliberately not on this list (see createCurvePath's ownership note).
        assert.deepEqual(spy.outstanding(), [], 'addConstraint leaked wasm objects');
        assert.equal(ps.constraintSystem.constraints.size, 1);

        step(120);

        const distFromCenter = Math.hypot(cart.position.x, cart.position.z);
        expect(Math.abs(distFromCenter - RADIUS)).toBeLessThan(0.75);
        // the path's normal/binormal at a flat circle pin the perpendicular-to-track axes
        // (radial + vertical), so gravity should not have pulled the cart off the track's plane
        expect(Math.abs(cart.position.y)).toBeLessThan(0.75);

        assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
        assert.equal(ps.constraintSystem.constraints.size, 0);
        assert.deepEqual(spy.outstanding(), [], 'removeConstraint leaked wasm objects');
        // idempotent, like every other constraint type
        assert.isFalse(ps.constraintSystem.removeConstraint(constraint));
    } finally {
        spy.restore();
    }

    // and now it really is gone: gravity takes over. 2s of being fully pinned settled the
    // cart's velocity to ~0, which puts a body to sleep - `SetLinearVelocity` on a sleeping
    // body does not itself wake it (verified empirically), so wake it explicitly with
    // `ActivateBody` first. Otherwise this would incidentally test the sleep heuristic instead
    // of the constraint actually being gone.
    ps.bodySystem.bodyInterface.ActivateBody(cart.BodyID);
    const yBefore = cart.position.y;
    step(60);
    expect(cart.position.y).toBeLessThan(yBefore - 0.5);
});

test('a velocity motor advances GetPathFraction() in arc-length units', () => {
    const rail = addBody([10, 0, 0], 'static');
    const cart = addBody([10 + RADIUS, 0, 0]);

    const constraint = ps.constraintSystem.addConstraint('path', rail, cart, {
        path: circle,
        closed: true,
        motor: { type: 'velocity', velocity: 2 }
    });

    // native `Jolt.PathConstraint` API, exposed directly on the returned handle like every
    // other constraint type's casted wrapper
    expect(typeof constraint.GetPathFraction).toBe('function');
    expect(constraint.GetPathFraction()).toBe(0);

    step(120); // 2 seconds at 60Hz

    // fraction is arc-length in world units, so 2 seconds at 2 units/s ~= 4
    expect(constraint.GetPathFraction()).toBeGreaterThan(3);
    expect(constraint.GetPathFraction()).toBeLessThan(CIRCLE_LENGTH);

    ps.constraintSystem.removeConstraint(constraint);
});

test('SetTargetPathFraction drives a position-mode motor toward a target', () => {
    const rail = addBody([-20, 0, 0], 'static');
    const cart = addBody([-20 + RADIUS, 0, 0]);

    const constraint = ps.constraintSystem.addConstraint('path', rail, cart, {
        path: circle,
        closed: true,
        motor: { type: 'position' }
    });

    const target = CIRCLE_LENGTH / 2;
    constraint.SetTargetPathFraction(target);
    step(180);

    expect(constraint.GetPathFraction()).toBeCloseTo(target, 0);

    ps.constraintSystem.removeConstraint(constraint);
});

test('an array of points is upgraded to a CatmullRomCurve3', () => {
    const rail = addBody([40, 0, 0], 'static');
    const cart = addBody([40 + RADIUS, 0, 0]);

    const points: [number, number, number][] = [
        [40 + RADIUS, 0, 0],
        [40, 0, RADIUS],
        [40 - RADIUS, 0, 0],
        [40, 0, -RADIUS]
    ];

    const constraint = ps.constraintSystem.addConstraint('path', rail, cart, {
        // path points are world-space here (matches `pathPosition` defaulting to (0,0,0)), so
        // they carry the same +40 offset as the bodies
        path: points,
        closed: true,
        pathPosition: [-40, 0, 0]
    });

    step(120);
    const distFromCenter = Math.hypot(cart.position.x - 40, cart.position.z);
    expect(Math.abs(distFromCenter - RADIUS)).toBeLessThan(0.75);

    ps.constraintSystem.removeConstraint(constraint);
});
