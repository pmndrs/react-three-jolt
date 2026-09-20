// Covers the <Physics> prop surface (#39) and the frame loop / interpolation behaviour behind
// it. Split in two halves:
//   - direct PhysicsSystem tests, which drive `onUpdate` by hand against the real WASM module
//     so the interpolation maths and the substep clamp can be asserted exactly;
//   - @react-three/test-renderer tests, which prove each prop actually reaches the system and
//     stays reactive.
// The React trees are built with createElement so this file can stay a plain `.ts`.
//
// As in jolt-runtime.test.ts there is ONE direct PhysicsSystem for the whole file: they all
// share the Jolt module, and each world costs about 20MB of the fixed 128MB wasm heap.
// The React tests each unmount so they hand their world back.

import { create } from '@react-three/test-renderer';
import { createElement as h } from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('physics-props');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -200, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

// Reset the knobs so each test starts from the documented defaults, and drain the accumulator
// so `alpha` is a known 0 at the start of a test.
function reset() {
    ps.paused = false;
    ps.interpolate = true;
    ps.timeStep = STEP;
    ps.maxSubSteps = 5;
    ps.resetAccumulator();
}

// A fresh falling box, high enough above the floor that it never lands during a test.
let spawnX = 0;
function spawnBox() {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    spawnX += 5;
    mesh.position.set(spawnX, 100, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))! as BodyState;
    return { mesh, state };
}

// GetGravity returns a pointer to a static temporary owned by the binder: read the components
// straight away, never hold the pointer, never destroy it.
function gravityOf(system: PhysicsSystem) {
    const g = system.physicsSystem.GetGravity();
    return { x: g.GetX(), y: g.GetY(), z: g.GetZ() };
}

test('interpolate: a half step frame lands strictly between the last two physics poses', () => {
    reset();
    const { mesh, state } = spawnBox();

    // a few whole steps so the pose cache holds two real poses and the accumulator is empty
    for (let i = 0; i < 6; i++) ps.onUpdate(STEP);
    assert.isTrue(state.poseCacheValid, 'pose cache was never filled');

    const prevY = state.previousPosition.y;
    const currY = state.currentPosition.y;
    assert.isBelow(currY, prevY, 'box should be falling between steps');

    // alpha 0 -- the frame sits exactly on the older of the two poses
    assert.closeTo(mesh.position.y, prevY, 1e-6, 'alpha 0 should render the previous pose');

    // half a step of render time, not enough to run a physics step: alpha becomes 0.5
    ps.onUpdate(STEP / 2);
    assert.closeTo(ps.accumulator, STEP / 2, 1e-9, 'a half step should not have stepped physics');

    assert.isBelow(mesh.position.y, prevY, 'interpolated pose is not past the previous step');
    assert.isAbove(mesh.position.y, currY, 'interpolated pose is not before the current step');
    assert.closeTo(mesh.position.y, (prevY + currY) / 2, 1e-6, 'alpha 0.5 is not the midpoint');

    // the body itself must not have moved -- interpolation is presentation only
    assert.closeTo(state.position.y, currY, 1e-6, 'interpolation moved the physics body');
});

test('interpolate=false: every frame renders the latest physics pose', () => {
    reset();
    ps.interpolate = false;
    const { mesh, state } = spawnBox();

    for (let i = 0; i < 6; i++) ps.onUpdate(STEP);
    const settled = state.position.y;
    assert.closeTo(mesh.position.y, settled, 1e-6, 'pose should equal the last step pose');

    // a partial frame must not move the object at all, because no step ran
    ps.onUpdate(STEP / 2);
    assert.closeTo(mesh.position.y, settled, 1e-6, 'partial frame moved a non-interpolated body');
    assert.closeTo(mesh.position.y, state.position.y, 1e-6);

    // turning interpolation back on must not lerp across the stale poses left behind
    ps.interpolate = true;
    assert.isFalse(state.poseCacheValid, 'stale pose cache survived re-enabling interpolation');
    ps.onUpdate(STEP / 2);
    assert.closeTo(mesh.position.y, state.position.y, 1e-6, 'lerped across a stale pose');
});

test('the fixed step accumulator is clamped to maxSubSteps', () => {
    reset();
    let steps = 0;
    const counter = () => {
        steps++;
    };
    ps.addPostStepListener(counter);

    // a one second frame is 60 steps' worth of time; without the clamp this both runs 60 steps
    // and (once frames are slower than steps) grows a backlog it can never drain
    ps.onUpdate(1);
    assert.equal(steps, 5, 'ran more substeps than maxSubSteps');
    assert.isAtMost(
        ps.accumulator,
        ps.maxSubSteps * STEP,
        'accumulator grew past the maxSubSteps budget'
    );
    assert.isBelow(ps.accumulator, STEP, 'accumulator should have drained');

    // and the backlog does not survive into the next frame
    ps.onUpdate(1);
    assert.equal(steps, 10);
    assert.isBelow(ps.accumulator, STEP);
    ps.removeStepListener(counter);
});

