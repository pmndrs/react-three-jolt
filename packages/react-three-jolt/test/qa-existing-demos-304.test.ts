// Issue #304 (existing-demo polish, browser QA round): three bugs the maintainer found by
// actually clicking through the examples, reproduced here against the real WASM module with
// the same numbers the example pages use, so a future regression fails a test instead of just
// looking boring/broken in a browser.
//
// One PhysicsSystem per test (bodies/gravity differ per scenario); each destroys its own world.
import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import type { BodyState } from '../src/systems/body-state';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const dtr = (deg: number) => THREE.MathUtils.degToRad(deg);

beforeAll(async () => {
    await initJolt();
});

function addBox(
    ps: PhysicsSystem,
    size: [number, number, number],
    at: THREE.Vector3,
    options?: Parameters<PhysicsSystem['bodySystem']['addBody']>[1]
) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, options)) as BodyState;
    return { mesh, state };
}

function addSphere(
    ps: PhysicsSystem,
    radius: number,
    at: THREE.Vector3,
    options?: Parameters<PhysicsSystem['bodySystem']['addBody']>[1]
) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, options)) as BodyState;
    return { mesh, state };
}

// FloatingPlatforms.tsx -----------------------------------------------------------------------
// The box pile used to spawn every instance at [0, 24, 0] +/- a tiny jitter, straight above the
// center disc, so the other four platforms never caught anything. The fix spreads the spawns
// across all five platform footprints (same t=0 centers the example's `useFrame` drive starts
// from). This reproduces that spread at the system level: one box dropped per platform's spawn
// zone must come to rest on that platform, not fall past it or roll onto a neighbour.
describe('FloatingPlatforms (#304): spawns land on every platform', () => {
    // t = 0 centers of the five kinematic platforms in FloatingPlatforms.tsx
    const PLATFORMS: { name: string; at: THREE.Vector3; size: [number, number, number] }[] = [
        { name: 'liftA', at: new THREE.Vector3(-16, 10, -4), size: [6, 1, 6] },
        { name: 'liftB', at: new THREE.Vector3(16, 10, 4), size: [6, 1, 6] },
        { name: 'conveyorA', at: new THREE.Vector3(0, 1.5, -16), size: [10, 1, 4] },
        { name: 'conveyorB', at: new THREE.Vector3(0, 1.5, 16), size: [10, 1, 4] },
        { name: 'disc', at: new THREE.Vector3(0, 1.5, 0), size: [12, 1, 12] } // cylinder r=6 -> AABB ~12x12
    ];

    for (const platform of PLATFORMS) {
        test(`a cube dropped above ${platform.name} lands on it`, () => {
            const ps = new PhysicsSystem(`floating-platforms-${platform.name}`);
            try {
                ps.setGravity(22);
                addBox(ps, platform.size, platform.at, { bodyType: 'static' });

                // the spawn zone this platform would get once spawns are spread out: same xz,
                // a few units of jitter, dropped from well above the platform's own height.
                const spawnAt = new THREE.Vector3(
                    platform.at.x,
                    platform.at.y + 14,
                    platform.at.z
                );
                const { state: cube } = addBox(ps, [1, 1, 1], spawnAt, { mass: 15 });

                for (let i = 0; i < 300; i++) ps.onUpdate(STEP);

                assert.closeTo(
                    cube.position.x,
                    platform.at.x,
                    platform.size[0] / 2,
                    `cube dropped above ${platform.name} did not land on it (x)`
                );
                assert.closeTo(
                    cube.position.z,
                    platform.at.z,
                    platform.size[2] / 2,
                    `cube dropped above ${platform.name} did not land on it (z)`
                );
                assert.isAbove(
                    cube.position.y,
                    platform.at.y,
                    `cube dropped above ${platform.name} fell through it`
                );
                cube.destroy();
            } finally {
                ps.destroy();
            }
        });
    }
});

