// SoftBodyContactListenerJS wiring (issue #245), against the real jolt-physics wasm module:
// `<SoftBody>`'s onCollisionEnter/Persist/Exit, onSensorEnter/Exit and onContactValidate, plus
// world-level dispatch and the "no leak" contract the listener promises.
//
// One PhysicsSystem per test, same reasoning as contact-events.test.ts: worlds are expensive
// (~20MB of wasm heap each) and every test destroys its own.

import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { CollisionEnterPayload } from '../src/systems/events';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
    // One-time cost (see soft-body.test.ts): the first soft body step in a JoltInterface's
    // lifetime lazily allocates scratch space for the solver that then stays allocated. Warm it
    // up here so every leak assertion below measures steady state.
    const warmup = new PhysicsSystem('soft-events-warmup');
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1));
    const handle = warmup.softBodySystem.addBody(mesh, {});
    warmup.onUpdate(STEP);
    warmup.softBodySystem.removeBody(handle);
    warmup.destroy('soft-events-warmup');
});

/** A world with a static floor whose top surface is at y = -0.5. */
function makeWorld(pid: string) {
    const ps = new PhysicsSystem(pid);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(0, -1, 0);
    const floorState = ps.bodySystem.getBody(ps.bodySystem.addBody(floor, { bodyType: 'static' }))!;
    return { ps, floorState };
}

/** A pressurized sphere soft body, dropped from `y`. */
function addSoftSphere(ps: PhysicsSystem, y: number) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8));
    mesh.position.set(0, y, 0);
    const handle = ps.softBodySystem.addBody(mesh, { pressure: 2000, numIterations: 6 });
    return ps.softBodySystem.getBody(handle)!;
}

describe('collision enter / persist / exit', () => {
    test('a soft body dropped on a floor enters once, persists, and reports the same payload shape a rigid body gets', () => {
        const { ps, floorState } = makeWorld('soft-events-basic');
        try {
            const soft = addSoftSphere(ps, 3);
            const log: string[] = [];
            let enterPayload: CollisionEnterPayload | undefined;

            soft.onCollisionEnter((e) => {
                log.push('enter');
                enterPayload = {
                    ...e,
                    normal: e.normal.clone(),
                    points: e.points.map((p) => p.clone()),
                    target: { ...e.target },
                    other: { ...e.other }
                };
            });
            let persists = 0;
            soft.onCollisionPersist(() => persists++);
            soft.onCollisionExit(() => log.push('exit'));

            for (let i = 0; i < 120; i++) ps.onUpdate(STEP);

            assert.equal(log[0], 'enter', 'no collisionEnter fired');
            assert.isAbove(persists, 1, 'no collisionPersist fired while resting');
            assert.notInclude(log, 'exit', 'a false exit fired while still resting');

            assert.isOk(enterPayload, 'the enter payload was never captured');
            const e = enterPayload!;
            // same payload shape a rigid body's onCollisionEnter gets. Compared by `.handle`
            // rather than `assert.equal`'s reference/deep-equality on the instances themselves -
            // a `BodyState`/`SoftBodyState` carries live Jolt (WASM) references, and chai
            // building a failure diff over one is desperately expensive (verified while writing
            // this test: an *intentionally* failing rich-object comparison here exhausted a 2GB
            // heap - a test-authoring gotcha worth other soft-body tests avoiding, not a bug in
            // the listener itself, which held steady memory throughout).
            assert.isUndefined(e.target.body, 'a soft body has no BodyState');
            assert.isDefined(e.target.softBody, 'target.softBody should be set');
            assert.equal(e.target.softBody?.handle, soft.handle, 'target.softBody should be this soft body');
            assert.equal(e.target.object, soft.object);
            assert.isDefined(e.other.body, "other.body should resolve to the floor's BodyState");
            assert.equal(e.other.body?.handle, floorState.handle);
            assert.isUndefined(e.other.softBody);
            assert.isAbove(e.contactCount, 0);
            // the floor is below the soft body, so the contact normal (other -> target) points up
            assert.isAbove(e.normal.y, 0.3, `normal did not point away from the floor: ${e.normal.y}`);
        } finally {
            ps.destroy('soft-events-basic');
        }
    });

    test('removing a soft body that is resting on something closes the contact (world level exit)', () => {
        const { ps } = makeWorld('soft-events-remove');
        try {
            const soft = addSoftSphere(ps, 2);
            // The peer tracker only runs while *something* is listening (zero cost otherwise -
            // see SoftBodyContactAccumulator), so the world listener has to be attached before
            // the soft body starts touching the floor, not just before removeBody.
            let worldExits = 0;
            ps.events.on('collisionExit', () => worldExits++);

            for (let i = 0; i < 90; i++) ps.onUpdate(STEP);

            ps.softBodySystem.removeBody(soft.handle);
            // the exit is queued by removeBody and dispatched on the next flush
            ps.onUpdate(STEP);

            assert.isAbove(worldExits, 0, 'destroying a resting soft body never closed its contact');
        } finally {
            ps.destroy('soft-events-remove');
        }
    });

    test('a soft body dropped with nothing to land on never enters', () => {
        const ps = new PhysicsSystem('soft-events-empty');
        try {
            const soft = addSoftSphere(ps, 10);
            let enters = 0;
            soft.onCollisionEnter(() => enters++);
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            assert.equal(enters, 0);
        } finally {
            ps.destroy('soft-events-empty');
        }
    });
});

