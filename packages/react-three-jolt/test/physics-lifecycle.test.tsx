// World lifecycle: creating, stepping and destroying `PhysicsSystem`s, and what happens when
// React tears a whole `<Physics>` tree down.
//
// Covers issues #162 (PhysicsSystem.destroy() never walked the world), #176 (a fourth world hung
// because the interface cap silently handed it the first world's JoltInterface) and #35 (the
// interface registry that cap lived in).
//
// The headline assertion is `unmounting a whole <Physics> tree ... returns to baseline`: React
// runs a parent's effect cleanup before its children's, so `<Physics>` used to free the world
// out from under every `<RigidBody>`, `useConstraint` and controller below it. That test was
// impossible to write before the teardown was deferred past the commit.

import { create, waitFor } from '@react-three/test-renderer';
import React, { act, useEffect, useRef } from 'react';
import { preload } from 'suspend-react';
import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { InstancedRigidBodyMesh } from '../src/components/InstancedRigidBody';
import { Physics } from '../src/components/Physics';
import { RigidBody } from '../src/components/RigidBody';
import { useConstraint, useJolt, useUnmount } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { flushDeferredWorldDestroys, PhysicsSystem } from '../src/systems/physics-system';
import { joltScratch } from '../src/utils';
import {
    allDestroyableTypes,
    DEFAULT_TRACKED_TYPES,
    expectHeapRestored,
    installAllocTracker
} from './jolt-alloc';

// <Physics> suspends on the async wasm load, which @react-three/test-renderer's create() cannot
// await through Suspense on its own. Pre-resolving it seeds suspend-react's cache so every
// create() below returns synchronously. (Same trick as instanced-rigid-body.test.tsx.)
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

/** WASM heap bytes still free. The ground truth for "did the world really go away". */
const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

/**
 * Live count of the per-frame value types only.
 *
 * `alloc.live()` over the *whole* module cannot balance, and that is not a leak: several Jolt
 * objects are allocated from JS with `new Raw.module.X()` but freed by C++ ownership rather than
 * by `Raw.module.destroy()`, so the tracker never sees them go. The three filter tables handed
 * to `JoltSettings` are freed by the `JoltInterface` destructor, and a `SphereShape` handed to
 * an `RShapeCast` is freed by its `RefConst`. `freeMemory()` below is the assertion that covers
 * those; this one covers everything the library frees by hand.
 */
const valueTypesLive = (alloc: { liveByType(): Record<string, number> }): number => {
    const byType = alloc.liveByType();
    return DEFAULT_TRACKED_TYPES.reduce((total, type) => total + (byType[type] ?? 0), 0);
};

/** Let queued microtasks (including the deferred world teardown) run. */
const settle = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

/** A floor and a box high above it, so a world that steps can be told from one that doesn't. */
function populate(system: PhysicsSystem) {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(100, 1, 100));
    floor.position.set(0, -2, 0);
    system.bodySystem.addBody(floor, { bodyType: 'static' });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.position.set(0, 20, 0);
    return system.bodySystem.getBody(system.bodySystem.addBody(box)) as BodyState;
}

//* Interface lifecycle (#176) ======================================

test('ten worlds can be created and destroyed one after another, and all of them step', () => {
    const baselineFree = freeMemory();
    assert.equal(Raw.interfaceCount, 0, 'a previous test leaked a world');

    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
        const system = new PhysicsSystem(`sequential-${i}`);
        ids.push(system.interfaceId);
        // exactly one world is live at a time, and it is this one
        assert.equal(Raw.interfaceCount, 1);
        assert.strictEqual(Raw.getInterface(system.interfaceId), system.joltInterface);

        const box = populate(system);
        const startY = box.position.y;
        for (let step = 0; step < 30; step++) system.onUpdate(1 / 60);
        assert.isBelow(box.position.y, startY - 0.5, `world ${i} never stepped`);

        system.destroy();
        assert.isTrue(system.destroyed);
        assert.equal(Raw.interfaceCount, 0, `world ${i} did not free its registry slot`);
        assert.isUndefined(Raw.getInterface(ids[i]!));
    }

    // ids are monotonic and never recycled, so a stale id can't resolve to somebody else's world
    assert.deepEqual(
        [...ids].sort((a, b) => a - b),
        ids
    );
    assert.equal(new Set(ids).size, ids.length);

    // every byte the ten worlds took is back
    expectHeapRestored(baselineFree, freeMemory(), 64, 'sequential worlds leaked WASM heap');
});

