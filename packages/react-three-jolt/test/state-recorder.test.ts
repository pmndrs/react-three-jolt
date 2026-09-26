// World snapshots: StateRecorder save/restore (issue #247).
//
// `PhysicsSystem.saveState()`/`restoreState()` and `BodyState.saveState()`/`restoreState()` wrap
// `Jolt.StateRecorderImpl` + `PhysicsSystem`/`Body`'s own `SaveState`/`RestoreState`. Restoring
// has to resync the three.js side by hand: the per-frame sync loop only visits awake bodies (plus
// the rare moved static), and a restore can wake or sleep a body relative to how it was before -
// most of what this file checks is that resync, not just that Jolt's own state came back.
//
// Runs against the real WASM module: one world for the whole file (falling boxes never interact
// across tests - each gets its own lane on x).

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('state-recorder');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

// every test drops its box (or boxes) in a fresh lane so bodies never interact across tests
let laneX = 0;

function addBox(y = 10): BodyState {
    laneX += 5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(laneX, y, 0);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
}

function step(n: number): void {
    for (let i = 0; i < n; i++) ps.onUpdate(STEP);
}

test('world save/restore: position and three.js object both land back within epsilon', () => {
    const box = addBox();
    step(5); // get it moving before the save, not sitting exactly at spawn
    const savedY = box.position.y;

    const snapshot = ps.saveState();
    step(60);
    assert.notEqual(box.position.y, savedY, 'test setup: the box did not move while stepping');

    const restored = ps.restoreState(snapshot);
    assert.isTrue(restored, 'PhysicsSystem.RestoreState reported failure');
    assert.closeTo(box.position.y, savedY, 1e-4, 'body position was not restored');
    // restoreState() pushes the restored (live) pose onto the object directly - it does not wait
    // for the next frame's interpolated sync, which (driven one exact timeStep at a time) always
    // lags the live body by a step - so this compares against the live position, not whatever
    // the object happened to show at save time.
    assert.closeTo(
        box.object.position.y,
        savedY,
        1e-4,
        'the three.js object was not resynced to the restored pose'
    );

    snapshot.destroy();
});

test('world save/restore: determinism - replaying from the same snapshot reaches the same result', () => {
    const box = addBox();
    step(5);
    const t0 = ps.saveState();

    step(37);
    const firstRun = { x: box.position.x, y: box.position.y, z: box.position.z };
    const afterFirstRun = ps.saveState();

    const restored = ps.restoreState(t0);
    assert.isTrue(restored);
    step(37);
    const secondRun = { x: box.position.x, y: box.position.y, z: box.position.z };
    const afterSecondRun = ps.saveState();

    assert.closeTo(secondRun.x, firstRun.x, 1e-5, 'replay from the same snapshot diverged (x)');
    assert.closeTo(secondRun.y, firstRun.y, 1e-5, 'replay from the same snapshot diverged (y)');
    assert.closeTo(secondRun.z, firstRun.z, 1e-5, 'replay from the same snapshot diverged (z)');
    assert.isTrue(
        afterFirstRun.isEqual(afterSecondRun),
        'Jolt.StateRecorderImpl.IsEqual disagrees that the two replays landed on the same state'
    );

    t0.destroy();
    afterFirstRun.destroy();
    afterSecondRun.destroy();
});

test('world save/restore: a restore resyncs a sleeping body the per-frame loop would otherwise skip', () => {
    const box = addBox(0.5); // spawn already resting on the floor
    // settle to sleep
    for (let i = 0; i < 300 && box.body.IsActive(); i++) ps.onUpdate(STEP);
    assert.isFalse(box.body.IsActive(), 'test setup: the box never fell asleep');

    const sleepObjectY = box.object.position.y;
    const snapshot = ps.saveState();

    // wake it and move it far away, then step twice so the (now awake) body's three.js object
    // actually reflects the move: this bypasses BodyState's own setters (which reset the pose
    // cache themselves), and the interpolated render is one step behind the live body while
    // driven exactly one timeStep at a time, so the first step only moves `previous` as far as
    // the old (sleeping) pose - the second is what actually shows the move on the object.
    const target = new Raw.module.RVec3(box.position.x, 50, box.position.z);
    ps.bodyInterface.SetPosition(box.BodyID, target, Raw.module.EActivation_Activate);
    Raw.module.destroy(target);
    step(2);
    assert.isAbove(box.object.position.y, 10, 'test setup: the box was not actually moved');

    const restored = ps.restoreState(snapshot);
    assert.isTrue(restored);
    assert.isFalse(box.body.IsActive(), 'restore did not put the body back to sleep');
    // No further ps.onUpdate() call happens between restoreState() and this assertion - the
    // per-frame loop skips sleeping bodies entirely, so if restoreState() did not force-sync the
    // object itself, this would still read the y=50 pose from just above.
    assert.closeTo(
        box.object.position.y,
        sleepObjectY,
        1e-3,
        'a sleeping body was not resynced on the three.js side by restoreState()'
    );

    snapshot.destroy();
});

test('world restoreState on a missing or destroyed snapshot is a safe no-op', () => {
    const snapshot = ps.saveState();
    snapshot.destroy();
    snapshot.destroy(); // idempotent

    const restored = ps.restoreState(snapshot);
    assert.isFalse(restored, 'restoring a destroyed snapshot should report failure, not throw');
});

test('body save/restore: resets one body without disturbing the rest of the world', () => {
    const boxA = addBox();
    const boxB = addBox();
    step(5);

    const savedAY = boxA.position.y;
    const snapA = boxA.saveState();
    assert.isDefined(snapA);

    step(30);
    const movedBY = boxB.position.y;
    assert.notEqual(boxA.position.y, savedAY, 'test setup: box A did not move');

    boxA.restoreState(snapA);
    assert.closeTo(boxA.position.y, savedAY, 1e-4, 'box A was not restored');
    assert.closeTo(
        boxB.position.y,
        movedBY,
        1e-9,
        'restoring one body disturbed another body in the same world'
    );

    snapA!.destroy();
});

test('body restoreState on a missing or destroyed snapshot is a safe no-op', () => {
    const box = addBox();
    const before = box.position.y;
    const snapshot = box.saveState();
    snapshot!.destroy();

    box.restoreState(snapshot);
    assert.equal(box.position.y, before, 'restoreState with a destroyed snapshot moved the body');
});

test('snapshots do not leak StateRecorderImpl, and double destroy is caught rather than double-freeing', () => {
    const alloc = installAllocTracker(Raw, {
        types: ['StateRecorderImpl'],
        throwOnDoubleDestroy: true
    });
    try {
        const before = alloc.live();
        const box = addBox();
        const worldSnapshot = ps.saveState();
        const bodySnapshot = box.saveState()!;
        assert.equal(
            alloc.live() - before,
            2,
            'saveState() did not allocate exactly one StateRecorderImpl each'
        );

        worldSnapshot.destroy();
        bodySnapshot.destroy();
        assert.equal(alloc.live(), before, 'destroy() leaked a StateRecorderImpl');

        // idempotent: the tracker's throwOnDoubleDestroy would throw if this reached
        // Raw.module.destroy() a second time for the same wrapper.
        worldSnapshot.destroy();
        bodySnapshot.destroy();
        assert.equal(alloc.live(), before);
    } finally {
        alloc.uninstall();
    }
});
