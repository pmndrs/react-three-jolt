// Runtime coverage for packages/react-three-jolt/src/systems/queries/shapecasters.ts, exercised
// against the real WASM module (see jolt-runtime.test.ts for the pattern this follows).
//
// shapecasters.ts is the sibling of raycasters.ts and carried the same two memory bugs, which
// the raycaster fixes (#173) never reached because nothing touched this file:
// - ShapecastHit's constructor destroyed the Vec3/RVec3 that `RShapeCast.GetPointOnRay()`
//   returns. That is a BY VALUE return: jolt-physics' WebIDL binder hands back a pointer to ONE
//   static temporary per bound function, shared across every shapecast and overwritten on the
//   next call. Freeing it hands the binder's own memory back to the allocator, which reuses it
//   immediately - the corruption then surfaces somewhere else entirely.
// - `ShapecastHit.impactNormal` allocated a BodyID, a SubShapeID and an RVec3 on every read and
//   freed none of them. It is read per hit, per frame, by the camera rig.
//
// The allocation test below discovers every embind constructor on the module at runtime rather
// than taking a fixed list, so it covers BodyID/SubShapeID (not value types, so not in
// jolt-alloc.ts's DEFAULT_TRACKED_TYPES) without having to name them.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import type { ShapecastHit } from '../src/systems/queries/shapecasters';

let ps: PhysicsSystem;

// One static box sitting on +Z, big enough that a half-unit sphere swept down +Z runs into it.
beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('shapecasters-test');

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
    mesh.position.set(0, 0, 10);
    ps.bodySystem.addBody(mesh, { bodyType: 'static' });
});

test('a shapecast hits the box and reports a usable position and impact normal', () => {
    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 0, -10);
    sc.direction = new THREE.Vector3(0, 0, 30);

    const hit = sc.cast() as ShapecastHit;
    assert.isDefined(hit, 'shapecast found nothing');

    // the box spans z 8..12, so the sweep should stop at its near face
    assert.closeTo(hit.position.z, 8, 1.5, 'hit position is not on the near face of the box');
    assert.isTrue(Number.isFinite(hit.position.x), 'hit position was not read out of the binder');
    assert.isAbove(hit.distance, 0, 'hit distance should be positive');

    // impactNormal reads GetWorldSpaceSurfaceNormal, itself a by-value static temporary. A
    // destroyed/corrupted temporary shows up here as a non-finite or zero-length vector.
    const normal = hit.impactNormal;
    assert.isTrue(
        Number.isFinite(normal.x) && Number.isFinite(normal.y) && Number.isFinite(normal.z),
        'impactNormal came back non-finite - a by-value temporary was freed'
    );
    assert.closeTo(normal.length(), 1, 1e-3, 'impactNormal is not a unit vector');
    // the sweep travels +Z into the box, so its near face points back at us
    assert.isBelow(normal.z, -0.5, 'impactNormal does not point back along the sweep');

    sc.destroy();
});

test('allocation count is stable across repeated shapecasts', () => {
    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 0, -10);
    sc.direction = new THREE.Vector3(0, 0, 30);

    // warm up outside the tracker: the first cast lazily builds things that legitimately stay
    const warm = sc.cast() as ShapecastHit;
    assert.isDefined(warm, 'warm-up shapecast found nothing');
    void warm.impactNormal;

    // `tracker.outstanding()` is (every `new Raw.module.X()` we observed) minus (every
    // `Raw.module.destroy()` we observed). By-value returns (GetPointOnRay,
    // GetWorldSpaceSurfaceNormal) never go through `new`, so they are not counted - and must
    // never be destroyed either, which would push this NEGATIVE rather than letting it grow.
    // So every counted allocation is one our own source made, and in leak-free code it ends up
    // destroyed: the number must be flat across batches, in both directions.
    const tracker = trackAllocations();
    const baseline = tracker.outstanding();

    const castBatch = (n: number) => {
        for (let i = 0; i < n; i++) {
            const hit = sc.cast() as ShapecastHit;
            // impactNormal is where the leak lived: BodyID/SubShapeID/RVec3 allocated per read
            if (hit) void hit.impactNormal;
        }
    };

    castBatch(50);
    const afterFirstBatch = tracker.outstanding();
    castBatch(50);
    const afterSecondBatch = tracker.outstanding();
    tracker.restore();
    sc.destroy();

    assert.equal(
        afterFirstBatch,
        baseline,
        `outstanding Jolt allocations moved from ${baseline} to ${afterFirstBatch} over 50 shapecasts - something is leaking (or double freeing) every cast`
    );
    assert.equal(
        afterSecondBatch,
        afterFirstBatch,
        `outstanding Jolt allocations moved from ${afterFirstBatch} to ${afterSecondBatch} over 50 more shapecasts - something is leaking (or double freeing) every cast`
    );
});

// Minimal allocation spy: wraps every embind class constructor hanging off `Raw.module`
// (everything capitalized, per jolt-physics' naming convention) plus `Raw.module.destroy`, so we
// can assert created === destroyed ("outstanding" allocations) rather than trusting that every
// `destroy()` call in the source was the *correct* one. Same shape as the one in
// raycasters.test.ts; the shared helper in jolt-alloc.ts takes an explicit type list instead,
// which would not cover BodyID/SubShapeID without naming them.
function trackAllocations() {
    const proto = Raw.module as unknown as Record<string, unknown>;
    let created = 0;
    let destroyed = 0;

    const originalDestroy = proto.destroy as (obj: unknown) => void;
    proto.destroy = (obj: unknown) => {
        destroyed++;
        return originalDestroy(obj);
    };

    const restoreCtors: Array<() => void> = [];
    for (const key of Object.getOwnPropertyNames(proto)) {
        if (!/^[A-Z]/.test(key)) continue;
        // biome-ignore lint/suspicious/noExplicitAny: embind constructor, no shared base type
        const original = proto[key] as any;
        if (typeof original !== 'function' || !original.prototype) continue;
        const wrapped = new Proxy(original, {
            construct(target, args, newTarget) {
                created++;
                return Reflect.construct(target, args, newTarget);
            }
        });
        proto[key] = wrapped;
        restoreCtors.push(() => {
            proto[key] = original;
        });
    }

    return {
        outstanding: () => created - destroyed,
        restore: () => {
            proto.destroy = originalDestroy;
            for (const restore of restoreCtors) restore();
        }
    };
}
