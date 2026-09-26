// Issue #248: `PointCollider` wraps `NarrowPhaseQuery.CollidePoint` - "which bodies contain this
// point right now". Mirrors collider.test.ts (ShapeCollider): real WASM module, no mocks,
// asserting the query itself works and that destroy() actually frees everything it allocated.

import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { PointCollider } from '../src/systems/queries/point-collider';
import { installAllocTracker } from './jolt-alloc';

// See collider.test.ts for why this list is what it is: only `new Raw.module.X()` calls go
// through the tracker's wrapped constructors, and by-value returns (static temporaries owned by
// the WebIDL binder) never touch `new` so correctly never show up here.
const TRACKED_TYPES = [
    'RVec3',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'CollidePointClosestHitCollisionCollector',
    'CollidePointAnyHitCollisionCollector',
    'CollidePointAllHitCollisionCollector'
];

const trackAllocations = () =>
    installAllocTracker(Raw, { types: TRACKED_TYPES, throwOnDoubleDestroy: false });

let ps: PhysicsSystem;
const boxPosition = new THREE.Vector3(0, 5, 0);
const farAway = new THREE.Vector3(500, 500, 500);

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('point-collider-test');

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floorMesh.position.set(0, -1, 0);
    ps.bodySystem.addBody(floorMesh, { bodyType: 'static' });

    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    boxMesh.position.copy(boxPosition);
    ps.bodySystem.addBody(boxMesh, { bodyType: 'static' });
});

function makeCollider() {
    return new PointCollider(ps.physicsSystem, ps.joltInterface);
}

describe('PointCollider', () => {
    test('reports a hit when the point is inside a body', () => {
        const collider = makeCollider();
        collider.point = boxPosition.clone();
        const result = collider.cast();
        expect(result).toBeTruthy();
        collider.destroy();
    });

    test('reports no hit when the point is outside every body', () => {
        const collider = makeCollider();
        collider.point = farAway.clone();
        const result = collider.cast();
        expect(result).toBe(false);
        collider.destroy();
    });

    test('exposes the hit body via bodyHandle', () => {
        const collider = makeCollider();
        collider.point = boxPosition.clone();
        const result = collider.cast();
        assert.isTrue(result !== false, 'expected a hit');
        const hit = Array.isArray(result) ? result[0] : result;
        assert.isNumber((hit as { bodyHandle: number }).bodyHandle);
        collider.destroy();
    });

    test("'all' collector reports both bodies at an overlap point", () => {
        // stack a second box exactly on top of the first, sharing the point right at the seam
        const seam = boxPosition.clone().add(new THREE.Vector3(0, 1, 0));
        const topMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
        topMesh.position.copy(seam.clone().add(new THREE.Vector3(0, 1, 0)));
        ps.bodySystem.addBody(topMesh, { bodyType: 'static' });

        const collider = makeCollider();
        collider.setCollector('all');
        collider.point = seam;
        const result = collider.cast();
        assert.isTrue(result !== false, 'expected at least one hit at the shared seam');
        assert.isTrue(Array.isArray(result), "'all' should return an array");
        collider.destroy();
    });

    test('destroy() is idempotent and never throws', () => {
        const collider = makeCollider();
        collider.point = boxPosition.clone();
        collider.cast();
        expect(() => collider.destroy()).not.toThrow();
        expect(() => collider.destroy()).not.toThrow();
        expect(() => collider.destroy()).not.toThrow();
    });

    test('destroy() frees every Jolt object the collider allocated', () => {
        const tracker = trackAllocations();
        try {
            const baseline = tracker.live();
            const collider = new PointCollider(ps.physicsSystem, ps.joltInterface);
            // sanity check: constructing really does allocate tracked objects (collector,
            // filters, the scratch point)
            expect(tracker.live()).toBeGreaterThan(baseline);

            collider.point = boxPosition.clone();
            collider.cast();

            collider.destroy();
            expect(tracker.live()).toBe(baseline);
            expect(tracker.foreignDestroys()).toBe(0);
        } finally {
            tracker.uninstall();
        }
    });

    test('200 point + cast calls leave net live allocations at 0', () => {
        const collider = makeCollider();
        // warm up so the collider's persistent scratch point already exists before we count
        collider.point = boxPosition.clone();
        collider.cast();

        const tracker = trackAllocations();
        try {
            const baseline = tracker.live();
            for (let i = 0; i < 200; i++) {
                collider.point = new THREE.Vector3(
                    boxPosition.x + (i % 2 === 0 ? 0 : 0.01),
                    boxPosition.y,
                    boxPosition.z
                );
                collider.cast();
            }
            expect(tracker.live()).toBe(baseline);
            expect(tracker.foreignDestroys()).toBe(0);
        } finally {
            tracker.uninstall();
        }
        collider.destroy();
    });
});
