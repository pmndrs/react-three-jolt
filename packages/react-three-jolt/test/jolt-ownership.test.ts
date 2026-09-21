// Issue #76: `vec3.jolt()` / `vec3.rjolt()` / `quat.jolt()` used to return the caller's own Jolt
// object when handed one, and ~14 call sites then destroyed the result - freeing memory Jolt (or
// the caller) still owned. These tests pin the ownership contract down and, through the
// allocation tracker, prove the hot setters neither leak nor double free.

import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import {
    generateJoltMatrix,
    joltScratch,
    quat,
    vec3,
    withJolt,
    withQuat,
    withRJolt
} from '../src/utils';
import { type AllocTracker, DEFAULT_TRACKED_TYPES, installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;
let box: BodyState;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('ownership');
    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floorMesh.position.set(0, -1, 0);
    ps.bodySystem.addBody(floorMesh, { bodyType: 'static' });

    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    boxMesh.position.set(0, 5, 0);
    box = ps.bodySystem.getBody(ps.bodySystem.addBody(boxMesh))!;
});

describe('helper ownership', () => {
    test('never return the object they were handed', () => {
        const source = new Raw.module.Vec3(1, 2, 3);
        const rsource = new Raw.module.RVec3(1, 2, 3);
        const qsource = new Raw.module.Quat(0, 0, 0, 1);

        const v = vec3.jolt(source);
        const rv = vec3.rjolt(rsource);
        const q = quat.jolt(qsource);

        assert.notStrictEqual(v, source, 'vec3.jolt returned its argument');
        assert.notStrictEqual(rv, rsource, 'vec3.rjolt returned its argument');
        assert.notStrictEqual(q, qsource, 'quat.jolt returned its argument');
        // different wrappers are not enough - they have to be different heap objects
        assert.notEqual(Raw.module.getPointer(v), Raw.module.getPointer(source));
        assert.notEqual(Raw.module.getPointer(rv), Raw.module.getPointer(rsource));
        assert.notEqual(Raw.module.getPointer(q), Raw.module.getPointer(qsource));
        // and they have to be clones, not blanks
        assert.deepEqual([v.GetX(), v.GetY(), v.GetZ()], [1, 2, 3]);
        assert.deepEqual([rv.GetX(), rv.GetY(), rv.GetZ()], [1, 2, 3]);
        assert.deepEqual([q.GetX(), q.GetY(), q.GetZ(), q.GetW()], [0, 0, 0, 1]);

        // mutating the clone must not touch the source
        v.Set(9, 9, 9);
        assert.equal(source.GetX(), 1);

        for (const o of [source, rsource, qsource, v, rv, q]) Raw.module.destroy(o);
    });

    test('cross convert between Vec3 and RVec3 without aliasing', () => {
        const source = new Raw.module.Vec3(4, 5, 6);
        const rv = vec3.rjolt(source);
        const v = vec3.jolt(rv);
        assert.notStrictEqual(rv, source);
        assert.notStrictEqual(v, rv);
        assert.deepEqual([v.GetX(), v.GetY(), v.GetZ()], [4, 5, 6]);
        for (const o of [source, rv, v]) Raw.module.destroy(o);
    });

    test('zero is a real component, not "no argument"', () => {
        const v = vec3.jolt(0, 1, 2);
        const rv = vec3.rjolt(0, 1, 2);
        assert.deepEqual([v.GetX(), v.GetY(), v.GetZ()], [0, 1, 2]);
        assert.deepEqual([rv.GetX(), rv.GetY(), rv.GetZ()], [0, 1, 2]);

        const t = vec3.three(0, 1, 2);
        assert.deepEqual([t.x, t.y, t.z], [0, 1, 2]);

        const fromTuple = vec3.jolt([0, 1, 2]);
        assert.deepEqual([fromTuple.GetX(), fromTuple.GetY(), fromTuple.GetZ()], [0, 1, 2]);

        for (const o of [v, rv, fromTuple]) Raw.module.destroy(o);
    });

    test('nil input is a defined value rather than a throw', () => {
        // `quat.jolt(undefined)` used to throw, which is why body-state hand rolled a fallback
        const q = quat.jolt(undefined as never);
        assert.deepEqual([q.GetX(), q.GetY(), q.GetZ(), q.GetW()], [0, 0, 0, 1]);
        const v = vec3.jolt(undefined as never);
        assert.deepEqual([v.GetX(), v.GetY(), v.GetZ()], [0, 0, 0]);
        Raw.module.destroy(q);
        Raw.module.destroy(v);
    });

    test('the three.js side never allocates or frees the input', () => {
        const source = new Raw.module.Vec3(7, 8, 9);
        const out = new THREE.Vector3();
        assert.strictEqual(vec3.three(source, undefined, undefined, out), out);
        assert.deepEqual([out.x, out.y, out.z], [7, 8, 9]);
        // reading it again proves the input survived
        assert.equal(source.GetX(), 7);
        Raw.module.destroy(source);

        const qsource = new Raw.module.Quat(0, 0, 0, 1);
        const qout = new THREE.Quaternion();
        assert.strictEqual(quat.three(qsource, qout), qout);
        assert.equal(qsource.GetW(), 1);
        Raw.module.destroy(qsource);
    });
});