// The reproduction from #176: four PhysicsSystems alive at once. The old cap of three handed the
// fourth one the *first* world's JoltInterface, so it silently shared bodies with world 1.
test('four worlds can be live at the same time, each with its own interface', () => {
    const baselineFree = freeMemory();
    assert.equal(Raw.interfaceCount, 0, 'a previous test leaked a world');

    const systems = [0, 1, 2, 3].map((i) => new PhysicsSystem(`concurrent-${i}`));
    try {
        assert.equal(Raw.interfaceCount, 4);

        // four distinct interfaces, not one shared four ways
        const pointers = systems.map((s) => Raw.module.getPointer(s.joltInterface));
        assert.equal(new Set(pointers).size, 4, 'worlds are sharing a JoltInterface');

        const boxes = systems.map(populate);
        // one world's bodies must not show up in another's
        for (const system of systems) assert.equal(system.bodySystem.bodies.size, 2);

        const startY = boxes.map((b) => b.position.y);
        for (let step = 0; step < 30; step++) for (const system of systems) system.onUpdate(1 / 60);
        boxes.forEach((box, i) => {
            assert.isBelow(box.position.y, startY[i]! - 0.5, `world ${i} never stepped`);
        });

        // destroying one leaves the other three stepping
        systems[1]!.destroy();
        assert.equal(Raw.interfaceCount, 3);
        const survivorY = boxes[2]!.position.y;
        for (let step = 0; step < 30; step++) systems[2]!.onUpdate(1 / 60);
        assert.isBelow(boxes[2]!.position.y, survivorY, 'destroying a world stopped its neighbour');
    } finally {
        for (const system of systems) system.destroy();
    }

    assert.equal(Raw.interfaceCount, 0);
    // Not an exact match, unlike the sequential test above. jolt-physics itself keeps about
    // 2,912 bytes per *concurrently* live JoltInterface past the first and never gives them
    // back - measured against the bare module with no library code involved:
    //   n=1 -> 0 bytes, n=2 -> 2912, n=3 -> 5824, n=4 -> 8744, n=5 -> 11664
    // (identical whether the interfaces are destroyed in creation or reverse order). The bound
    // here is what matters: nothing of *ours* is proportional to the world's contents.
    assert.isBelow(baselineFree - freeMemory(), 16 * 1024, 'concurrent worlds leaked WASM heap');
});

test('destroy() is idempotent and leaves the world inert', () => {
    const system = new PhysicsSystem('double-destroy');
    const box = populate(system);
    system.onUpdate(1 / 60);

    system.destroy();
    const freeAfterFirst = freeMemory();

    // a second (and third) destroy must not double free anything, and must not throw
    expect(() => system.destroy()).not.toThrow();
    expect(() => system.destroy('some-old-pid')).not.toThrow();
    assert.equal(freeMemory(), freeAfterFirst, 'a second destroy() freed memory again');

    // and stepping a dead world is a no-op rather than a wasm trap
    expect(() => system.onUpdate(1 / 60)).not.toThrow();
    // gravity writes are swallowed too - the effect behind `<Physics gravity>` can fire late
    expect(() => system.setGravity(5)).not.toThrow();
    // ...but anything that would hand out a new WASM object says so out loud
    expect(() => system.getRaycaster()).toThrow(/destroyed PhysicsSystem/);
    void box;
});

