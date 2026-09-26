// The contact pipeline, against the real WASM module: sub-shape pair refcounting, the deferred
// queue, sensors, sleep/wake, unknown bodies and the allocation profile.
//
// One PhysicsSystem per test where the body set matters, because every world shares the Jolt
// module and its body id space - a body created by one turns up in the contact listener of
// another. Worlds are expensive (~20MB of wasm heap each), so each test destroys its own.

import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import { Layer } from '../src/constants';
import { initJolt, Raw } from '../src/raw';
import { ContactPairTracker } from '../src/systems/contact-events';
import type { CollisionEnterPayload, CollisionPayload } from '../src/systems/events';
import { PhysicsSystem } from '../src/systems/physics-system';
import { generateShape, type ShapeDescriptor } from '../src/systems/shape-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** A world with a static floor whose top surface is at y = -0.5. */
function makeWorld(pid: string) {
    const ps = new PhysicsSystem(pid);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(0, -1, 0);
    const floorState = ps.bodySystem.getBody(ps.bodySystem.addBody(floor, { bodyType: 'static' }))!;
    return { ps, floorState };
}

function addBox(ps: PhysicsSystem, y: number, size = 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.position.set(0, y, 0);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
}

describe('enter / persist / exit', () => {
    test('a box dropped on a floor enters once, persists, and exits once when removed', () => {
        const { ps, floorState } = makeWorld('contacts-basic');
        try {
            const box = addBox(ps, 1);
            const log: string[] = [];
            let enterPayload: CollisionEnterPayload | undefined;

            box.onCollisionEnter((e) => {
                log.push('enter');
                enterPayload = {
                    ...e,
                    normal: e.normal.clone(),
                    points: e.points.map((p) => p.clone()),
                    target: { ...e.target },
                    other: { ...e.other }
                };
            });
            box.onCollisionPersist(() => log.push('persist'));
            box.onCollisionExit(() => log.push('exit'));

            // fall, land, and rest - but stop before Jolt puts the body to sleep, which
            // legitimately closes its contacts (see docs/events.md)
            for (let i = 0; i < 40 && !box.isSleeping; i++) ps.onUpdate(STEP);

            assert.equal(log.filter((e) => e === 'enter').length, 1, 'expected exactly one enter');
            assert.isAbove(log.filter((e) => e === 'persist').length, 3, 'no persists');
            assert.equal(log.filter((e) => e === 'exit').length, 0, 'exited while still resting');
            assert.equal(log[0], 'enter', 'enter must come before any persist');
            assert.equal(box.isContacting(floorState.handle), 1);

            // the payload describes the pair from the box's point of view
            assert.isDefined(enterPayload);
            assert.equal(enterPayload!.target.handle, box.handle);
            assert.equal(enterPayload!.other.handle, floorState.handle);
            assert.equal(enterPayload!.other.body, floorState);
            assert.equal(enterPayload!.contactCount, 1);
            // normal points from the floor toward the box, i.e. up
            assert.closeTo(enterPayload!.normal.y, 1, 1e-3);
            assert.isAbove(enterPayload!.pointCount, 0);
            assert.equal(enterPayload!.points.length, enterPayload!.pointCount);
            // the floor's top surface
            assert.closeTo(enterPayload!.points[0].y, -0.5, 0.1);

            // removing the box closes the pair: exactly one exit, delivered on the next step
            ps.bodySystem.removeBody(box.handle);
            const floorLog: string[] = [];
            floorState.onCollisionExit(() => floorLog.push('exit'));
            ps.onUpdate(STEP);
            ps.onUpdate(STEP);
            assert.equal(ps.bodySystem.contactPairs.size, 0, 'a pair survived body removal');
            assert.equal(floorState.isContacting(box.handle), 0);
        } finally {
            ps.destroy('contacts-basic');
        }
    });

    test('the peer gets an exit when a body it touches is destroyed', () => {
        const { ps, floorState } = makeWorld('contacts-destroy');
        try {
            const box = addBox(ps, 1);
            const exits: CollisionPayload[] = [];
            floorState.onCollisionExit((e) => {
                exits.push({ ...e, target: { ...e.target }, other: { ...e.other } });
            });

            for (let i = 0; i < 30 && floorState.isContacting(box.handle) === 0; i++)
                ps.onUpdate(STEP);
            assert.equal(floorState.isContacting(box.handle), 1, 'never made contact');

            const boxHandle = box.handle;
            ps.bodySystem.removeBody(boxHandle);
            ps.onUpdate(STEP);

            assert.equal(exits.length, 1, 'expected exactly one exit for the destroyed peer');
            assert.equal(exits[0].target.handle, floorState.handle);
            assert.equal(exits[0].other.handle, boxHandle);
            assert.isUndefined(exits[0].other.body, 'a destroyed body must resolve to undefined');

            // and nothing stale is left keyed on the recycled handle
            assert.equal(floorState.isContacting(boxHandle), 0);
            ps.onUpdate(STEP);
            assert.equal(exits.length, 1, 'jolt re-delivered the removal as a second exit');
        } finally {
            ps.destroy('contacts-destroy');
        }
    });

    test('events are dispatched between the step and afterStep, never inside it', () => {
        const { ps } = makeWorld('contacts-order');
        try {
            const box = addBox(ps, 1);
            const order: string[] = [];
            ps.onBeforeStep(() => order.push('beforeStep'));
            ps.onAfterStep(() => order.push('afterStep'));
            box.onCollisionEnter(() => {
                order.push('enter');
                // legal only because this runs after Step() has returned
                box.addImpulse(new THREE.Vector3(0, 1, 0));
            });

            for (let i = 0; i < 30 && !order.includes('enter'); i++) ps.onUpdate(STEP);
            const enterAt = order.indexOf('enter');
            assert.isAbove(enterAt, 0, 'no enter fired');
            assert.equal(order[enterAt - 1], 'beforeStep');
            assert.equal(order[enterAt + 1], 'afterStep');
        } finally {
            ps.destroy('contacts-order');
        }
    });
});

