// Runtime coverage for packages/react-three-jolt/src/systems/queries/raycasters.ts, exercised
// against the real WASM module (see jolt-runtime.test.ts for the pattern this follows).
//
// Regression coverage for:
// - issue #60 ("Raycaster Many" demo): a closest-hit Raycaster never reset its collector between
//   casts, so once it had a first hit, HadHit()/mHit and the early-out fraction stayed put and
//   every later cast silently returned the FIRST hit's stale result instead of re-querying.
// - AdvancedRaycaster building a `CastRayCollectorJS` without installing Reset/OnBody/AddHit as
//   own properties on the instance, which makes embind throw "a JSImplementation must implement
//   all functions" the first time jolt-physics calls back into the collector.
// - unfreed per-cast Jolt allocations (RaycastHit.impactNormal's BodyID/SubShapeID/Vec3 args and
//   the returned surface normal, plus AdvancedRaycaster's collector and Multicaster never
//   destroying the Raycaster it owns).
// - issue #48: hit markers were drawn axis-aligned to world space no matter what surface they hit.
// - issue #173 (debug-drawing half): drawDebuggingLine/Points/Marker allocated a brand new
//   THREE.BufferGeometry/Material/Object3D on every single call, so a raycaster that draws its
//   debug view every cast grew `debugObject.children` and leaked three.js resources without bound.

import * as THREE from 'three';
import { assert, beforeAll, beforeEach, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { AdvancedRaycaster, type RaycastHit } from '../src/systems/queries/raycasters';

let ps: PhysicsSystem;
let near: BodyState;
let far: BodyState;

// Two static boxes along +Z from the origin: a "near" one and a "far" one, five units apart, so
// a closest-hit ray fired down +Z hits "near" until it's moved out of the way, at which point it
// must hit "far" instead.
beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('raycasters-test');

    const nearMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    nearMesh.position.set(0, 0, 5);
    near = ps.bodySystem.getBody(ps.bodySystem.addBody(nearMesh, { bodyType: 'static' }))!;

    const farMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    farMesh.position.set(0, 0, 15);
    far = ps.bodySystem.getBody(ps.bodySystem.addBody(farMesh, { bodyType: 'static' }))!;
});

// keep the boxes in their starting positions for every test regardless of what a previous test
// did to them
beforeEach(() => {
    near.position = new THREE.Vector3(0, 0, 5);
    far.position = new THREE.Vector3(0, 0, 15);
});

test('closest raycaster resets between casts instead of returning a stale hit (issue #60)', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 0, -10);
    rc.direction = new THREE.Vector3(0, 0, 30);

    const first = rc.cast() as RaycastHit;
    assert.isDefined(first, 'first cast found nothing');
    assert.closeTo(first.position.z, 4.5, 0.5, 'first cast should hit the near box');

    // move the near box out of the way and cast again from the SAME raycaster instance (type
    // stays "closest"). Before the fix the collector's HadHit()/early-out fraction never
    // cleared, so this cast returned the stale near-box hit instead of re-querying and finding
    // the far box.
    near.position = new THREE.Vector3(20, 0, 5);

    const second = rc.cast() as RaycastHit;
    assert.isDefined(second, 'second cast found nothing - collector was not reset');
    assert.closeTo(second.position.z, 14.5, 0.5, 'second cast should now hit the far box');

    rc.destroy();
});

test('"all" collector returns both boxes', () => {
    const rc = ps.getRaycaster();
    rc.setCollector('all');
    rc.origin = new THREE.Vector3(0, 0, -10);
    rc.direction = new THREE.Vector3(0, 0, 30);

    const hits = rc.cast() as RaycastHit[];
    assert.isArray(hits);
    assert.equal(hits.length, 2, 'expected both boxes to be hit');

    rc.destroy();
});

test('AdvancedRaycaster casts without throwing (JSImplementation members were missing)', () => {
    const arc = new AdvancedRaycaster(ps.physicsSystem, ps.joltInterface);
    arc.origin = new THREE.Vector3(0, 0, -10);
    arc.direction = new THREE.Vector3(0, 0, 30);

    let bodySeen = false;
    let hitSeen = false;
    arc.onBody(() => {
        bodySeen = true;
    });
    arc.addHit(() => {
        hitSeen = true;
    });

    assert.doesNotThrow(() => arc.cast());
    assert.isTrue(bodySeen, 'OnBody was never invoked');
    assert.isTrue(hitSeen, 'AddHit was never invoked');

    // a second cast exercises collector.Reset(), which used to run into the same
    // "must implement all functions" problem when nothing had installed it
    assert.doesNotThrow(() => arc.cast());

    arc.destroy();
});

test('a freshly built AdvancedRaycaster casts without throwing even with no handlers registered', () => {
    // regression guard for the JSImplementation defaults: OnBody/AddHit/Reset must exist as own
    // properties from construction, before onBody()/addHit()/onReset() are ever called.
    const arc = new AdvancedRaycaster(ps.physicsSystem, ps.joltInterface);
    arc.origin = new THREE.Vector3(0, 0, -10);
    arc.direction = new THREE.Vector3(0, 0, 30);

    assert.doesNotThrow(() => arc.cast());
    assert.doesNotThrow(() => arc.cast());

    arc.destroy();
});