test('registered disposables are torn down by destroy(), while the world is still alive', () => {
    const system = new PhysicsSystem('disposables');
    const seen: string[] = [];

    // an object disposable: the shape a controller or camera rig has
    const controllerish = {
        destroy() {
            // the whole point of the ordering: a disposable can still touch jolt
            assert.isFalse(system.destroyed, 'the world was already dead when the disposable ran');
            system.getRaycaster().destroy();
            seen.push('object');
        }
    };
    // ...and a plain function disposable
    const unregisterFn = system.registerDisposable(() => seen.push('function'));
    system.registerDisposable(controllerish);
    assert.equal(system.disposableCount, 2);

    // one that unregisters itself before teardown is not called
    const unregistered = () => seen.push('unregistered');
    system.registerDisposable(unregistered)();
    assert.equal(system.disposableCount, 2);
    void unregisterFn;

    system.destroy();
    assert.deepEqual(seen, ['function', 'object']);
    assert.equal(system.disposableCount, 0);

    // registering against a destroyed world is a no-op that still hands back an unregister
    const late = system.registerDisposable(() => seen.push('late'));
    expect(late).toBeTypeOf('function');
    assert.equal(system.disposableCount, 0);
});

//* React teardown (#162) ===========================================

/** Publishes the live world to the test. */
function Capture({ onReady }: { onReady: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem);
    }, [physicsSystem, onReady]);
    return null;
}

/**
 * Two bodies of its own plus a `distance` constraint between them. Bodies are made during the
 * first render so both refs are populated by the time `useConstraint`'s effect runs (same shape
 * as use-constraint.test.tsx).
 */
function ConstrainedPair() {
    const { physicsSystem } = useJolt();
    const bodies = useRef<{ a: BodyState; b: BodyState } | null>(null);
    if (!bodies.current) {
        const bodySystem = physicsSystem.bodySystem;
        const anchor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        anchor.position.set(6, 10, 0);
        const hanging = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        hanging.position.set(6, 8, 0);
        bodies.current = {
            a: bodySystem.getBody(bodySystem.addBody(anchor, { bodyType: 'static' }))!,
            b: bodySystem.getBody(bodySystem.addBody(hanging))!
        };
    }
    const a = useRef<BodyState | null>(bodies.current.a);
    const b = useRef<BodyState | null>(bodies.current.b);
    useConstraint('distance', a, b, { min: 0, max: 2 });
    return null;
}

/**
 * Stands in for a character controller / camera rig in the core package (the real ones live in
 * @react-three/jolt-controllers, which cannot be imported from here). Same shape: it owns real
 * WASM objects and a body, registers itself with the world, and unregisters in its own destroy.
 */
class FakeController {
    private unregister: () => void;
    private raycaster: ReturnType<PhysicsSystem['getRaycaster']>;
    private collider: ReturnType<PhysicsSystem['getShapeCollider']>;
    private handle: number;
    destroyed = false;
    /** set when the world tore us down rather than our own component */
    tornDownByWorld = false;

    constructor(private system: PhysicsSystem) {
        this.raycaster = system.getRaycaster();
        this.collider = system.getShapeCollider();
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
        mesh.position.set(-6, 5, 0);
        this.handle = system.bodySystem.addBody(mesh, { bodyType: 'kinematic' });
        this.unregister = system.registerDisposable(this);
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.unregister();
        assert.isFalse(this.system.destroyed, 'controller torn down against a dead world');
        this.system.bodySystem.removeBody(this.handle);
        this.raycaster.destroy();
        this.collider.destroy();
    }
}

function FakeControllerComponent({ onReady }: { onReady?: (c: FakeController) => void }) {
    const { physicsSystem } = useJolt();
    const ref = useRef<FakeController | null>(null);
    if (!ref.current) {
        ref.current = new FakeController(physicsSystem);
        onReady?.(ref.current);
    }
    // deliberately NO cleanup of its own: this is the case the world's disposable registry is
    // there for - an object whose owner never got around to destroying it.
    return null;
}

/** Records what a child's own unmount cleanup saw. */
function UnmountWitness({ report }: { report: (info: { destroyed: boolean }) => void }) {
    const { physicsSystem } = useJolt();
    useUnmount(() => {
        report({ destroyed: physicsSystem.destroyed });
    });
    return null;
}

const Box = ({ x }: { x: number }) => (
    <RigidBody position={[x, 12, 0]}>
        <mesh>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial />
        </mesh>
    </RigidBody>
);

