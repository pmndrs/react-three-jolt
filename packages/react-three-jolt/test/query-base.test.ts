// Runtime coverage for packages/react-three-jolt/src/systems/queries/query-base.ts (issue #154):
// the shared QueryBase/CastQueryBase/HitBase machinery every concrete query type (Raycaster,
// AdvancedRaycaster, Multicaster, Shapecaster, ShapeCollider) now extends instead of re-declaring
// its own copy of the filters/physicsSystem wiring/destroy pattern/debug-drawing pool.
//
// This does not re-test behavior already covered by raycasters.test.ts/shapecasters.test.ts/
// collider.test.ts (closest-hit reset, marker orientation, per-cast debug-drawing pooling, shape
// ref-counting, ...) - it specifically targets the two things that only make sense to assert once
// the shared base exists:
// - every concrete class' destroy() is idempotent and returns the allocation tracker to exactly
//   its pre-construction baseline (the QueryBase.destroy()/releaseResources() template).
// - turning isDebugging on allocates exactly the pooled THREE.js debug-drawing resources
//   (CastQueryBase's pool), and destroy() disposes exactly those, once, even if destroy() is
//   called again afterwards.

import * as THREE from 'three';
import { assert, beforeAll, expect, test, vi } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { ShapeCollider } from '../src/systems/queries/collider';
import { AdvancedRaycaster, Multicaster, Raycaster } from '../src/systems/queries/raycasters';
import { Shapecaster } from '../src/systems/queries/shapecasters';
import { generateJoltMatrix } from '../src/utils';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('query-base-test');

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
    mesh.position.set(0, 0, 10);
    ps.bodySystem.addBody(mesh, { bodyType: 'static' });
});

// Union of every native constructor name any of the five query types can allocate. A narrow,
// explicit list (rather than jolt-alloc.ts's DEFAULT_TRACKED_TYPES) so ref-counted Shape types -
// whose lifecycle is AddRef()/Release(), not new/destroy - never get pulled in and produce a
// false "leak" (see collider.test.ts/shapecasters.test.ts for the same reasoning).
const QUERY_TRACKED_TYPES = [
    'Vec3',
    'RVec3',
    'Quat',
    'Mat44',
    'RMat44',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'RRayCast',
    'RayCastSettings',
    'CastRayClosestHitCollisionCollector',
    'CastRayAnyHitCollisionCollector',
    'CastRayAllHitCollisionCollector',
    'CastRayCollectorJS',
    'ShapeCastSettings',
    'RShapeCast',
    'CastShapeClosestHitCollisionCollector',
    'CastShapeAnyHitCollisionCollector',
    'CastShapeAllHitCollisionCollector',
    'CollideShapeSettings',
    'CollideShapeClosestHitCollisionCollector',
    'CollideShapeAnyHitCollisionCollector',
    'CollideShapeAllHitCollisionCollector'
];

const trackQueryAllocations = () =>
    installAllocTracker(Raw, { types: QUERY_TRACKED_TYPES, throwOnDoubleDestroy: false });

// `installAllocTracker` swaps `Raw.module`'s identity, which rebuilds `joltScratch`'s shared
// RVec3/Quat singletons (used by generateJoltMatrix(), which Shapecaster's initializeShapecast()
// and ShapeCollider's setJoltMatrix() both call) exactly once against the tracked module - warm
// that up and throw it away before measuring, the same way shapecasters.test.ts does, or that
// one-time rebuild would be misread as a leak from the query under test.
const warmJoltScratch = () => {
    Raw.module.destroy(generateJoltMatrix(new THREE.Vector3(), new THREE.Quaternion()));
};

type Destroyable = { destroy(): void };

// Every concrete query type extends QueryBase, so every one of them gets the same
// destroy()/releaseResources() template (issue #154) - assert it uniformly instead of duplicating
// this per class.
const destroyReturnsToBaseline = (name: string, build: () => Destroyable) => {
    test(`${name}.destroy() returns the allocation tracker to baseline (issue #154)`, () => {
        const tracker = trackQueryAllocations();
        try {
            warmJoltScratch();
            const baseline = tracker.live();

            const instance = build();
            expect(
                tracker.live(),
                `${name} construction should have allocated tracked jolt objects`
            ).toBeGreaterThan(baseline);

            instance.destroy();
            expect(tracker.live(), `${name}.destroy() left allocations behind`).toBe(baseline);
            expect(
                tracker.foreignDestroys(),
                `${name}.destroy() freed a pointer it never allocated (double free or a by-value static temporary)`
            ).toBe(0);

            // destroy() must be idempotent (QueryBase's `destroyed` guard) - a second call must
            // neither throw nor double-free anything already freed by the first call.
            assert.doesNotThrow(() => instance.destroy());
            expect(tracker.live(), `a second ${name}.destroy() call changed live allocations`).toBe(
                baseline
            );
        } finally {
            tracker.uninstall();
        }
    });
};

