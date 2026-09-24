// Water volumes / `Body.ApplyBuoyancyImpulse` (issue #240), against the real wasm module.
//
// Two API facts drive most of these assertions, both verified empirically against jolt-physics
// 1.1 (there is no source to read - it ships as wasm only):
//
//   - `volume.buoyancy` is a ratio to standard gravity, not an object density: `1.0` is exactly
//     neutrally buoyant (the body sits still - gravity and the buoyant push cancel), `> 1` floats,
//     `< 1` sinks. This held to the millimetre in a synthetic probe across every `gravityFactor`
//     and `mass` tried.
//   - the resulting velocity change is **mass independent**. A 1kg and a 50,000kg box of the same
//     shape settle at the exact same height for the same `buoyancy`. There is no per-body density
//     knob - different objects float differently only if they're in different volumes (`group`/
//     `filter` picks who each one affects), which is what the demo and the "different densities"
//     test below both do.

import * as THREE from 'three';
import { afterEach, assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { BuoyancySystem } from '../src/systems/buoyancy-system';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

let ps: PhysicsSystem;
let buoyancy: BuoyancySystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('buoyancy');
    buoyancy = ps.getBuoyancySystem();
});

// A failed assertion aborts the rest of its test, including any manual cleanup written after
// it - without this, one failure would leave its volume/body behind to contaminate every test
// that runs afterward (they share one `PhysicsSystem` for the whole file, same as
// test/constraints.test.ts).
afterEach(() => {
    for (const id of buoyancy.volumeIds()) buoyancy.removeVolume(id);
    for (const body of [...ps.bodySystem.dynamicBodies.values()]) body.destroy();
});

//* helpers ------------------------------------------------------------

const box = (position: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(...position);
    return mesh;
};

const addBody = (position: [number, number, number]): BodyState => {
    const handle = ps.bodySystem.addBody(box(position));
    return ps.bodySystem.getBody(handle)!;
};

const step = (frames = 60) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
};

/** A 10x10x10 pool centered on the origin (world y -5..5), surface at y=2. */
const addPool = (overrides: Parameters<typeof buoyancy.addVolume>[0] = {}) =>
    buoyancy.addVolume({
        position: [0, 0, 0],
        size: [10, 10, 10],
        surfaceHeight: 2,
        ...overrides
    });

//* registry -------------------------------------------------------------

test('addVolume/updateVolume/removeVolume manage the registry', () => {
    assert.equal(buoyancy.volumeCount, 0);
    const id = addPool();
    assert.equal(buoyancy.volumeCount, 1);
    assert.deepEqual(buoyancy.volumeIds(), [id]);

    buoyancy.updateVolume(id, { position: [0, 0, 0], size: [10, 10, 10], buoyancy: 3 });
    assert.equal(
        buoyancy.volumeCount,
        1,
        'updateVolume must patch in place, not add a second volume'
    );

    assert.isTrue(buoyancy.removeVolume(id));
    assert.equal(buoyancy.volumeCount, 0);
    assert.isFalse(
        buoyancy.removeVolume(id),
        'removing an already-removed id is a no-op, not a throw'
    );
});

//* physical behaviour -----------------------------------------------------

test('buoyancy > 1 floats a body up toward the surface', () => {
    addPool({ buoyancy: 1.5 });
    const body = addBody([0, -3, 0]);
    const start = body.position.y;

    step(180);

    const end = body.position.y;
    assert.isAbove(end, start + 1, 'the body did not rise in the water');
    assert.isBelow(end, 6, 'the body shot out through the top of the pool');
    assert.closeTo(body.position.x, 0, 1e-3);
    assert.closeTo(body.position.z, 0, 1e-3);
});

test('buoyancy < 1 sinks a body of the same shape', () => {
    addPool({ buoyancy: 0.5 });
    const body = addBody([0, -3, 0]);
    const start = body.position.y;

    step(180);

    assert.isBelow(body.position.y, start - 3, 'an under-buoyant volume did not let the body sink');
});

test('buoyancy: 1 is exactly neutral - the body neither rises nor sinks', () => {
    addPool({ buoyancy: 1 });
    const body = addBody([0, -3, 0]);
    const start = body.position.y;

    step(180);

    assert.closeTo(body.position.y, start, 0.05, 'buoyancy: 1 should cancel gravity exactly');
});

test('mass has no effect on how a body settles', () => {
    // same volume and shape, only `mass` differs - the resting height must be identical, because
    // `ApplyBuoyancyImpulse`'s velocity change does not depend on it (see file header).
    const id = addPool({ buoyancy: 1.5, position: [0, 0, 0], size: [10, 10, 10] });
    const light = addBody([-2, -3, 0]);
    light.mass = 1;
    buoyancy.updateVolume(id, { buoyancy: 1.5, position: [0, 0, 0], size: [10, 10, 10] });
    const heavy = addBody([2, -3, 0]);
    heavy.mass = 10_000;

    step(180);

    assert.approximately(
        light.position.y,
        heavy.position.y,
        0.05,
        'a light and a heavy body of the same shape settled at different heights'
    );
});

