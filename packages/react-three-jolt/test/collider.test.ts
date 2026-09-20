// ShapeCollider used to leak every Jolt object it created (destroy() was `{}`) and additionally
// leaked a brand new RMat44 every time its position/rotation were set - which CameraBoom does
// every frame via checkCollision(). These tests exercise the real WASM module (no mocks) to prove
// the query still works, that destroy() actually frees everything, and that the hot per-frame
// path (setJoltMatrix -> cast) allocates nothing.

import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { ShapeCollider } from '../src/systems/queries/collider';

// ---------------------------------------------------------------------------------------------
// Minimal local allocation tracker.
//
// embind gives no way to ask "how many objects are alive"; this wraps a curated set of
// `Raw.module` constructors (and `destroy`) in a Proxy so a test can assert the net Jolt
// allocation count of some operation is zero. Only `new Raw.module.X()` calls go through the
// wrapped constructors - by-value returns from Jolt methods (e.g. `Mat44.prototype.sRotation()`)
// are pointers to static temporaries owned by the WebIDL binder and never touch `new`, so they
// correctly never show up here (and must never be passed to `destroy()`).
//
// Shape classes (SphereShape, BoxShape, ...) are deliberately NOT tracked: their lifecycle is
// reference counted (AddRef/Release), not new/destroy, so a naive live-count would never go back
// to zero even though the object is genuinely freed once its refcount hits zero. Shape ownership
// is asserted separately below via GetRefCount().
// ---------------------------------------------------------------------------------------------
const TRACKED_TYPES = [
    'Vec3',
    'RVec3',
    'Quat',
    'Mat44',
    'RMat44',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'CollideShapeSettings',
    'CollideShapeClosestHitCollisionCollector',
    'CollideShapeAnyHitCollisionCollector',
    'CollideShapeAllHitCollisionCollector'
];

type RawHolder = { module: any };

function installAllocTracker(raw: RawHolder, types: string[] = TRACKED_TYPES) {
    const target = raw.module;
    const live = new Map<number, string>();
    const ctorProxies = new Map<string, unknown>();
    let doubleDestroyed = false;

    const pointerOf = (obj: unknown): number => {
        try {
            return target.getPointer(obj);
        } catch {
            return -1;
        }
    };

    const wrapCtor = (name: string) => {
        const existing = ctorProxies.get(name);
        if (existing) return existing;
        const ctor = target[name];
        if (typeof ctor !== 'function') return ctor;
        const proxy = new Proxy(ctor, {
            construct(ctorTarget: any, args: any[]) {
                const instance = new ctorTarget(...args);
                const ptr = pointerOf(instance);
                if (ptr > 0) live.set(ptr, name);
                return instance;
            }
        });
        ctorProxies.set(name, proxy);
        return proxy;
    };

    const proxy = new Proxy(target, {
        get(moduleTarget: any, prop: string | symbol, receiver: unknown) {
            if (prop === 'destroy') {
                return (obj: unknown) => {
                    const ptr = pointerOf(obj);
                    if (ptr > 0) {
                        if (!live.has(ptr)) doubleDestroyed = true;
                        live.delete(ptr);
                    }
                    return moduleTarget.destroy(obj);
                };
            }
            if (typeof prop === 'string' && types.includes(prop)) return wrapCtor(prop);
            return Reflect.get(moduleTarget, prop, receiver);
        }
    });

    raw.module = proxy;

    return {
        live: () => live.size,
        wasDoubleDestroyed: () => doubleDestroyed,
        uninstall: () => {
            raw.module = target;
        }
    };
}

// ---------------------------------------------------------------------------------------------

let ps: PhysicsSystem;
const boxPosition = new THREE.Vector3(0, 5, 0);
const farAway = new THREE.Vector3(500, 500, 500);

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('shape-collider-test');

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floorMesh.position.set(0, -1, 0);
    ps.bodySystem.addBody(floorMesh, { bodyType: 'static' });

    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    boxMesh.position.copy(boxPosition);
    ps.bodySystem.addBody(boxMesh, { bodyType: 'static' });
});

function makeCollider() {
    const collider = new ShapeCollider(ps.physicsSystem, ps.joltInterface);
    // replace the default 0.3 radius sphere with one guaranteed to overlap the test box when
    // positioned at its center
    collider.shape = new Raw.module.SphereShape(0.5);
    return collider;
}

describe('ShapeCollider', () => {
    test('reports a hit when the shape overlaps a body', () => {
        const collider = makeCollider();
        collider.position = boxPosition.clone();
        const result = collider.cast();
        expect(result).toBeTruthy();
        collider.destroy();
    });

    test('reports no hit once moved away', () => {
        const collider = makeCollider();
        collider.position = farAway.clone();
        const result = collider.cast();
        expect(result).toBe(false);
        collider.destroy();
    });

    test('destroy() is idempotent and never throws', () => {
        const collider = makeCollider();
        collider.position = boxPosition.clone();
        collider.cast();
        expect(() => collider.destroy()).not.toThrow();
        expect(() => collider.destroy()).not.toThrow();
        expect(() => collider.destroy()).not.toThrow();
    });

    test('destroy() frees every Jolt object the collider allocated', () => {
        const tracker = installAllocTracker(Raw);
        try {
            const baseline = tracker.live();
            const collider = new ShapeCollider(ps.physicsSystem, ps.joltInterface);
            // sanity check: constructing really does allocate tracked objects (collector,
            // settings, filters, baseOffset, matrix, scratch position/rotation)
            expect(tracker.live()).toBeGreaterThan(baseline);

            collider.position = boxPosition.clone();
            collider.rotation = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                0.3
            );
            collider.cast();

            collider.destroy();
            expect(tracker.live()).toBe(baseline);
            expect(tracker.wasDoubleDestroyed()).toBe(false);
        } finally {
            tracker.uninstall();
        }
    });

    test('200 setJoltMatrix + collide calls leave net live allocations at 0', () => {
        const collider = makeCollider();
        // warm up so the collider's persistent scratch objects already exist before we start
        // counting - we're only trying to catch allocations from the per-call/per-frame path.
        collider.position = boxPosition.clone();
        collider.cast();

        const tracker = installAllocTracker(Raw);
        try {
            const baseline = tracker.live();
            for (let i = 0; i < 200; i++) {
                collider.position = new THREE.Vector3(
                    boxPosition.x + (i % 2 === 0 ? 0 : 0.01),
                    boxPosition.y,
                    boxPosition.z
                );
                collider.rotation = new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(0, 1, 0),
                    i * 0.001
                );
                collider.cast();
            }
            expect(tracker.live()).toBe(baseline);
            expect(tracker.wasDoubleDestroyed()).toBe(false);
        } finally {
            tracker.uninstall();
        }
        collider.destroy();
    });

    test('shape ownership: AddRef()s on set, Release()s on replace and on destroy', () => {
        const collider = new ShapeCollider(ps.physicsSystem, ps.joltInterface);

        // give the test its own reference to a shape, independent of the collider, so we can
        // freely inspect its refcount without ever operating on memory that has already been
        // freed by a Release() dropping to 0.
        const customShape = new Raw.module.SphereShape(0.4);
        customShape.AddRef();
        assert.equal(customShape.GetRefCount(), 1);

        collider.shape = customShape;
        // the collider took its own reference on top of the test's
        assert.equal(customShape.GetRefCount(), 2);
        assert.strictEqual(collider.shape, customShape);

        collider.destroy();
        // destroy() released the collider's reference; the test's own reference keeps it alive
        assert.equal(customShape.GetRefCount(), 1);

        // release the test's own reference last
        customShape.Release();
    });
});