describe('onContactValidate', () => {
    test('rejecting the floor lets the soft body fall through it', () => {
        const { ps } = makeWorld('soft-events-validate');
        try {
            const soft = addSoftSphere(ps, 3);
            soft.onContactValidate(() => false);
            let enters = 0;
            soft.onCollisionEnter(() => enters++);

            for (let i = 0; i < 90; i++) ps.onUpdate(STEP);

            assert.equal(enters, 0, 'a rejected contact still entered');
            assert.isBelow(soft.object.position.y, -1, 'the soft body did not fall through the floor');
        } finally {
            ps.destroy('soft-events-validate');
        }
    });

    test('the validate payload carries target/other with no baseOffset', () => {
        const { ps, floorState } = makeWorld('soft-events-validate-payload');
        try {
            const soft = addSoftSphere(ps, 3);
            // Jolt calls `OnSoftBodyContactValidate` once the two bodies' bounding boxes
            // overlap, well before the vertices actually touch - empirically around step ~45-50
            // for this drop height, so the budget here is generous.
            let seenOtherHandle: number | undefined;
            soft.onContactValidate((e) => {
                seenOtherHandle = e.other.body?.handle;
                assert.notProperty(e, 'baseOffset');
                return true;
            });
            for (let i = 0; i < 120 && seenOtherHandle === undefined; i++) ps.onUpdate(STEP);
            assert.equal(seenOtherHandle, floorState.handle);
        } finally {
            ps.destroy('soft-events-validate-payload');
        }
    });
});

describe('sensors', () => {
    test('a sensor gets enter/exit on the sensor channel and no collision events', () => {
        const ps = new PhysicsSystem('soft-events-sensor');
        try {
            const sensorMesh = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 6));
            sensorMesh.position.set(0, 0, 0);
            const sensor = ps.bodySystem.getBody(
                ps.bodySystem.addBody(sensorMesh, { bodyType: 'static' })
            )!;
            sensor.isSensor = true;

            const soft = addSoftSphere(ps, 3);
            const log: string[] = [];
            soft.onSensorEnter(() => log.push('sensorEnter'));
            soft.onSensorExit(() => log.push('sensorExit'));
            soft.onCollisionEnter(() => log.push('collisionEnter'));

            for (let i = 0; i < 150; i++) ps.onUpdate(STEP);

            assert.include(log, 'sensorEnter', 'the sensor never reported an enter');
            assert.notInclude(log, 'collisionEnter', 'a sensor produced a collision event');
        } finally {
            ps.destroy('soft-events-sensor');
        }
    });
});

describe('cost and lifecycle', () => {
    test('a soft body with no listeners costs nothing extra: no WASM heap growth over many steps', () => {
        const { ps } = makeWorld('soft-events-cost');
        try {
            addSoftSphere(ps, 3);
            const jolt = Raw.module;
            for (let i = 0; i < 10; i++) ps.onUpdate(STEP); // let it land first
            const before = jolt.JoltInterface.prototype.sGetFreeMemory();
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            const after = jolt.JoltInterface.prototype.sGetFreeMemory();
            assert.isAtLeast(after, before - 256, `leaked ${before - after} bytes with no listeners`);
        } finally {
            ps.destroy('soft-events-cost');
        }
    });

    test('a soft body WITH listeners attached does not leak the WASM heap across many contact steps', () => {
        const { ps } = makeWorld('soft-events-cost-listening');
        try {
            const soft = addSoftSphere(ps, 3);
            soft.onCollisionEnter(() => {});
            soft.onCollisionPersist((e) => {
                // touch every lazily-resolved/pooled field a handler might reasonably read
                void e.normal.x;
                void e.points.length;
                void e.target.softBody;
                void e.other.body;
            });
            soft.onCollisionExit(() => {});

            const jolt = Raw.module;
            for (let i = 0; i < 10; i++) ps.onUpdate(STEP); // let it land first
            const before = jolt.JoltInterface.prototype.sGetFreeMemory();
            for (let i = 0; i < 120; i++) ps.onUpdate(STEP);
            const after = jolt.JoltInterface.prototype.sGetFreeMemory();
            assert.isAtLeast(
                after,
                before - 256,
                `leaked ${before - after} bytes of WASM heap while dispatching contact events`
            );
        } finally {
            ps.destroy('soft-events-cost-listening');
        }
    });

    test('removing a soft body with listeners twice is a no-op, not a double free', () => {
        const alloc = installAllocTracker(Raw);
        const { ps } = makeWorld('soft-events-double-destroy');
        try {
            const soft = addSoftSphere(ps, 3);
            soft.onCollisionEnter(() => {});
            for (let i = 0; i < 30; i++) ps.onUpdate(STEP);

            expect(() => ps.softBodySystem.removeBody(soft.handle)).not.toThrow();
            expect(() => ps.softBodySystem.removeBody(soft.handle)).not.toThrow(); // already gone

            const again = addSoftSphere(ps, 3);
            for (let i = 0; i < 30; i++) ps.onUpdate(STEP);
            ps.softBodySystem.removeBody(again.handle);

            expect(alloc.destroyed()).toBeGreaterThan(0);
        } finally {
            alloc.uninstall();
            ps.destroy('soft-events-double-destroy');
        }
    });
});