test('a body outside the volume falls normally', () => {
    const body = addBody([20, -3, 0]);
    const start = body.position.y;

    step(180);

    assert.isBelow(
        body.position.y,
        start - 1,
        'a body far from any volume did not fall under gravity'
    );
});

test('enabled: false is a no-op', () => {
    addPool({ buoyancy: 1.5, enabled: false });
    const body = addBody([0, -3, 0]);
    const start = body.position.y;

    step(180);

    assert.isBelow(body.position.y, start - 1, 'a disabled volume still applied buoyancy');
});

test('a sleeping body is woken and floats when a volume catches it', () => {
    addPool({ buoyancy: 1.5 });
    const body = addBody([0, -3, 0]);
    ps.bodyInterface.DeactivateBody(body.BodyID);
    assert.isFalse(body.body.IsActive(), 'test setup: the body should start asleep');
    const start = body.position.y;

    step(30);

    assert.isTrue(body.body.IsActive(), 'the volume did not wake the sleeping body');
    assert.isAbove(body.position.y, start, 'the woken body did not start floating');
});

test('activate: false leaves a sleeping body asleep', () => {
    addPool({ buoyancy: 1.5, activate: false });
    const body = addBody([0, -3, 0]);
    ps.bodyInterface.DeactivateBody(body.BodyID);
    assert.isFalse(body.body.IsActive());

    step(30);

    assert.isFalse(body.body.IsActive(), 'activate: false still woke the sleeping body');
});

test('group only affects bodies with a matching group', () => {
    addPool({ buoyancy: 1.5, group: 7 });
    const inGroup = addBody([0, -3, 0]);
    inGroup.group = 7;
    const outOfGroup = addBody([3, -3, 0]);
    const startIn = inGroup.position.y;
    const startOut = outOfGroup.position.y;

    step(180);

    assert.isAbove(inGroup.position.y, startIn + 1, 'the grouped body was not affected');
    assert.isBelow(
        outOfGroup.position.y,
        startOut - 1,
        'an ungrouped body was affected anyway despite being inside the volume'
    );
});

test('filter excludes a body even when the group matches', () => {
    const excluded: BodyState[] = [];
    addPool({
        buoyancy: 1.5,
        filter: (body) => !excluded.includes(body)
    });
    const kept = addBody([0, -3, 0]);
    const skipped = addBody([3, -3, 0]);
    excluded.push(skipped);
    const startKept = kept.position.y;
    const startSkipped = skipped.position.y;

    step(180);

    assert.isAbove(kept.position.y, startKept + 1);
    assert.isBelow(skipped.position.y, startSkipped - 1, 'the filtered-out body still floated');
});

test('different densities: two overlapping volumes float one group and sink another', () => {
    // the demo's actual mechanism for "boxes of different densities" - see
    // apps/examples/src/examples/Buoyancy.tsx
    addPool({ buoyancy: 1.8, group: 1 }); // corks
    addPool({ buoyancy: 0.4, group: 2 }); // rocks
    const cork = addBody([0, -3, 0]);
    cork.group = 1;
    const rock = addBody([3, -3, 0]);
    rock.group = 2;
    const corkStart = cork.position.y;
    const rockStart = rock.position.y;

    step(180);

    assert.isAbove(cork.position.y, corkStart + 1, 'the cork did not float');
    assert.isBelow(rock.position.y, rockStart - 1, 'the rock did not sink');
});

test('per-body buoyancy overrides: one body with override sinks while the other floats (issue #260)', () => {
    // different densities in one volume - no need for stacking volumes and groups
    addPool({ buoyancy: 1.5 });
    const floater = addBody([0, -3, 0]);
    const sinker = addBody([3, -3, 0]);
    sinker.buoyancy = 0.5; // overrides pool's 1.5, so it sinks
    const floatStart = floater.position.y;
    const sinkStart = sinker.position.y;

    step(180);

    assert.isAbove(
        floater.position.y,
        floatStart + 1,
        'the floater with default buoyancy did not float'
    );
    assert.isBelow(
        sinker.position.y,
        sinkStart - 3,
        'the sinker with overridden buoyancy did not sink'
    );
});

//* leak -------------------------------------------------------------

test('the per-substep path allocates nothing on the Jolt heap', () => {
    addPool({ buoyancy: 1.5 });
    addBody([0, -3, 0]);

    // warm everything up before the tracker is installed
    step(10);

    const alloc = installAllocTracker(Raw);
    try {
        step(1);
        const before = alloc.live();
        step(200);
        assert.equal(alloc.live(), before, 'buoyancy leaks Jolt objects per substep');
        assert.equal(alloc.foreignDestroys(), 0, 'something freed a Jolt owned temporary');
    } finally {
        alloc.uninstall();
    }
});

test('BuoyancySystem.destroy frees its scratch objects and stops stepping', () => {
    const system = ps.getBuoyancySystem();
    const id = system.addVolume({ position: [0, 0, 0], size: [4, 4, 4], surfaceHeight: 1 });
    expect(system.volumeCount).toBe(1);

    system.destroy();
    // idempotent
    system.destroy();

    // a destroyed system's registry is empty and inert; the world itself is still alive
    expect(system.volumeCount).toBe(0);
    system.removeVolume(id);
    expect(system.volumeCount).toBe(0);
});