describe('sub shape identity (#13)', () => {
    /**
     * A static floor made of two boxes side by side, as one compound: child 0 on the left,
     * child 1 on the right. Dropping something onto one of them is the deterministic way to
     * check that a contact resolves back to the right child.
     */
    function makeSplitFloor(ps: PhysicsSystem) {
        const descriptor: ShapeDescriptor = {
            type: 'staticCompound',
            children: [
                {
                    type: 'box',
                    size: [8, 1, 8],
                    position: [-6, 0, 0],
                    userData: 111,
                    name: 'left'
                },
                {
                    type: 'box',
                    size: [8, 1, 8],
                    position: [6, 0, 0],
                    userData: 222,
                    name: 'right'
                }
            ]
        };
        const shape = generateShape(descriptor);
        const object = new THREE.Object3D();
        object.position.set(0, -1, 0);
        const handle = ps.bodySystem.addBody(object, {
            bodyType: 'static',
            shape,
            shapeDescriptor: descriptor
        });
        return ps.bodySystem.getBody(handle)!;
    }

    test('a contact on child 1 resolves its index, user data and descriptor', () => {
        const ps = new PhysicsSystem('contacts-subshape');
        try {
            const floor = makeSplitFloor(ps);
            // straight down onto the right hand child
            const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            box.position.set(6, 2, 0);
            const boxState = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

            let resolved:
                | { index: number; userData: number; name?: string; id: number }
                | undefined;
            boxState.onCollisionEnter((e) => {
                const sub = e.otherSubShape;
                resolved = {
                    index: sub.index,
                    userData: sub.userData,
                    name: sub.descriptor?.name,
                    id: sub.id
                };
                // the box itself is a plain box: no children, so no sub shape
                assert.equal(e.targetSubShape.index, -1, 'a leaf shape reported a child index');
                assert.equal(e.targetSubShape.userData, 0);
                assert.equal(e.targetSubShape.descriptor?.type, 'box');
            });

            for (let i = 0; i < 60 && !resolved; i++) ps.onUpdate(STEP);

            assert.isDefined(resolved, 'the box never landed on the compound floor');
            assert.equal(resolved!.index, 1, 'the contact resolved to the wrong compound child');
            assert.equal(resolved!.userData, 222, 'the descriptor user data did not survive');
            assert.equal(resolved!.name, 'right', 'the descriptor did not come back');
            // and the other side of the same pair agrees
            let fromFloor: number | undefined;
            floor.onCollisionPersist((e) => {
                fromFloor = e.targetSubShape.index;
            });
            ps.onUpdate(STEP);
            assert.equal(fromFloor, 1);
        } finally {
            ps.destroy('contacts-subshape');
        }
    });

    test('a contact on child 0 resolves to child 0', () => {
        const ps = new PhysicsSystem('contacts-subshape0');
        try {
            makeSplitFloor(ps);
            const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            box.position.set(-6, 2, 0);
            const boxState = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

            let index: number | undefined;
            let userData: number | undefined;
            boxState.onCollisionEnter((e) => {
                index = e.otherSubShape.index;
                userData = e.otherSubShape.userData;
            });
            for (let i = 0; i < 60 && index === undefined; i++) ps.onUpdate(STEP);
            assert.equal(index, 0);
            assert.equal(userData, 111);
        } finally {
            ps.destroy('contacts-subshape0');
        }
    });

    test('resolution is lazy: a handler that never looks costs no shape walk', () => {
        const ps = new PhysicsSystem('contacts-subshape-lazy');
        try {
            makeSplitFloor(ps);
            const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            box.position.set(6, 2, 0);
            const boxState = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

            // The pool hands out the *same* SubShapeRef object every time; an unread one keeps
            // whatever the last reader left in it rather than being refilled per contact.
            const refs: unknown[] = [];
            let read = 0;
            boxState.onCollisionPersist((e) => {
                refs.push(e.otherSubShape);
                read = e.otherSubShape.userData;
            });
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            assert.isAbove(refs.length, 1, 'nothing was dispatched');
            assert.equal(refs[0], refs[1], 'the sub shape reference is not pooled');
            assert.equal(read, 222);
        } finally {
            ps.destroy('contacts-subshape-lazy');
        }
    });

    test('a one-way platform lets a body through from below and holds it from above', () => {
        const ps = new PhysicsSystem('contacts-oneway');
        try {
            const platformMesh = new THREE.Mesh(new THREE.BoxGeometry(20, 0.5, 20));
            platformMesh.position.set(0, 0, 0);
            const platform = ps.bodySystem.getBody(
                ps.bodySystem.addBody(platformMesh, { bodyType: 'static' })
            )!;

            // #13: reject any contact whose other body is moving upward - the classic one-way
            // platform. `onContactValidate` runs synchronously inside the step, so it only reads.
            platform.onContactValidate((e) => {
                const other = e.other.body;
                if (!other) return true;
                return other.velocity.y <= 0;
            });

            const riser = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            riser.position.set(0, -4, 0);
            const risingBody = ps.bodySystem.getBody(ps.bodySystem.addBody(riser))!;
            risingBody.velocity = new THREE.Vector3(0, 12, 0);

            let contacts = 0;
            risingBody.onCollisionEnter(() => contacts++);
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            assert.isAbove(risingBody.position.y, 0.5, 'the body did not pass through from below');
            assert.equal(contacts, 0, 'a contact from below was not rejected');

            // and coming back down it lands on it
            for (let i = 0; i < 180 && contacts === 0; i++) ps.onUpdate(STEP);
            assert.isAbove(contacts, 0, 'the platform rejected a contact from above as well');
            assert.isAbove(risingBody.position.y, 0, 'the body fell through from above');
        } finally {
            ps.destroy('contacts-oneway');
        }
    });
});