// OneWayPlatform.tsx ----------------------------------------------------------------------
// The platform used to be 14x14 (half extent 7), while the side launchers sit at x = +/-8 with
// a 0.7 radius ball - entirely outside the platform's footprint, so they shot straight up and
// straight back down without ever touching it. Widened to 20x14 (half extent 10 in x) so every
// launcher's column is well inside the platform.
describe('OneWayPlatform (#304): every launcher hits the platform', () => {
    const PLATFORM_Y = 6;
    const PLATFORM_SIZE: [number, number, number] = [20, 0.4, 14]; // matches the fixed example

    for (const x of [-8, 0, 8]) {
        test(`the ball launched at x=${x} lands on the platform`, () => {
            const ps = new PhysicsSystem(`one-way-platform-${x}`);
            try {
                const { state: platform } = addBox(
                    ps,
                    PLATFORM_SIZE,
                    new THREE.Vector3(0, PLATFORM_Y, 0),
                    { bodyType: 'static' }
                );
                platform.onContactValidate((e) => {
                    const other = e.other.body;
                    if (!other) return true;
                    return other.velocity.y <= 0;
                });

                const { state: ball } = addSphere(ps, 0.7, new THREE.Vector3(x, 1, 0));
                ball.velocity = new THREE.Vector3(0, 16, 0);

                // enough steps to pass through, arc over, and settle back onto the platform
                for (let i = 0; i < 240; i++) ps.onUpdate(STEP);

                assert.closeTo(
                    ball.position.x,
                    x,
                    1,
                    `ball launched at x=${x} drifted off its column`
                );
                assert.closeTo(
                    ball.position.y,
                    PLATFORM_Y + 0.2 + 0.7,
                    0.3,
                    `ball launched at x=${x} never came to rest on the platform`
                );
                assert.isBelow(
                    ball.velocity.length(),
                    0.5,
                    `ball launched at x=${x} is still moving - it missed the platform`
                );
                ball.destroy();
            } finally {
                ps.destroy();
            }
        });
    }
});