// THE definition of done for #162.
test('unmounting a whole <Physics> tree returns the allocation tracker to baseline with zero foreign destroys', async () => {
    assert.equal(Raw.interfaceCount, 0, 'a previous test leaked a world');

    // A warm-up mount/unmount outside the tracker: three.js, r3f and the shape pipeline all
    // build lazy singletons on first use, and those are not what this test is about.
    const warmup = await create(
        <Physics>
            <Box x={0} />
        </Physics>
    );
    await settle();
    await warmup.unmount();
    await settle();
    assert.equal(Raw.interfaceCount, 0, 'the warm-up world was not destroyed');

    const alloc = installAllocTracker(Raw, { types: allDestroyableTypes(Raw) });
    try {
        // The tracker swaps Raw.module's identity, which drops joltScratch's singletons. Rebuild
        // them, and run one whole mount/unmount, under the tracked module before measuring - a
        // one-time rebuild would otherwise read as a leak.
        const warmSystem = new PhysicsSystem('tracker-warmup');
        joltScratch.vec3([0, 0, 0]);
        joltScratch.rvec3([0, 0, 0]);
        joltScratch.quat([0, 0, 0, 1]);
        populate(warmSystem);
        warmSystem.onUpdate(1 / 60);
        warmSystem.destroy();
        // the last world going away released the scratch objects; put them back so the baseline
        // and the final measurement are like for like
        joltScratch.vec3([0, 0, 0]);
        joltScratch.rvec3([0, 0, 0]);
        joltScratch.quat([0, 0, 0, 1]);

        const baselineLive = valueTypesLive(alloc);
        const baselineFree = freeMemory();
        const baselineForeign = alloc.foreignDestroys();

        let system: PhysicsSystem | undefined;
        let controller: FakeController | undefined;
        let witness: { destroyed: boolean } | undefined;

        const renderer = await create(
            <Physics>
                <Capture onReady={(s) => (system = s)} />
                <Box x={0} />
                <Box x={2} />
                <ConstrainedPair />
                <FakeControllerComponent onReady={(c) => (controller = c)} />
                <InstancedRigidBodyMesh count={12}>
                    <boxGeometry args={[1, 1, 1]} />
                    <meshStandardMaterial />
                </InstancedRigidBodyMesh>
                <UnmountWitness report={(info) => (witness = info)} />
            </Physics>
        );
        await waitFor(() => !!system);
        await waitFor(() => system!.bodySystem.bodies.size >= 17);

        // the world is real: bodies, a constraint, and it steps
        assert.equal(system!.constraintSystem.constraints.size, 1, 'no constraint was created');
        assert.equal(system!.disposableCount, 1, 'the controller did not register itself');
        await act(async () => {
            for (let i = 0; i < 20; i++) system!.onUpdate(1 / 60);
        });

        await renderer.unmount();
        await settle();

        //* what the children saw ---------------------------------
        // This is the ordering fix: the teardown is deferred past the commit, so every child
        // cleanup below ran while the world was still alive. `renderer.unmount()` awaits, which
        // already drains the microtask, so the deferral is asserted through what the children
        // observed rather than by looking at `destroyed` in between.
        assert.isDefined(witness, "a child's useUnmount never ran");
        assert.isFalse(witness!.destroyed, 'a child cleaned up against a destroyed world');
        assert.isTrue(controller!.destroyed, 'the registered controller was never torn down');

        //* what is left ------------------------------------------
        assert.isTrue(system!.destroyed);
        assert.equal(Raw.interfaceCount, 0, 'the JoltInterface outlived the tree');
        assert.equal(system!.bodySystem.bodies.size, 0, 'bodies outlived the tree');
        assert.equal(
            system!.constraintSystem.constraints.size,
            0,
            'a constraint outlived the tree'
        );

        // the scratch objects went with the last world; rebuild before comparing
        joltScratch.vec3([0, 0, 0]);
        joltScratch.rvec3([0, 0, 0]);
        joltScratch.quat([0, 0, 0, 1]);

        assert.equal(
            alloc.foreignDestroys() - baselineForeign,
            0,
            'something destroyed an object it did not allocate'
        );
        assert.equal(
            valueTypesLive(alloc),
            baselineLive,
            `unmount leaked ${valueTypesLive(alloc) - baselineLive} tracked allocations: ` +
                JSON.stringify(alloc.liveByType())
        );
        expectHeapRestored(baselineFree, freeMemory(), 64, 'unmounting the tree');
    } finally {
        alloc.uninstall();
        flushDeferredWorldDestroys();
    }
});