describe('sensors', () => {
    test('a sensor gets enter/exit on the sensor channel and no collision events', () => {
        const { ps } = makeWorld('contacts-sensor');
        try {
            const sensorMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4));
            sensorMesh.position.set(0, 2, 0);
            const sensor = ps.bodySystem.getBody(
                ps.bodySystem.addBody(sensorMesh, { bodyType: 'static' })
            )!;
            sensor.isSensor = true;

            const log: string[] = [];
            sensor.onSensorEnter(() => log.push('sensorEnter'));
            sensor.onSensorExit(() => log.push('sensorExit'));
            sensor.onCollisionEnter(() => log.push('collisionEnter'));
            sensor.onCollisionExit(() => log.push('collisionExit'));

            // dropped from above the sensor, falls through it and lands on the floor
            const box = addBox(ps, 5, 0.5);
            for (let i = 0; i < 120; i++) ps.onUpdate(STEP);

            assert.include(log, 'sensorEnter', 'the sensor never reported an overlap');
            assert.include(log, 'sensorExit', 'the sensor never reported the overlap ending');
            assert.notInclude(
                log,
                'collisionEnter',
                'a sensor pair leaked into the collision channel'
            );
            assert.notInclude(log, 'collisionExit');
            assert.equal(log.filter((e) => e === 'sensorEnter').length, 1);
            assert.isBelow(box.position.y, 1, 'the box did not pass through the sensor');
        } finally {
            ps.destroy('contacts-sensor');
        }
    });
});