destroyReturnsToBaseline('Raycaster', () => new Raycaster(ps.physicsSystem, ps.joltInterface));
destroyReturnsToBaseline(
    'AdvancedRaycaster',
    () => new AdvancedRaycaster(ps.physicsSystem, ps.joltInterface)
);
destroyReturnsToBaseline('Multicaster', () => new Multicaster(ps.physicsSystem, ps.joltInterface));
destroyReturnsToBaseline('Shapecaster', () => new Shapecaster(ps.physicsSystem, ps.joltInterface));
destroyReturnsToBaseline(
    'ShapeCollider',
    () => new ShapeCollider(ps.physicsSystem, ps.joltInterface)
);

// The pooled debug-drawing resources (CastQueryBase._debugLine/_debugPoints/_markerPool and their
// backing geometry/material) are only ever created lazily, the first time isDebugging draws
// something, and only ever disposed by _disposeDebugResources() (called from destroy() and
// clearDebugging()). Spying on the THREE.js dispose() methods directly - rather than jolt's
// allocation tracker, which has no visibility into three.js objects - lets this assert the pool is
// created exactly once and disposed exactly once, regardless of how many casts run in between.
const debugPoolCreatesAndDisposesExactlyOnce = (
    name: string,
    build: () => Raycaster | Shapecaster
) => {
    test(`${name}: isDebugging creates the pooled debug resources once and destroy() disposes them exactly once (issue #154)`, () => {
        const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
        const materialDisposeSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
        try {
            const query = build();
            query.origin = new THREE.Vector3(0, 0, -10);
            query.direction = new THREE.Vector3(0, 0, 30);
            query.drawPoints = true;
            query.drawMarkers = true;
            query.initDebugging(new THREE.Scene());

            // Exactly the pool this cast should populate: the debug line, the debug points cloud,
            // and (since the cast above hits the box added in beforeAll) one pooled marker group -
            // line geometry/material, points geometry/material, marker ring geometry/material and
            // marker normal geometry/material. The ring/normal geometry+material are shared across
            // every pooled marker, so this count does not grow with the number of hits.
            const hit = query.cast();
            assert.isDefined(hit, 'setup cast found nothing to build a marker pool from');
            const expectedPooledResources = 8;

            // Repeated casts must reuse the same pool (issues #173/#192) - dispose() must not be
            // called again just from drawing more frames.
            for (let i = 0; i < 10; i++) query.cast();
            expect(
                geometryDisposeSpy.mock.calls.length + materialDisposeSpy.mock.calls.length,
                'repeated casts disposed pooled debug resources instead of only ever creating them once'
            ).toBe(0);

            query.destroy();
            expect(
                geometryDisposeSpy.mock.calls.length + materialDisposeSpy.mock.calls.length,
                `destroy() should dispose exactly the ${expectedPooledResources} pooled debug-drawing resources isDebugging created`
            ).toBe(expectedPooledResources);

            // destroy() is idempotent - a second call must not dispose (or otherwise touch)
            // anything a second time.
            query.destroy();
            expect(
                geometryDisposeSpy.mock.calls.length + materialDisposeSpy.mock.calls.length,
                'a second destroy() call disposed pooled debug resources again'
            ).toBe(expectedPooledResources);
        } finally {
            geometryDisposeSpy.mockRestore();
            materialDisposeSpy.mockRestore();
        }
    });
};

debugPoolCreatesAndDisposesExactlyOnce(
    'Raycaster',
    () => new Raycaster(ps.physicsSystem, ps.joltInterface)
);
debugPoolCreatesAndDisposesExactlyOnce(
    'Shapecaster',
    () => new Shapecaster(ps.physicsSystem, ps.joltInterface)
);
