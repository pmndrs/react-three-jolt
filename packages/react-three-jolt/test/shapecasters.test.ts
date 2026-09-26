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
//
// Issue #192 is a second follow-up, filed once #173/#191 fixed the same two bugs (unbounded
// debug-drawing allocations, axis-aligned markers, an un-Release()d default shape) for raycasters
// but never touched this sibling file:
// - drawDebuggingLine/Points/Marker allocated a brand new THREE.BufferGeometry/Material/Object3D
//   on every call, so a shapecaster drawing its debug view every cast grew the scene graph and
//   leaked three.js resources without bound - the same bug #173 fixed for raycasters.ts.
// - drawMarker always drew axis-aligned to world space, the same bug #48 fixed for raycasters.ts.
// - `Shapecaster.destroy()` never `Release()`d its default `activeShape` (one `SphereShape` per
//   shapecaster) the way `ShapeCollider.destroy()` does after #174.

import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { Shapecaster, type ShapecastHit } from '../src/systems/queries/shapecasters';
import { generateJoltMatrix } from '../src/utils';
import { installAllocTracker } from './jolt-alloc';

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

test('drawMarker orients the marker along the hit surface normal (issue #192, mirrors #48)', () => {
    // A box tilted around X so the face the sweep (fired along +Z) hits has a normal with a
    // nonzero Y component - i.e. NOT the world-space axis alignment the old marker always drew
    // regardless of what it hit. Ported from raycasters.test.ts.
    const tiltedMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    tiltedMesh.position.set(0, 0, 25);
    tiltedMesh.rotation.set(Math.PI / 6, 0, 0);
    const tilted = ps.bodySystem.getBody(
        ps.bodySystem.addBody(tiltedMesh, { bodyType: 'static' })
    )!;

    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 0, 20);
    sc.direction = new THREE.Vector3(0, 0, 10);
    const hit = sc.cast() as ShapecastHit;
    assert.isDefined(hit, 'expected the tilted box to be hit');

    const normal = hit.impactNormal.clone().normalize();
    // sanity check: the tilt must have actually knocked the normal off the world Z axis, or this
    // test would pass even against the old, always-axis-aligned marker code
    assert.isAbove(
        Math.abs(normal.y),
        0.05,
        'expected the tilted box to produce a non-axis-aligned surface normal'
    );

    sc.initDebugging(new THREE.Scene());
    const marker = sc.drawMarker(hit);

    const expected = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    assert.approximately(marker.quaternion.x, expected.x, 1e-6, 'marker quaternion x');
    assert.approximately(marker.quaternion.y, expected.y, 1e-6, 'marker quaternion y');
    assert.approximately(marker.quaternion.z, expected.z, 1e-6, 'marker quaternion z');
    assert.approximately(marker.quaternion.w, expected.w, 1e-6, 'marker quaternion w');

    sc.destroy();
    tilted.destroy();
});

test('repeated drawMarker calls reuse the pooled marker instead of growing the scene graph or reallocating geometry (issue #192, mirrors #173)', () => {
    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 0, -10);
    sc.direction = new THREE.Vector3(0, 0, 30);
    const hit = sc.cast() as ShapecastHit;
    assert.isDefined(hit, 'setup cast found nothing');

    sc.initDebugging(new THREE.Scene());

    const first = sc.drawMarker(hit);
    const childCountAfterFirst = sc.debugObject.children.length;
    const ringGeometry = (first.children[0] as THREE.LineLoop).geometry;
    const normalGeometry = (first.children[1] as THREE.Line).geometry;

    for (let i = 0; i < 25; i++) {
        const marker = sc.drawMarker(hit);
        assert.strictEqual(
            marker,
            first,
            'drawMarker should return the same pooled group every time'
        );
        assert.strictEqual(
            (marker.children[0] as THREE.LineLoop).geometry,
            ringGeometry,
            'ring geometry was reallocated on a repeated drawMarker call'
        );
        assert.strictEqual(
            (marker.children[1] as THREE.Line).geometry,
            normalGeometry,
            'normal-line geometry was reallocated on a repeated drawMarker call'
        );
        assert.strictEqual(
            sc.debugObject.children.length,
            childCountAfterFirst,
            'debugObject.children grew from a repeated drawMarker call'
        );
    }

    sc.destroy();
});