describe('sleep and wake', () => {
    test('a settling body sleeps, and an impulse wakes it', () => {
        const { ps } = makeWorld('contacts-sleep');
        try {
            const box = addBox(ps, 1);
            const log: string[] = [];
            box.onSleep((e) => {
                log.push('sleep');
                assert.equal(e.handle, box.handle);
                assert.equal(e.body, box);
            });
            box.onWake(() => log.push('wake'));

            for (let i = 0; i < 300 && !log.includes('sleep'); i++) ps.onUpdate(STEP);
            assert.deepEqual(log, ['sleep'], 'the body never went to sleep');
            assert.isTrue(box.isSleeping);

            // AddImpulse on a sleeping body does nothing; the body interface activates it
            ps.bodyInterface.ActivateBody(box.BodyID);
            box.addImpulse(new THREE.Vector3(0, 8, 0));
            for (let i = 0; i < 5 && !log.includes('wake'); i++) ps.onUpdate(STEP);
            assert.deepEqual(log, ['sleep', 'wake'], 'the impulse did not report a wake');
            assert.isFalse(box.isSleeping);
        } finally {
            ps.destroy('contacts-sleep');
        }
    });

    test('a body that is active from the start does not report a phantom wake', () => {
        const { ps } = makeWorld('contacts-nowake');
        try {
            const box = addBox(ps, 4);
            const log: string[] = [];
            box.onWake(() => log.push('wake'));
            ps.onUpdate(STEP);
            assert.deepEqual(log, [], 'AddBody delivered a wake to a handler added afterwards');
        } finally {
            ps.destroy('contacts-nowake');
        }
    });
});

describe('robustness', () => {
    test('a contact with a body BodySystem never registered does not throw', () => {
        const { ps, floorState } = makeWorld('contacts-unknown');
        try {
            // exactly what the vehicle chassis and the character rig anchor are: a Jolt body
            // created straight through the body interface, never added to BodySystem
            const shape = new Raw.module.BoxShapeSettings(new Raw.module.Vec3(0.5, 0.5, 0.5));
            const position = new Raw.module.RVec3(0, 2, 0);
            const rotation = new Raw.module.Quat(0, 0, 0, 1);
            const settings = new Raw.module.BodyCreationSettings(
                shape.Create().Get(),
                position,
                rotation,
                Raw.module.EMotionType_Dynamic,
                Layer.MOVING
            );
            const stranger = ps.bodyInterface.CreateBody(settings);
            ps.bodyInterface.AddBody(stranger.GetID(), Raw.module.EActivation_Activate);
            const strangerHandle = stranger.GetID().GetIndexAndSequenceNumber();
            Raw.module.destroy(settings);
            Raw.module.destroy(position);
            Raw.module.destroy(rotation);

            const seen: CollisionPayload[] = [];
            floorState.onCollisionEnter((e) => {
                seen.push({ ...e, target: { ...e.target }, other: { ...e.other } });
            });

            // this used to throw inside the WASM callback, and before that dropped the contact
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);

            const fromStranger = seen.find((e) => e.other.handle === strangerHandle);
            assert.isDefined(fromStranger, 'the unregistered body was dropped from the stream');
            assert.isUndefined(fromStranger!.other.body);
            assert.isUndefined(fromStranger!.other.object);
            assert.equal(fromStranger!.target.body, floorState);
        } finally {
            ps.destroy('contacts-unknown');
        }
    });

    test('a listener subscribed as an inline arrow is removed by its handle', () => {
        const { ps } = makeWorld('contacts-unsub');
        try {
            const box = addBox(ps, 1);
            let calls = 0;
            const off = box.on('collisionPersist', () => calls++);
            for (let i = 0; i < 40 && calls === 0; i++) ps.onUpdate(STEP);
            assert.isAbove(calls, 0, 'never fired');

            off();
            const after = calls;
            for (let i = 0; i < 10; i++) ps.onUpdate(STEP);
            assert.equal(calls, after, 'the handle did not remove the subscription');
            assert.equal(box.eventMask, 0, 'the mask still claims a subscriber');
        } finally {
            ps.destroy('contacts-unsub');
        }
    });

    test('a throwing handler does not break the step or the other handlers', () => {
        const { ps } = makeWorld('contacts-throw');
        try {
            const box = addBox(ps, 1);
            let good = 0;
            const originalError = console.error;
            console.error = () => {};
            try {
                box.onCollisionPersist(() => {
                    throw new Error('boom');
                });
                box.onCollisionPersist(() => good++);
                for (let i = 0; i < 40; i++) ps.onUpdate(STEP);
            } finally {
                console.error = originalError;
            }
            assert.isAbove(good, 0, 'a throwing handler swallowed the ones after it');
            assert.isFinite(box.position.y, 'the step was corrupted');
        } finally {
            ps.destroy('contacts-throw');
        }
    });
});