test('a negative or NaN frame delta does not stall the simulation', () => {
    reset();
    let steps = 0;
    const counter = () => {
        steps++;
    };
    ps.addPostStepListener(counter);

    // r3f's scheduler hands out a negative delta on the frame after a clock reset; left in the
    // accumulator it would swallow the next several frames of simulation time
    ps.onUpdate(-0.5);
    ps.onUpdate(Number.NaN);
    assert.isBelow(ps.accumulator, STEP, 'a bad delta was added to the accumulator');
    assert.isAtLeast(ps.accumulator, 0, 'the accumulator went negative');

    for (let i = 0; i < 3; i++) ps.onUpdate(STEP);
    ps.removeStepListener(counter);
    assert.equal(steps, 3, 'simulation stalled after a bad delta');
});

test('setGravity applies the value and frees its Jolt vector', () => {
    reset();
    // Warm the shared `joltScratch.vec3()` singleton: it is allocated lazily on first use and
    // then kept forever by design, so it would otherwise show up as one "live" allocation here.
    ps.setGravity([0, -9.81, 0]);
    const spy = allocationSpy();

    ps.setGravity([0, -3, 0]);
    assert.closeTo(gravityOf(ps).y, -3, 1e-6);

    // a number is a downward magnitude
    ps.setGravity(20);
    assert.closeTo(gravityOf(ps).y, -20, 1e-6);

    ps.setGravity(new THREE.Vector3(1, -2, 3));
    const g = gravityOf(ps);
    assert.closeTo(g.x, 1, 1e-6);
    assert.closeTo(g.z, 3, 1e-6);

    for (let i = 0; i < 100; i++) ps.setGravity([0, -9.81, 0]);

    const { created, live } = spy.stop();
    // `setGravity` writes into the shared scratch vector, which `SetGravity` copies: after the
    // warm-up above it must not allocate at all, and must certainly not leak one per call.
    assert.equal(created, 0, `setGravity allocated ${created} Jolt objects`);
    assert.equal(live, 0, 'setGravity leaked a Jolt vector per call');
    ps.setGravity([0, -9.81, 0]);
});

test('teleporting a body does not interpolate across the jump', () => {
    reset();
    const { mesh, state } = spawnBox();

    // two whole steps so the pose cache holds a real previous/current pair
    for (let i = 0; i < 6; i++) ps.onUpdate(STEP);
    assert.isTrue(state.poseCacheValid, 'pose cache was never filled');
    const fellTo = state.position.y;

    // a teleport: the body jumps somewhere the simulation never carried it
    state.position = new THREE.Vector3(state.position.x, fellTo + 50, 0);
    assert.isFalse(state.poseCacheValid, 'the position setter left a stale pose cache behind');

    // the next partial frame must render the body where it now is, not halfway back to where
    // it used to be
    ps.onUpdate(STEP / 2);
    assert.closeTo(mesh.position.y, state.position.y, 1e-6, 'lerped across a teleport');
    assert.isAbove(mesh.position.y, fellTo + 40, 'the render pose was dragged back to the jump');

    // same for rotation and for the combined setter
    for (let i = 0; i < 6; i++) ps.onUpdate(STEP);
    assert.isTrue(state.poseCacheValid);
    state.rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
    assert.isFalse(state.poseCacheValid, 'the rotation setter left a stale pose cache behind');

    for (let i = 0; i < 6; i++) ps.onUpdate(STEP);
    assert.isTrue(state.poseCacheValid);
    state.setPositionAndRotation(
        new THREE.Vector3(state.position.x, fellTo + 80, 0),
        new THREE.Quaternion()
    );
    assert.isFalse(state.poseCacheValid, 'setPositionAndRotation left a stale pose cache behind');
    ps.onUpdate(STEP / 2);
    assert.closeTo(mesh.position.y, state.position.y, 1e-6, 'lerped across a teleport');
});

test('the frame loop does not allocate Jolt objects', () => {
    reset();
    spawnBox();
    // warm up outside the spy: body creation legitimately allocates
    for (let i = 0; i < 10; i++) ps.onUpdate(STEP);

    const spy = allocationSpy();
    for (let i = 0; i < 200; i++) ps.onUpdate(STEP);
    const { created, live } = spy.stop();

    assert.equal(created, 0, `frame loop allocated ${created} Jolt objects over 200 frames`);
    assert.equal(live, 0, 'frame loop grew the live Jolt object count');
});

// --- react component props -------------------------------------------------------------------

// Grabs the PhysicsSystem the <Physics> component built so the assertions can look at it.
function probe(box: { ps?: PhysicsSystem }) {
    return h(function Probe() {
        box.ps = useJolt().physicsSystem;
        return null;
    });
}

// A <Physics> tree with one falling box and a probe.
function tree(box: { ps?: PhysicsSystem }, props: Record<string, unknown>) {
    return h(
        Physics,
        props,
        probe(box),
        h(RigidBody, { position: [0, 5, 0] }, h('mesh', null, h('boxGeometry', null)))
    );
}