test('allocation count is stable across repeated casts', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 0, -10);
    rc.direction = new THREE.Vector3(0, 0, 30);

    const exercise = () => {
        const hit = rc.cast() as RaycastHit | undefined;
        // impactNormal is where the leak lived: BodyID/SubShapeID/Vec3 allocated and never
        // freed on every access
        hit?.impactNormal;
    };

    // `tracker.outstanding()` is (every `new Raw.module.X()` we observed) minus (every
    // `Raw.module.destroy()` call we observed). RRayCast.GetPointOnRay and
    // Body.GetWorldSpaceSurfaceNormal both return a Vec3/RVec3 BY VALUE through jolt-physics'
    // WebIDL binder, which hands back a pointer to a shared static temporary rather than a fresh
    // heap allocation - raycasters.ts correctly never `destroy()`s those (see the comments in
    // RaycastHit), so they don't show up on either side of this count. What must NOT happen is
    // "outstanding" trending upward: every `new` we can see here (BodyID/SubShapeID/RVec3 in
    // impactNormal) is something our own source allocated, and in leak-free code it always ends
    // up destroyed - growth means one of those is never being freed, which is exactly what the
    // old unfreed BodyID/SubShapeID/Vec3 in impactNormal did.
    const tracker = trackAllocations();
    // warm up so any one-time lazy setup inside jolt-physics happens before we start measuring
    for (let i = 0; i < 10; i++) exercise();
    const baseline = tracker.outstanding();

    for (let i = 0; i < 50; i++) exercise();
    const afterFirstBatch = tracker.outstanding();
    for (let i = 0; i < 50; i++) exercise();
    const afterSecondBatch = tracker.outstanding();

    tracker.restore();
    rc.destroy();

    assert.isAtMost(
        afterFirstBatch,
        baseline,
        `outstanding Jolt allocations grew from ${baseline} to ${afterFirstBatch} over 50 casts - something is leaking every cast`
    );
    assert.isAtMost(
        afterSecondBatch,
        afterFirstBatch,
        `outstanding Jolt allocations grew from ${afterFirstBatch} to ${afterSecondBatch} over 50 more casts - something is leaking every cast`
    );
});

test('drawMarker orients the marker along the hit surface normal (issue #48)', () => {
    // A box tilted around X so the face the ray (fired along +Z) hits has a normal with a
    // nonzero Y component - i.e. NOT the world-space (0, 0, -1)/(0, 1, 0)/etc. axis alignment the
    // old marker always drew regardless of what it hit.
    const tiltedMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    tiltedMesh.position.set(0, 0, 25);
    tiltedMesh.rotation.set(Math.PI / 6, 0, 0);
    const tilted = ps.bodySystem.getBody(
        ps.bodySystem.addBody(tiltedMesh, { bodyType: 'static' })
    )!;

    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 0, 20);
    rc.direction = new THREE.Vector3(0, 0, 10);
    const hit = rc.cast() as RaycastHit;
    assert.isDefined(hit, 'expected the tilted box to be hit');

    const normal = hit.impactNormal.clone().normalize();
    // sanity check: the tilt must have actually knocked the normal off the world Z axis, or this
    // test would pass even against the old, always-axis-aligned marker code
    assert.isAbove(
        Math.abs(normal.y),
        0.05,
        'expected the tilted box to produce a non-axis-aligned surface normal'
    );

    rc.initDebugging(new THREE.Scene());
    const marker = rc.drawMarker(hit);

    const expected = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    assert.approximately(marker.quaternion.x, expected.x, 1e-6, 'marker quaternion x');
    assert.approximately(marker.quaternion.y, expected.y, 1e-6, 'marker quaternion y');
    assert.approximately(marker.quaternion.z, expected.z, 1e-6, 'marker quaternion z');
    assert.approximately(marker.quaternion.w, expected.w, 1e-6, 'marker quaternion w');

    rc.destroy();
    tilted.destroy();
});

test('repeated drawMarker calls reuse the pooled marker instead of growing the scene graph or reallocating geometry (issue #173)', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 0, -10);
    rc.direction = new THREE.Vector3(0, 0, 30);
    const hit = rc.cast() as RaycastHit;
    assert.isDefined(hit, 'setup cast found nothing');

    rc.initDebugging(new THREE.Scene());

    const first = rc.drawMarker(hit);
    const childCountAfterFirst = rc.debugObject.children.length;
    const ringGeometry = (first.children[0] as THREE.LineLoop).geometry;
    const normalGeometry = (first.children[1] as THREE.Line).geometry;

    for (let i = 0; i < 25; i++) {
        const marker = rc.drawMarker(hit);
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
            rc.debugObject.children.length,
            childCountAfterFirst,
            'debugObject.children grew from a repeated drawMarker call'
        );
    }

    rc.destroy();
});

test('cast()-driven debug drawing does not grow the scene graph across repeated casts (issue #173)', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 0, -10);
    rc.direction = new THREE.Vector3(0, 0, 30);

    rc.initDebugging(new THREE.Scene());
    rc.drawPoints = true;
    rc.drawMarkers = true;

    rc.cast();
    const childCountAfterFirst = rc.debugObject.children.length;
    assert.isAbove(childCountAfterFirst, 0, 'expected the debug line/points/marker to be drawn');

    for (let i = 0; i < 25; i++) rc.cast();

    assert.strictEqual(
        rc.debugObject.children.length,
        childCountAfterFirst,
        'debugObject.children grew across repeated cast() calls with debugging enabled'
    );

    rc.destroy();
});

// Minimal allocation spy: wraps every embind class constructor hanging off `Raw.module`
// (everything capitalized, per jolt-physics' naming convention) plus `Raw.module.destroy`, so we
// can assert created === destroyed ("outstanding" allocations) rather than trusting that every
// `destroy()` call in the source was the *correct* one.
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