describe('cost', () => {
    test('200 steps with listeners attached allocate nothing on the Jolt heap', () => {
        const { ps } = makeWorld('contacts-alloc');
        try {
            const box = addBox(ps, 1);
            let enters = 0;
            let persists = 0;
            box.onCollisionEnter((e) => {
                enters++;
                void e.normal.y;
                void e.points.length;
            });
            box.onCollisionPersist(() => persists++);
            box.onCollisionExit(() => {});
            box.onSleep(() => {});
            box.onWake(() => {});

            // Warm everything (shared scratch singletons, the pools, the queue's arrays) before
            // counting; installAllocTracker swaps Raw.module's identity, which rebuilds the
            // joltScratch singletons once.
            for (let i = 0; i < 40; i++) ps.onUpdate(STEP);
            assert.isAbove(persists, 0, 'nothing was dispatched, so nothing was measured');

            const alloc = installAllocTracker(Raw);
            try {
                // one of each call first: the tracker swaps Raw.module's identity, which
                // rebuilds the shared joltScratch singletons once
                box.addImpulse(new THREE.Vector3(0, 0.02, 0));
                ps.onUpdate(STEP);
                const before = alloc.live();
                for (let i = 0; i < 200; i++) {
                    // keep it awake so contacts keep being reported
                    box.addImpulse(new THREE.Vector3(0, 0.02, 0));
                    ps.onUpdate(STEP);
                }
                assert.equal(alloc.live(), before, 'the dispatch path leaks Jolt objects');
                assert.equal(alloc.foreignDestroys(), 0, 'something freed a Jolt owned temporary');
            } finally {
                alloc.uninstall();
            }
            assert.isAbove(enters, 0);
        } finally {
            ps.destroy('contacts-alloc');
        }
    });

    test('no manifold work happens when nobody is listening', () => {
        const { ps } = makeWorld('contacts-zero');
        try {
            const box = addBox(ps, 1);
            for (let i = 0; i < 40; i++) ps.onUpdate(STEP);
            // the refcount is still maintained - it is public API in its own right
            assert.isAbove(box.contacts.size, 0, 'the pair refcount stopped being maintained');
            assert.equal(box.eventMask, 0);
            assert.equal(
                ps.bodySystem.eventQueue.length,
                0,
                'events were queued with no listeners'
            );
        } finally {
            ps.destroy('contacts-zero');
        }
    });
});