describe('allocation accounting', () => {
    let alloc: AllocTracker;

    const withTracker = (fn: (alloc: AllocTracker) => void, options = {}) => {
        alloc = installAllocTracker(Raw, options);
        try {
            fn(alloc);
        } finally {
            alloc.uninstall();
        }
    };

    test('the tracker catches a double destroy', () => {
        withTracker((tracker) => {
            const v = new Raw.module.Vec3(1, 1, 1);
            assert.equal(tracker.live(), 1);
            Raw.module.destroy(v);
            assert.equal(tracker.live(), 0);
            // embind itself does NOT throw here, it silently frees the block a second time
            expect(() => Raw.module.destroy(v)).toThrow(/double destroy/);
        });
    });

    test('the old passthrough behaviour would be caught', () => {
        withTracker(() => {
            const owned = new Raw.module.Vec3(1, 2, 3);
            // what `vec3.jolt` used to do: `return vec as Jolt.Vec3`
            const passthrough = owned as unknown as typeof owned;
            Raw.module.destroy(passthrough);
            expect(() => Raw.module.destroy(owned)).toThrow(/double destroy/);
        });

        // and what it does now: a clone, so both frees are legal
        withTracker((tracker) => {
            const owned = new Raw.module.Vec3(1, 2, 3);
            const clone = vec3.jolt(owned);
            Raw.module.destroy(clone);
            Raw.module.destroy(owned);
            assert.equal(tracker.live(), 0);
        });
    });

    test('scoped helpers leave nothing behind, even when the body throws', () => {
        withTracker((tracker) => {
            const before = tracker.live();
            const length = withJolt([3, 4, 0], (v) => v.Length());
            assert.equal(length, 5);
            withRJolt(new THREE.Vector3(1, 2, 3), (v) => assert.equal(v.GetZ(), 3));
            withQuat(new THREE.Quaternion(), (q) => assert.equal(q.GetW(), 1));
            assert.equal(tracker.live(), before);

            expect(() =>
                withJolt([1, 2, 3], () => {
                    throw new Error('boom');
                })
            ).toThrow('boom');
            assert.equal(tracker.live(), before, 'withJolt leaked when the callback threw');
        });
    });

    test('generateJoltMatrix allocates exactly one object per call and no temporaries', () => {
        withTracker((tracker) => {
            // warm the shared scratch objects, which are (re)built per Jolt module
            Raw.module.destroy(generateJoltMatrix(new THREE.Vector3(), new THREE.Quaternion()));

            const before = tracker.live();
            const allocatedBefore = tracker.allocated();
            const foreignBefore = tracker.foreignDestroys();
            for (let i = 0; i < 100; i++) {
                const m = generateJoltMatrix(new THREE.Vector3(i, i, i), new THREE.Quaternion());
                assert.equal(m.GetTranslation().GetX(), i);
                Raw.module.destroy(m);
            }
            assert.equal(tracker.live(), before, 'generateJoltMatrix leaked');
            // one RMat44 per call and nothing else: the position/rotation temporaries are
            // shared scratch objects now
            assert.equal(tracker.allocated() - allocatedBefore, 100);
            // and nothing that the binder owns was freed
            assert.equal(tracker.foreignDestroys(), foreignBefore);
        });
    });

    test('the matrix it returns is a copy, not the binder’s static temporary', () => {
        // `Jolt.RMat44.prototype.sRotationTranslation()` returns the same pointer on every call
        // (WebIDL binder value return), so a stored transform used to be silently rewritten by
        // the next caller - and destroying it freed memory the binder owns.
        const first = generateJoltMatrix(new THREE.Vector3(1, 2, 3), new THREE.Quaternion());
        const second = generateJoltMatrix(new THREE.Vector3(4, 5, 6), new THREE.Quaternion());
        assert.notEqual(Raw.module.getPointer(first), Raw.module.getPointer(second));
        assert.deepEqual(
            [first.GetTranslation().GetX(), first.GetTranslation().GetY()],
            [1, 2],
            'the first matrix was overwritten by the second call'
        );
        const rotated = generateJoltMatrix(
            new THREE.Vector3(0, 0, 0),
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
        );
        // x axis rotated 90 degrees about y points down -z
        assert.closeTo(rotated.GetAxisX().GetZ(), -1, 1e-5);
        for (const m of [first, second, rotated]) Raw.module.destroy(m);
    });

    test('the shape collider does not leak a transform per frame', () => {
        withTracker((tracker) => {
            const collider = ps.getShapeCollider();
            collider.position = new THREE.Vector3(0, 1, 0);
            const before = tracker.live();
            for (let i = 0; i < 50; i++) collider.position = new THREE.Vector3(0, i, 0);
            assert.equal(tracker.live(), before, 'setJoltMatrix leaked a transform per call');
            assert.equal(collider.centerOfMassTransform.GetTranslation().GetY(), 49);
        });
    });

    test('a shapecast rebuild neither leaks nor frees what the binder owns', () => {
        withTracker(
            (tracker) => {
                // built inside the tracker so every object it rebuilds per call is accounted for
                const sc = ps.getShapecaster();
                sc.origin = new THREE.Vector3(0, 20, 0);
                const before = tracker.live();
                const foreignBefore = tracker.foreignDestroys();
                for (let i = 0; i < 20; i++) sc.origin = new THREE.Vector3(0, 20 + i, 0);
                assert.equal(tracker.live(), before, 'setOrigin leaked');
                assert.equal(
                    tracker.foreignDestroys(),
                    foreignBefore,
                    'setOrigin destroyed something it did not allocate'
                );
            },
            { types: [...DEFAULT_TRACKED_TYPES, 'RShapeCast'] }
        );
    });
});

