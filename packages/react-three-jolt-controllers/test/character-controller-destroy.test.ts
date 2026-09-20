// Issue #138: `CharacterControllerSystem.destroy()` used to be a stub that only removed the
// three object from the scene. Everything else - the CharacterVirtual, its contact listener, the
// capsule shapes, the filters, the update settings - stayed on the wasm heap, and because the
// pre-step listener was registered as an inline arrow (`removeStepListener` matches by identity)
// a "destroyed" controller kept being stepped against memory it no longer owned.
//
// These tests construct a controller, step it, destroy it, and assert the live allocation count
// is back where it started.

import { initJolt, PhysicsSystem, Raw } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { installAllocTracker } from '../../react-three-jolt/test/jolt-alloc';
import { CharacterControllerSystem } from '../src/systems/character-controller';

// Every class `character-controller.ts` constructs with `new Raw.module.*`, plus the value types
// its helpers allocate. `CapsuleShapeSettings` is deliberately absent: it is handed to a
// `RotatedTranslatedShapeSettings`, which owns it through a RefConst and frees it when the outer
// settings are destroyed, so it is never ours to destroy (and would therefore never balance).
const TRACKED_TYPES = [
    'ExtendedUpdateSettings',
    'BodyFilterJS',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'CharacterContactListenerJS',
    'CharacterVirtualSettings',
    'CharacterVirtual',
    'Plane',
    'SphereShapeSettings',
    'RotatedTranslatedShapeSettings',
    'BodyCreationSettings',
    'Vec3',
    'RVec3',
    'Quat'
];

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('controllers-destroy');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // installAllocTracker swaps Raw.module for a Proxy, which rebuilds the shared joltScratch
    // singletons once. Build a controller first so every lazy singleton exists before we count.
    new CharacterControllerSystem(ps).destroy();
});

const stepListenerCount = (system: PhysicsSystem) =>
    // preStepListeners is private; the whole point of the test is that removal actually happened
    ((system as unknown as { preStepListeners: unknown[] }).preStepListeners ?? []).length;

test('construct -> step -> destroy leaves no live jolt objects behind', () => {
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        // One warm-up round under the tracked module: the shared joltScratch singletons are
        // rebuilt when the tracker swaps Raw.module, and they are created lazily on first use.
        const warmup = new CharacterControllerSystem(ps);
        warmup.position = new THREE.Vector3(0, 3, 0);
        warmup.rotation = new THREE.Quaternion(0, 0, 0, 1);
        warmup.linearVelocity = new THREE.Vector3(1, 0, 0);
        ps.onUpdate(1 / 60);
        warmup.destroy();
        const before = alloc.live();

        const cc = new CharacterControllerSystem(ps);
        cc.position = new THREE.Vector3(0, 3, 0);
        cc.move(new THREE.Vector3(1, 0, 0));
        for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
        cc.destroy();

        assert.equal(
            alloc.live(),
            before,
            `the controller leaked ${alloc.live() - before} objects: ` +
                JSON.stringify(alloc.liveByType())
        );
        assert.equal(alloc.foreignDestroys(), 0, 'the controller freed something it does not own');
    } finally {
        alloc.uninstall();
    }
});

test('the per-frame update allocates nothing', () => {
    const cc = new CharacterControllerSystem(ps);
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        ps.onUpdate(1 / 60); // warm the scratch objects rebuilt for the proxied module
        const before = alloc.live();
        for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
        assert.equal(
            alloc.live(),
            before,
            `stepping leaked ${alloc.live() - before} objects: ${JSON.stringify(alloc.liveByType())}`
        );
        assert.equal(alloc.foreignDestroys(), 0);
    } finally {
        alloc.uninstall();
        cc.destroy();
    }
});

test('destroy() is idempotent', () => {
    const cc = new CharacterControllerSystem(ps);
    for (let i = 0; i < 3; i++) ps.onUpdate(1 / 60);
    cc.destroy();
    assert.doesNotThrow(() => cc.destroy());
    assert.doesNotThrow(() => cc.destroy());
});

test('destroy() removes the pre-step listener so stepping is a no-op afterwards', () => {
    const before = stepListenerCount(ps);
    const cc = new CharacterControllerSystem(ps);
    assert.equal(stepListenerCount(ps), before + 1, 'the controller did not register a listener');

    let calls = 0;
    const realUpdate = cc.prePhysicsUpdate.bind(cc);
    cc.prePhysicsUpdate = (deltaTime: number) => {
        calls++;
        realUpdate(deltaTime);
    };
    ps.onUpdate(1 / 60);
    assert.isAbove(calls, 0, 'the listener never ran while the controller was alive');

    cc.destroy();
    assert.equal(stepListenerCount(ps), before, 'the pre-step listener was not removed');

    const callsAtDestroy = calls;
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.equal(calls, callsAtDestroy, 'a destroyed controller is still being stepped');
});

test('setCapsule can be called repeatedly without leaking shapes', () => {
    const cc = new CharacterControllerSystem(ps);
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        cc.setCapsule(1, 2); // warm up under the proxied module
        const before = alloc.live();
        for (let i = 0; i < 5; i++) cc.setCapsule(0.5 + i * 0.1, 1.8);
        assert.equal(
            alloc.live(),
            before,
            `setCapsule leaked ${alloc.live() - before} objects: ` +
                JSON.stringify(alloc.liveByType())
        );
        assert.equal(alloc.foreignDestroys(), 0, 'setCapsule freed something it does not own');
        // and the character is still usable afterwards
        for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);
        assert.isFinite(cc.position.y);
    } finally {
        alloc.uninstall();
        cc.destroy();
    }
});