test('cast()-driven debug drawing does not grow the scene graph across repeated casts (issue #192, mirrors #173)', () => {
    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 0, -10);
    sc.direction = new THREE.Vector3(0, 0, 30);

    sc.initDebugging(new THREE.Scene());
    sc.drawPoints = true;
    sc.drawMarkers = true;

    sc.cast();
    const childCountAfterFirst = sc.debugObject.children.length;
    assert.isAbove(childCountAfterFirst, 0, 'expected the debug line/points/marker to be drawn');

    for (let i = 0; i < 25; i++) sc.cast();

    assert.strictEqual(
        sc.debugObject.children.length,
        childCountAfterFirst,
        'debugObject.children grew across repeated cast() calls with debugging enabled'
    );

    sc.destroy();
});

// Allocation tracking for the destroy()/refcount tests below uses the shared `installAllocTracker`
// helper (test/jolt-alloc.ts) rather than the file-local `trackAllocations()` spy further down:
// unlike that spy (which discovers every constructor and so must stay agnostic about ref-counted
// Shape types), these tests need to name an explicit, narrow list so a Shape's AddRef/Release
// lifecycle - which never touches `new`/`destroy` - doesn't get mixed in with the plain new/destroy
// allocations. Mirrors collider.test.ts's tracking of ShapeCollider.
const SHAPECASTER_TRACKED_TYPES = [
    'Vec3',
    'RVec3',
    'Quat',
    'Mat44',
    'RMat44',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'ShapeCastSettings',
    'RShapeCast',
    'CastShapeClosestHitCollisionCollector',
    'CastShapeAnyHitCollisionCollector',
    'CastShapeAllHitCollisionCollector'
];

const trackDestroyAllocations = () =>
    installAllocTracker(Raw, { types: SHAPECASTER_TRACKED_TYPES, throwOnDoubleDestroy: false });

test('destroy() frees every Jolt object the shapecaster allocated (issue #192)', () => {
    const tracker = trackDestroyAllocations();
    try {
        // `installAllocTracker` swaps `Raw.module`'s identity, which rebuilds `joltScratch`'s
        // shared RVec3/Quat singletons (used by generateJoltMatrix(), which
        // initializeShapecast() calls) exactly once against the tracked module - warm that up
        // and throw it away before measuring, or that one-time rebuild would be misread as a
        // leak from the Shapecaster under test (see the "CRITICAL Jolt memory facts" in the repo
        // brief / jolt-ownership.test.ts's equivalent warm-up).
        Raw.module.destroy(generateJoltMatrix(new THREE.Vector3(), new THREE.Quaternion()));

        const baseline = tracker.live();
        const sc = new Shapecaster(ps.physicsSystem, ps.joltInterface);
        // sanity check: constructing really does allocate tracked objects (shapecast, settings,
        // filters, collector)
        expect(tracker.live()).toBeGreaterThan(baseline);

        sc.origin = new THREE.Vector3(0, 0, -10);
        sc.direction = new THREE.Vector3(0, 0, 30);
        sc.cast();

        sc.destroy();
        expect(tracker.live()).toBe(baseline);
        expect(tracker.foreignDestroys()).toBe(0);
    } finally {
        tracker.uninstall();
    }
});

test('destroy() Release()s the default activeShape it created (issue #192, mirrors ShapeCollider from #174)', () => {
    const sc = new Shapecaster(ps.physicsSystem, ps.joltInterface);
    const shape = sc.shape;

    // take our own reference before destroy() so GetRefCount() stays safe to read afterwards -
    // letting the count hit zero would free the underlying native object out from under us (the
    // same reason collider.test.ts's shape-ownership test keeps its own reference on the shape it
    // inspects).
    shape.AddRef();
    assert.equal(shape.GetRefCount(), 2, 'constructor AddRef() + this test-owned AddRef()');

    sc.destroy();
    assert.equal(
        shape.GetRefCount(),
        1,
        "destroy() should Release() the shapecaster's own reference, leaving only the caller's"
    );

    shape.Release();
});

test('shape ownership: AddRef()s on set, Release()s on replace and on destroy (issue #192)', () => {
    const sc = new Shapecaster(ps.physicsSystem, ps.joltInterface);

    // give the test its own reference to a shape, independent of the shapecaster, so its refcount
    // can be freely inspected without ever operating on memory a Release() might have already
    // freed.
    const customShape = new Raw.module.SphereShape(0.4);
    customShape.AddRef();
    assert.equal(customShape.GetRefCount(), 1);

    sc.shape = customShape;
    // the shapecaster took its own reference on top of the test's
    assert.equal(customShape.GetRefCount(), 2);
    assert.strictEqual(sc.shape, customShape);

    sc.destroy();
    // destroy() released the shapecaster's reference; the test's own reference keeps it alive
    assert.equal(customShape.GetRefCount(), 1);

    // release the test's own reference last
    customShape.Release();
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