describe('motion sources', () => {
    test('a conveyor still writes ContactSettings, with no user listener attached', () => {
        const { ps } = makeWorld('contacts-conveyor');
        try {
            // a wide static "belt" whose surface drags things along -x
            const belt = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20));
            belt.position.set(0, 2, 0);
            const beltState = ps.bodySystem.getBody(
                ps.bodySystem.addBody(belt, { bodyType: 'static' })
            )!;
            beltState.motionAsSurfaceVelocity = true;
            beltState.activateMotionSource(new THREE.Vector3(-4, 0, 0));
            // the tier A bit is set even though nobody subscribed to anything
            assert.notEqual(beltState.eventMask, 0, 'the motion source bit was not set');

            const box = addBox(ps, 4, 0.5);
            for (let i = 0; i < 180; i++) ps.onUpdate(STEP);
            assert.isBelow(box.position.x, -0.5, 'the conveyor did not move the box');
        } finally {
            ps.destroy('contacts-conveyor');
        }
    });

    test('an impulse motion source goes through the pending action queue, not the step', () => {
        const { ps } = makeWorld('contacts-bouncer');
        try {
            const pad = new THREE.Mesh(new THREE.BoxGeometry(6, 1, 6));
            pad.position.set(0, 0.5, 0);
            const padState = ps.bodySystem.getBody(
                ps.bodySystem.addBody(pad, { bodyType: 'static' })
            )!;
            // no surface velocity: this path used to call addImpulse straight from inside
            // Step(), which goes through the body interface and is not allowed there
            padState.activateMotionSource(new THREE.Vector3(0, 400, 0));

            const box = addBox(ps, 3, 0.5);
            // the pad's resting contact height (box half-size 0.25 on a 1-unit-tall pad
            // centered at 0.5): once it settles here, the impulse is the only thing that can
            // send it up again.
            const restY = 1.25;
            let landed = false;
            let peakAfterLanding = 0;
            for (let i = 0; i < 120; i++) {
                ps.onUpdate(STEP);
                if (!landed && box.position.y <= restY + 0.05) landed = true;
                if (landed) peakAfterLanding = Math.max(peakAfterLanding, box.position.y);
            }
            // #304: this used to assert `peak > 3.5` (higher than the box's own drop height),
            // which only held because `handleMotionContact` fired the impulse once per
            // persisted-contact substep as well as once on contact-added - 2-3x too much,
            // exactly the "suddenly too strong" bounce pad bug in motionSources.tsx. A single,
            // correct application of (0, 400, 0) on this box's mass is nowhere near enough to
            // out-launch a 1.75m fall (it barely cancels the incoming velocity), so the
            // meaningful assertion is just that the box left the pad again at all.
            assert.isTrue(landed, 'the box never reached the pad');
            assert.isAbove(
                peakAfterLanding,
                restY + 0.3,
                'the bounce pad never launched the box back up'
            );
        } finally {
            ps.destroy('contacts-bouncer');
        }
    });
});

describe('ContactPairTracker', () => {
    test('counts sub-shape pairs, not body pairs', () => {
        const tracker = new ContactPairTracker();
        // Jolt's "empty" sub-shape id is -1, and real ids have their unused high bits set, so
        // these are full 32 bit values that cannot be packed into one number together.
        assert.equal(tracker.add(10, 20, -1, -1, false).count, 1);
        assert.equal(tracker.add(10, 20, -2, -1, false).count, 2);
        // the same sub pair twice does not double count
        assert.equal(tracker.add(10, 20, -2, -1, false).count, 2);
        // order of the two bodies does not matter
        assert.equal(tracker.count(20, 10), 2);

        // a manifold splitting between sub-shapes must not read as exit-then-enter
        assert.deepEqual(tracker.remove(20, 10, -1, -2), {
            count: 1,
            existed: true,
            sensor: false
        });
        assert.equal(tracker.size, 1);
        assert.deepEqual(tracker.remove(10, 20, -1, -1), {
            count: 0,
            existed: true,
            sensor: false
        });
        assert.equal(tracker.size, 0, 'the closed pair was not dropped');
        // a removal for a pair that is already gone is a no-op, not a negative count
        assert.isFalse(tracker.remove(10, 20, -1, -1).existed);
    });

    test('remembers whether a pair is a sensor overlap', () => {
        const tracker = new ContactPairTracker();
        tracker.add(1, 2, -1, -1, true);
        assert.isTrue(tracker.isSensorPair(2, 1));
        // OnContactRemoved carries no manifold, so the flag has to survive on the entry
        assert.isTrue(tracker.remove(1, 2, -1, -1).sensor);
    });
});