// motionSources.tsx -------------------------------------------------------------------------
// The orange bounce pad (`angledBouncer`) fires `activateMotionSource(new Vector3(0, 300, 0))`,
// a non-surface-velocity ("impulse") motion source. `BodyState.handleMotionContact` used to run
// unconditionally on both the contact-ADDED and every contact-PERSISTED callback, and queued a
// fresh `addImpulse` pending action every time - but AddImpulse is additive, unlike the
// surface-velocity write the same code path also does (which is a `Set`, not additive, so
// repeating it is correct for a conveyor belt). Because the pending action is applied one
// substep late, a contact that resolves in the normal 2-3 substeps got the same impulse queued
// 2-3 times, roughly doubling (or worse) the bounce - which is exactly "suddenly too strong".
//
// This is not a recent regression: `git log -p` on body-system.ts / body-state.ts shows the
// contact pipeline was rewritten once (dd435cb, "sub-shape contact pipeline with deferred
// dispatch") and the pre-refactor code (`git show dd435cb^`) registered the very same
// `motionAddedListener` for both 'added' and 'persisted' - so the double-fire has been there
// since `activateMotionSource` was written, just never noticed before this demo was clicked
// through. Fixed in body-state.ts (`handleMotionContact` now takes `added` and only queues
// `addImpulse`/`applyTorque` when `added` is true); the surface-velocity branches are untouched.
describe('MotionSources (#304): the bounce pad', () => {
    function makeBouncePad(ps: PhysicsSystem, impulse: number) {
        // angledBouncer: position [-14, 1.5, 2], rotation [dtr(45), 0, 0], size [5, 0.2, 5]
        const padAt = new THREE.Vector3(-14, 1.5, 2);
        const { state: pad } = addBox(ps, [5, 0.2, 5], padAt, { bodyType: 'static' });
        pad.rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(dtr(45), 0, 0));
        pad.activateMotionSource(new THREE.Vector3(0, impulse, 0));
        return pad;
    }

    test('a single touch applies the bounce impulse once, not once per persisted substep', () => {
        const ps = new PhysicsSystem('motion-sources-impulse-count');
        try {
            ps.setGravity(22);
            const pad = makeBouncePad(ps, 300);

            // box mass=15, same as the demo's falling cubes, placed just barely overlapping the
            // pad's (rotated) top face so contact is guaranteed on the very first step.
            const padUp = new THREE.Vector3(0, 1, 0).applyQuaternion(pad.rotation);
            const start = pad.position.clone().addScaledVector(padUp, 0.1 + 0.5 - 0.05);
            const { state: box } = addBox(ps, [1, 1, 1], start, { mass: 15 });

            let peakSpeed = 0;
            for (let i = 0; i < 20; i++) {
                ps.onUpdate(STEP);
                peakSpeed = Math.max(peakSpeed, box.velocity.length());
            }

            // one application of (0, 300, 0) rotated 45deg about x, on a mass-15 body, is a
            // delta-v of ~ (0, 14.14, 14.14) -> speed ~20. Two applications (the bug) is ~40.
            assert.isBelow(
                peakSpeed,
                25,
                `bounce pad applied more than one impulse worth of velocity (got ${peakSpeed.toFixed(2)})`
            );
            assert.isAbove(peakSpeed, 10, 'bounce pad applied no impulse at all');

            box.destroy();
        } finally {
            ps.destroy();
        }
    });

    test("the bounced box's arc passes through the tractor field's bounds", () => {
        const ps = new PhysicsSystem('motion-sources-apex');
        try {
            ps.setGravity(22);
            // Retuned bounce strength - see motionSources.tsx. 300 (the pre-fix value) sailed
            // the box clean over the field even with the double-fire bug gone (single-impulse
            // speed is already ~20 - see the test above); this is what the example now uses.
            const BOUNCE_IMPULSE = 170;
            const pad = makeBouncePad(ps, BOUNCE_IMPULSE);

            // The box does not arrive at the pad at rest - motionSources.tsx carries it there
            // on the left conveyor, whose own activateMotionSource vector (-2.4, 0, 0) - rotated
            // by the conveyor's own [0, 1.57, dtr(-10)] tilt, exactly as
            // `BodyState.handleMotionContact` does for a surface-velocity source - is the
            // incoming velocity used here, rather than re-simulating the whole conveyor chain.
            const leftConveyorRotation = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, 1.57, dtr(-10))
            );
            const incomingVelocity = new THREE.Vector3(-2.4, 0, 0).applyQuaternion(
                leftConveyorRotation
            );

            const padUp = new THREE.Vector3(0, 1, 0).applyQuaternion(pad.rotation);
            const start = pad.position.clone().addScaledVector(padUp, 0.1 + 0.5 - 0.05);
            const { state: box } = addBox(ps, [1, 1, 1], start, { mass: 15 });
            box.velocity = incomingVelocity;

            // forcefield: position [0, 6, 8], rotation [0, dtr(15), dtr(15)], size [40, 4, 4]
            const fieldCenter = new THREE.Vector3(0, 6, 8);
            const fieldRotation = new THREE.Quaternion().setFromEuler(
                new THREE.Euler(0, dtr(15), dtr(15))
            );
            const halfExtents = new THREE.Vector3(20, 2, 2);
            const insideField = (p: THREE.Vector3) => {
                const local = p
                    .clone()
                    .sub(fieldCenter)
                    .applyQuaternion(fieldRotation.clone().invert());
                return (
                    Math.abs(local.x) <= halfExtents.x &&
                    Math.abs(local.y) <= halfExtents.y &&
                    Math.abs(local.z) <= halfExtents.z
                );
            };

            // step until the box separates from the pad (bounces away) and then track its arc,
            // looking for the moment it passes through the field's bounds at all - a fast
            // moving box can cross the field well before its vertical velocity turns over, so
            // this is not restricted to the exact apex.
            let touchedPad = false;
            let enteredField = false;
            let closest = Number.POSITIVE_INFINITY;
            for (let i = 0; i < 300 && !enteredField; i++) {
                ps.onUpdate(STEP);
                if (pad.isContacting(box.handle)) touchedPad = true;
                if (touchedPad && insideField(box.position)) enteredField = true;
                closest = Math.min(closest, box.position.distanceTo(fieldCenter));
            }

            assert.isTrue(touchedPad, 'the box never reached the bounce pad');
            assert.isTrue(
                enteredField,
                `the bounced box's arc never entered the tractor field's bounds (closest approach to its center: ${closest.toFixed(2)})`
            );

            box.destroy();
        } finally {
            ps.destroy();
        }
    });
});