describe('BodyState setters', () => {
    // Each setter is called once before measuring: the very first call builds the shared scratch
    // objects for this Jolt module, which is a one time allocation.
    const setterCases: [string, () => void][] = [
        ['position', () => (box.position = new THREE.Vector3(0, 4, 0))],
        ['rotation', () => (box.rotation = new THREE.Quaternion(0, 0, 0, 1))],
        ['velocity', () => (box.velocity = new THREE.Vector3(0, 1, 0))],
        ['angularVelocity', () => (box.angularVelocity = new THREE.Vector3(0, 1, 0))],
        ['scale', () => (box.scale = new THREE.Vector3(1, 1, 1))],
        ['applyForce', () => box.applyForce(new THREE.Vector3(0, 1, 0))],
        ['applyTorque', () => box.applyTorque(new THREE.Vector3(0, 1, 0))],
        ['addImpulse', () => box.addImpulse(new THREE.Vector3(0, 1, 0))],
        [
            'moveKinematic',
            () => box.moveKinematic(new THREE.Vector3(0, 4, 0), new THREE.Quaternion(), 1 / 60)
        ],
        [
            'moveKinematic without a rotation',
            () => box.moveKinematic(new THREE.Vector3(0, 4, 0), undefined as never, 1 / 60)
        ],
        ['setPositionAndRotation', () => box.setPositionAndRotation(box.position, box.rotation)]
    ];

    for (const [name, call] of setterCases) {
        test(`${name} leaves the live allocation count unchanged`, () => {
            call();
            const alloc = installAllocTracker(Raw);
            try {
                call(); // warm up under the tracked module
                const before = alloc.live();
                for (let i = 0; i < 10; i++) call();
                assert.equal(
                    alloc.live(),
                    before,
                    `${name} leaked ${alloc.live() - before} objects over 10 calls: ` +
                        JSON.stringify(alloc.liveByType())
                );
            } finally {
                alloc.uninstall();
            }
        });
    }

    test('the body still moves after all of that', () => {
        box.position = new THREE.Vector3(0, 6, 0);
        box.velocity = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
        assert.isBelow(box.position.y, 6, 'box did not fall');
    });

    test('impact normals do not leak the position they are queried with', () => {
        const rc = ps.getRaycaster();
        rc.origin = new THREE.Vector3(0, 20, 0);
        rc.direction = new THREE.Vector3(0, -40, 0);
        rc.cast();
        assert.isAbove(rc.hits.length, 0);

        const alloc = installAllocTracker(Raw);
        try {
            rc.hits[0].impactNormal;
            const before = alloc.live();
            for (let i = 0; i < 10; i++) {
                const normal = rc.hits[0].impactNormal;
                assert.isFinite(normal.y);
            }
            assert.equal(alloc.live(), before, 'impactNormal leaked a vector per read');
        } finally {
            alloc.uninstall();
        }
    });

    test('joltScratch survives a module swap', () => {
        const first = joltScratch.vec3(1, 2, 3);
        assert.equal(first.GetX(), 1);
        const alloc = installAllocTracker(Raw);
        try {
            // a different module object means the old scratch belongs to a heap we no longer use
            const second = joltScratch.vec3(4, 5, 6);
            assert.notStrictEqual(second, first);
            assert.equal(second.GetY(), 5);
        } finally {
            alloc.uninstall();
        }
    });
});