test('<Physics> passes every simulation prop through to PhysicsSystem', async () => {
    const box: { ps?: PhysicsSystem } = {};
    const renderer = await create(
        tree(box, {
            gravity: [0, -4, 0],
            interpolate: false,
            timeStep: 1 / 90,
            maxSubSteps: 2,
            paused: true,
            defaultShape: 'sphere'
        })
    );

    const world = box.ps!;
    assert.isDefined(world, '<Physics> never provided a physics system');
    assert.closeTo(gravityOf(world).y, -4, 1e-6, 'gravity prop was dropped');
    assert.isFalse(world.interpolate, 'interpolate prop was dropped');
    assert.closeTo(world.timeStep as number, 1 / 90, 1e-9, 'timeStep prop was dropped');
    assert.equal(world.maxSubSteps, 2, 'maxSubSteps prop was dropped');
    assert.isTrue(world.paused, 'paused prop was dropped');
    assert.equal(world.bodySystem.defaultShape, 'sphere', 'defaultShape prop was dropped');

    await renderer.unmount();
});

test('<Physics> defaults match the documented ones', async () => {
    const box: { ps?: PhysicsSystem } = {};
    const renderer = await create(tree(box, {}));

    const world = box.ps!;
    assert.closeTo(gravityOf(world).y, -9.81, 1e-4);
    assert.isTrue(world.interpolate);
    assert.closeTo(world.timeStep as number, STEP, 1e-9);
    assert.equal(world.maxSubSteps, 5);
    assert.isFalse(world.paused);
    assert.isUndefined(world.bodySystem.defaultShape);

    await renderer.unmount();
});

test('gravity and paused stay reactive after mount', async () => {
    const box: { ps?: PhysicsSystem } = {};
    const renderer = await create(tree(box, { gravity: [0, -1, 0] }));
    const world = box.ps!;
    assert.closeTo(gravityOf(world).y, -1, 1e-6);

    await renderer.update(tree(box, { gravity: [0, -30, 0] }));
    assert.closeTo(gravityOf(world).y, -30, 1e-6, 'changing the gravity prop did nothing');

    // the same values rendered as a fresh array must not churn or reset anything
    await renderer.update(tree(box, { gravity: [0, -30, 0] }));
    assert.closeTo(gravityOf(world).y, -30, 1e-6);

    await renderer.update(tree(box, { gravity: [0, -30, 0], paused: true }));
    assert.isTrue(world.paused, 'changing the paused prop did nothing');
    await renderer.update(tree(box, { gravity: [0, -30, 0], paused: false }));
    assert.isFalse(world.paused);

    await renderer.unmount();
});

test('paused stops the simulation while the frame loop keeps running', async () => {
    const box: { ps?: PhysicsSystem } = {};
    const renderer = await create(tree(box, { paused: true }));
    const world = box.ps!;

    const body = [...world.bodySystem.dynamicBodies.values()][0];
    assert.isDefined(body, '<RigidBody> never created a body');
    const before = body.position.y;

    await renderer.advanceFrames(20, STEP);
    assert.closeTo(body.position.y, before, 1e-6, 'a paused world still simulated');

    // unpausing resumes without remounting anything
    await renderer.update(tree(box, { paused: false }));
    await renderer.advanceFrames(20, STEP);
    assert.isBelow(body.position.y, before, 'unpausing did not resume the simulation');

    await renderer.unmount();
});

// --- allocation spy ---------------------------------------------------------------------------

// Wraps the Jolt value-type constructors we allocate from JS plus `destroy`, so a test can
// assert that a block of work is allocation neutral. The wrappers share the originals'
// prototypes, so `instanceof` and the binder's own pointer cache are unaffected.
//
// NOT the shared `installAllocTracker` from test/jolt-alloc.ts on purpose: that helper replaces
// `Raw.module` with a Proxy, and `joltScratch` (utils/general.ts) keys its shared Vec3/RVec3/Quat
// singletons on module identity so it can drop them when a test swaps the module out. Installing
// the shared tracker therefore rebuilds the scratch objects *inside* the counted window and every
// `joltScratch` user - setGravity, the body setters - looks like it allocates one object. This
// spy mutates the module in place, leaving its identity (and the scratch) alone.
const TRACKED = ['Vec3', 'RVec3', 'Quat', 'Mat44', 'RMat44'] as const;

function allocationSpy() {
    // biome-ignore lint/suspicious/noExplicitAny: the jolt module is an untyped embind namespace
    const jolt = Raw.module as any;
    const originals = new Map<string, any>();
    let created = 0;
    let destroyed = 0;

    for (const name of TRACKED) {
        const Original = jolt[name];
        if (typeof Original !== 'function') continue;
        originals.set(name, Original);
        const Wrapped = function (this: any, ...args: any[]) {
            created++;
            return new Original(...args);
        };
        Wrapped.prototype = Original.prototype;
        Object.setPrototypeOf(Wrapped, Original);
        jolt[name] = Wrapped;
    }

    const originalDestroy = jolt.destroy;
    jolt.destroy = (obj: any) => {
        destroyed++;
        return originalDestroy(obj);
    };

    return {
        stop() {
            for (const [name, Original] of originals) jolt[name] = Original;
            jolt.destroy = originalDestroy;
            return { created, destroyed, live: created - destroyed };
        }
    };
}