test("a child's useUnmount observes a live world (physicsSystem.destroyed === false)", async () => {
    let system: PhysicsSystem | undefined;
    let seen: { destroyed: boolean; removedBody: boolean } | undefined;

    /** Removes a body of its own from inside the cleanup - the thing that used to trap. */
    function LateBody() {
        const { physicsSystem } = useJolt();
        const handle = useRef<number | null>(null);
        if (handle.current === null) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            mesh.position.set(0, 4, 0);
            handle.current = physicsSystem.bodySystem.addBody(mesh);
        }
        useUnmount(() => {
            const before = physicsSystem.bodySystem.bodies.size;
            physicsSystem.bodySystem.removeBody(handle.current!);
            seen = {
                destroyed: physicsSystem.destroyed,
                removedBody: physicsSystem.bodySystem.bodies.size === before - 1
            };
        });
        return null;
    }

    const renderer = await create(
        <Physics>
            <Capture onReady={(s) => (system = s)} />
            <LateBody />
        </Physics>
    );
    await waitFor(() => !!system);

    await renderer.unmount();
    assert.isDefined(seen, 'the child cleanup never ran');
    assert.isFalse(seen!.destroyed, 'the world was already destroyed when the child cleaned up');
    assert.isTrue(seen!.removedBody, 'the child could not remove its own body');

    await settle();
    assert.isTrue(system!.destroyed, 'the deferred teardown never ran');
});

test("StrictMode's mount/unmount/mount leaves exactly one live world, and it works", async () => {
    assert.equal(Raw.interfaceCount, 0, 'a previous test leaked a world');
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <React.StrictMode>
            <Physics>
                <Capture onReady={(s) => (system = s)} />
                <Box x={0} />
            </Physics>
        </React.StrictMode>
    );
    await waitFor(() => !!system);
    // if StrictMode double-invoked the effects, the discarded world's teardown is queued now
    await settle();

    assert.isFalse(system!.destroyed, 'StrictMode destroyed the world the tree is using');
    assert.equal(Raw.interfaceCount, 1, 'StrictMode left an orphaned world behind');
    assert.strictEqual(
        Raw.getInterface(system!.interfaceId),
        system!.joltInterface,
        'the live world is not the one in the registry'
    );

    // and the surviving world actually simulates
    const box = populate(system!);
    const startY = box.position.y;
    await act(async () => {
        for (let i = 0; i < 30; i++) system!.onUpdate(1 / 60);
    });
    assert.isBelow(box.position.y, startY - 0.5, 'the surviving world does not step');

    await renderer.unmount();
    await settle();
    assert.equal(Raw.interfaceCount, 0);
});

test('<Physics> can be remounted after an unmount, and bodies fall in the new world', async () => {
    assert.equal(Raw.interfaceCount, 0, 'a previous test leaked a world');

    const mount = async () => {
        let system: PhysicsSystem | undefined;
        const renderer = await create(
            <Physics>
                <Capture onReady={(s) => (system = s)} />
                <Box x={0} />
            </Physics>
        );
        await waitFor(() => !!system);
        await waitFor(() => system!.bodySystem.dynamicBodies.size === 1);
        return { renderer, system: system! };
    };

    const first = await mount();
    await first.renderer.unmount();
    await settle();
    assert.isTrue(first.system.destroyed);
    assert.equal(Raw.interfaceCount, 0);

    const second = await mount();
    try {
        assert.isFalse(second.system.destroyed);
        // a genuinely new world, not the first one handed back (the #176 failure mode)
        assert.notStrictEqual(second.system, first.system);
        assert.notEqual(second.system.interfaceId, first.system.interfaceId);
        assert.equal(Raw.interfaceCount, 1);

        const body = [...second.system.bodySystem.dynamicBodies.values()][0]!;
        const startY = body.position.y;
        await act(async () => {
            for (let i = 0; i < 30; i++) second.system.onUpdate(1 / 60);
        });
        assert.isBelow(body.position.y, startY - 0.5, 'the remounted world does not simulate');
    } finally {
        await second.renderer.unmount();
        await settle();
    }
    assert.equal(Raw.interfaceCount, 0);
});
