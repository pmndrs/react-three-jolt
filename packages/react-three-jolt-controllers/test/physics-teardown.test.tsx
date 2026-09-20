// The controllers half of issue #162: tearing a whole `<Physics>` tree down with a real
// character controller in it.
//
// React runs a parent's effect cleanup before its children's, so `<Physics>` unmounting used to
// free the JoltInterface before `<CharacterController>`'s cleanup ran - which is why
// `CharacterControllerSystem.destroy()` has to check `physicsSystem.destroyed` and skip
// `releaseJoltObjects()` when it is set. That branch meant a full unmount leaked every WASM
// object the controller owned. With the teardown deferred past the commit the controller now
// always tears down against a live world, so nothing is skipped.
//
// The core package's test/physics-lifecycle.test.tsx covers the same ground for bodies,
// constraints and instanced meshes; this one is here because the controllers cannot be imported
// from there.

import { Physics, type PhysicsSystem, Raw, useJolt } from '@react-three/jolt';
import { create } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import * as THREE from 'three';
import { assert, test } from 'vitest';
import {
    allDestroyableTypes,
    expectHeapRestored,
    installAllocTracker
} from '../../react-three-jolt/test/jolt-alloc';
import { CharacterController } from '../src/components/CharacterController';
import { CameraRigManager } from '../src/systems/camera-rig/camera-rig-system';
import { VehicleSystem } from '../src/systems/vehicles/vehicle-system';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

/** Drain the microtask the `<Physics>` unmount queues its teardown on. */
const drain = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

const Capture = ({ onReady }: { onReady: (system: PhysicsSystem) => void }) => {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem);
    }, [physicsSystem, onReady]);
    return null;
};

const Tree = ({ onReady }: { onReady: (system: PhysicsSystem) => void }) => (
    <Physics>
        <Capture onReady={onReady} />
        <CharacterController />
    </Physics>
);

test('unmounting <Physics> with a character controller frees everything', async () => {
    let system: PhysicsSystem | undefined;
    const onReady = (s: PhysicsSystem) => {
        system = s;
    };

    // Warm-up mount/unmount: three.js, the shape pipeline and Jolt's own lazy singletons all
    // build on first use and are not what this measures.
    const warmup = await create(<Tree onReady={onReady} />);
    await settle(() => system !== undefined);
    await warmup.unmount();
    await drain();
    assert.equal(Raw.interfaceCount, 0, 'the warm-up world was not destroyed');

    const alloc = installAllocTracker(Raw, { types: allDestroyableTypes(Raw) });
    const baselineFree = freeMemory();
    try {
        system = undefined;
        const renderer = await create(<Tree onReady={onReady} />);
        await settle(() => system !== undefined);
        assert.isDefined(system, 'Physics never mounted its children');

        // the controller registered itself with the world
        assert.equal(system!.disposableCount, 1, 'the controller did not register with the world');
        await act(async () => {
            for (let i = 0; i < 10; i++) system!.onUpdate(1 / 60);
        });

        await renderer.unmount();
        await drain();

        assert.isTrue(system!.destroyed, 'the deferred teardown never ran');
        assert.equal(Raw.interfaceCount, 0, 'the JoltInterface outlived the tree');
        assert.equal(system!.bodySystem.bodies.size, 0, 'bodies outlived the tree');
        assert.equal(system!.disposableCount, 0, 'a disposable outlived the tree');
        assert.equal(system!.events.listenerCount('beforeStep'), 0, 'a step listener survived');

        // The controller's own cleanup runs before the world dies now, so `releaseJoltObjects()`
        // is not skipped and every WASM object it owns is freed. The heap is the ground truth.
        expectHeapRestored(baselineFree, freeMemory(), 64, 'unmounting the controller tree');
        assert.equal(alloc.foreignDestroys(), 0, 'something freed an object it did not allocate');
    } finally {
        alloc.uninstall();
    }
});

// The camera rig and the vehicle system register themselves the same way the character
// controller does. Both are built without a React owner here, which is exactly the case the
// registry exists for: nothing else would ever call their `destroy()`.
test('a camera rig and a vehicle system built by hand are torn down with the world', async () => {
    const { PhysicsSystem: System } = await import('@react-three/jolt');
    // warm-up round: both classes build lazy singletons (and Jolt builds some of its own) on
    // first use in a process, which is not what the heap comparison below is about
    const warm = new System('controllers-disposables-warmup');
    new CameraRigManager(new THREE.Scene(), warm);
    new VehicleSystem(warm);
    warm.destroy();

    const baselineFree = freeMemory();
    const system = new System('controllers-disposables');

    const rig = new CameraRigManager(new THREE.Scene(), system);
    const vehicles = new VehicleSystem(system);
    assert.equal(system.disposableCount, 2, 'the rig/vehicle system did not register themselves');

    system.onUpdate(1 / 60);
    system.destroy();

    assert.equal(system.disposableCount, 0);
    // both are idempotent, so tearing them down again from their own (absent) owner is safe
    rig.destroy();
    vehicles.destroy();
    expectHeapRestored(
        baselineFree,
        freeMemory(),
        64,
        'the world did not give all of its heap back'
    );
});
