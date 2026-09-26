// Opt-in `matrixAutoUpdate={false}` frame sync (issue #168).
//
// With `bodyState.matrixAutoUpdate = false`, `PhysicsSystem.syncBodyToObject` writes the body's
// pose straight into `object.matrix` (parent space) instead of `object.position`/
// `object.quaternion`, and turns off three's own `Object3D.matrixAutoUpdate` so nothing recomposes
// the matrix from those a moment later. `object.position`/`object.quaternion` are never touched by
// the sync in this mode - only `object.matrix` (and `matrixWorldNeedsUpdate`) change.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('matrix-auto-update');
    // deterministic: compare the synced matrix/position against the *live* physics pose without
    // worrying about the interpolation lerp landing short of it on the last frame.
    ps.interpolate = false;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

let laneX = 0;

test('matrixAutoUpdate=false writes the pose into object.matrix and leaves object.position untouched', () => {
    laneX += 5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(laneX, 5, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
    state.matrixAutoUpdate = false;

    assert.isFalse(mesh.matrixAutoUpdate, 'three.js Object3D.matrixAutoUpdate was not turned off');

    // record the untouched value: `position`/`quaternion` are whatever they were at body
    // creation and must stay exactly that, forever, in this mode.
    const positionBefore = mesh.position.clone();
    const quaternionBefore = mesh.quaternion.clone();

    for (let i = 0; i < 60; i++) ps.onUpdate(STEP);

    // the body must actually have moved (fallen), or this test would pass vacuously
    const livePosition = state.getPosition() as THREE.Vector3;
    assert.isBelow(
        livePosition.y,
        5,
        'the box never fell - test is not exercising a real pose change'
    );

    // object.matrix must reflect the live physics pose
    const expected = new THREE.Matrix4().compose(livePosition, state.rotation, state.activeScale);
    let maxDelta = 0;
    for (let i = 0; i < 16; i++)
        maxDelta = Math.max(maxDelta, Math.abs(mesh.matrix.elements[i] - expected.elements[i]));
    assert.isBelow(maxDelta, 1e-3, 'object.matrix does not match the physics pose');

    // position/quaternion must be untouched by the sync
    assert.isTrue(mesh.position.equals(positionBefore), 'object.position was written to');
    assert.isTrue(mesh.quaternion.equals(quaternionBefore), 'object.quaternion was written to');
});

test('the default (matrixAutoUpdate=true) keeps writing position/quaternion, unchanged from before', () => {
    laneX += 5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(laneX, 5, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;

    assert.isTrue(
        mesh.matrixAutoUpdate,
        "matrixAutoUpdate should still default to three's normal true"
    );

    for (let i = 0; i < 60; i++) ps.onUpdate(STEP);

    const livePosition = state.getPosition() as THREE.Vector3;
    assert.isBelow(livePosition.y, 5, 'the box never fell');
    assert.closeTo(mesh.position.y, livePosition.y, 1e-3, 'object.position was not synced');
});

test('matrixAutoUpdate=false renders visually identically to the default under a static (non-moving) parent', () => {
    // Two identical rigs (same parent offset, same starting local pose, same shape) that only
    // differ in `matrixAutoUpdate` - if the optimisation is correct, physics stepping is
    // deterministic, so their resulting `matrixWorld`s must match to within float error (the
    // issue #168 DoD: "renders visually identically to the default"). This sidesteps needing to
    // independently re-derive the expected world matrix by hand.
    function buildRig(matrixAutoUpdate: boolean) {
        // Jolt bodies are created at `object.position` read as a *world* space position (a
        // pre-existing quirk unrelated to #168 - the physics body does not know about the
        // three.js parent transform, only the render-time sync in `syncBodyToObject` does).
        // Each rig therefore needs its own lane so the two physics bodies - both nominally at
        // the same local (5, 0) offset - don't land on top of each other and collide.
        laneX += 5;
        const scene = new THREE.Scene();
        const parent = new THREE.Group();
        parent.position.set(10, 20, 30);
        scene.add(parent);

        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(laneX, 5, 0);
        parent.add(mesh);
        // the parent's transform must be committed to matrixWorld *before* the body is created
        // and captures `invertedWorldMatrix` - exactly the "parent never moves again" contract
        // `matrixAutoUpdate=false` documents.
        scene.updateMatrixWorld(true);

        const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
        state.matrixAutoUpdate = matrixAutoUpdate;
        return { scene, parent, mesh, state, lane: laneX };
    }

    const control = buildRig(true);
    const optimised = buildRig(false);

    for (let i = 0; i < 60; i++) ps.onUpdate(STEP);

    // three's own traversal is what turns object.matrix into matrixWorld - exercise it for real,
    // on both rigs, the same way a render frame would.
    control.scene.updateMatrixWorld();
    optimised.scene.updateMatrixWorld();

    // sanity: the body actually fell, so this isn't vacuously comparing two static poses
    assert.isBelow(
        (control.state.getPosition() as THREE.Vector3).y,
        5,
        'the control rig never fell - test is not exercising a real pose change'
    );

    let maxDelta = 0;
    for (let i = 0; i < 16; i++)
        maxDelta = Math.max(
            maxDelta,
            Math.abs(
                control.mesh.matrixWorld.elements[i] -
                    optimised.mesh.matrixWorld.elements[i] -
                    // the rigs sit in different lanes on x (see buildRig); this used to cancel out
                    // only because both collapsed to the origin (#300 parent-space fix)
                    (i === 12 ? control.lane - optimised.lane : 0)
            )
        );
    assert.isBelow(
        maxDelta,
        1e-3,
        "matrixAutoUpdate=false's world matrix under a static parent diverged from the default"
    );
});

// -- Perf: how much does skipping three's per-object matrix recompute actually save? -------
//
// No assertion on timing (machine dependent) - this reports numbers per the task brief.
// CI runners are slower and noisier than a dev machine, and this test's four world-builds plus
// several hundred physics steps blew past vitest's default 5s test timeout there (took 5943ms on
// GitHub's runner) even though it comfortably finishes locally - an explicit timeout gives it the
// headroom a benchmark needs without raising the suite's default for every other test.
test('perf: matrixAutoUpdate sync cost for 500 dynamic bodies, with vs without', () => {
    const N = 500;
    const warmSteps = 5;
    const timedSteps = 60;

    function buildWorld(pid: string, matrixAutoUpdate: boolean): PhysicsSystem {
        const world = new PhysicsSystem(pid);
        const floor = new THREE.Mesh(new THREE.BoxGeometry(2000, 1, 2000));
        floor.position.set(0, -1, 0);
        world.bodySystem.addBody(floor, { bodyType: 'static' });

        const perRow = Math.ceil(Math.sqrt(N));
        for (let i = 0; i < N; i++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
            mesh.position.set(
                (i % perRow) * 1.2,
                4 + Math.floor(i / perRow) * 0.05,
                Math.floor(i / perRow) * 1.2
            );
            const handle = world.bodySystem.addBody(mesh);
            const state = world.bodySystem.getBody(handle)!;
            state.matrixAutoUpdate = matrixAutoUpdate;
        }
        return world;
    }

    function timeRun(matrixAutoUpdate: boolean): number {
        // fresh pid, reused across the two variants, freed at the end of each run so this
        // never exceeds PhysicsSystem's `maxInterfaces` cap
        const world = buildWorld('matrix-perf-168', matrixAutoUpdate);
        for (let i = 0; i < warmSteps; i++) world.onUpdate(STEP);
        const start = performance.now();
        for (let i = 0; i < timedSteps; i++) world.onUpdate(STEP);
        const elapsed = performance.now() - start;
        world.destroy('matrix-perf-168');
        return elapsed;
    }

    // two passes each, keep the faster one to reduce scheduling noise
    const withAutoUpdate = Math.min(timeRun(true), timeRun(true));
    const withoutAutoUpdate = Math.min(timeRun(false), timeRun(false));
    const delta = withAutoUpdate - withoutAutoUpdate;
    const pct = (delta / withAutoUpdate) * 100;

    // eslint-disable-next-line no-console
    console.log(
        `[#168 perf] ${N} dynamic bodies x ${timedSteps} steps - ` +
            `matrixAutoUpdate=true: ${withAutoUpdate.toFixed(2)}ms, ` +
            `matrixAutoUpdate=false: ${withoutAutoUpdate.toFixed(2)}ms, ` +
            `delta: ${delta.toFixed(2)}ms (${pct.toFixed(1)}%)`
    );

    // Reported, not asserted - timing is machine dependent (see the brief).
    assert.isTrue(true);
}, 60_000);
