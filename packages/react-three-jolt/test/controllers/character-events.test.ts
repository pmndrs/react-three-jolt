// The character controller's event surface (issues #79 `isMoving`, #80 `isSliding`, and the
// `onAction` half of #50), against the real WASM module.
//
// `isMoving` and `isSliding` were declared fields that nothing ever assigned. They are now
// derived once per pre-step from the character's ground state and its velocity *relative to
// whatever is carrying it*, and `move`/`stop`, `slide`/`slideEnd`, `ground`/`airborne`, `land`
// and `jump` are the edges of that derivation.
//
// One PhysicsSystem per test where the geometry matters: every world shares the Jolt module and
// its body id space, and `maxInterfaces` is 3, so each test destroys its world.

import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import {
    type CharacterContactPayload,
    CharacterControllerSystem
} from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** A world with a big flat floor whose top surface is at y = -0.5. */
function makeWorld(pid: string) {
    const ps = new PhysicsSystem(pid);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400));
    floor.position.set(0, -1, 0);
    const floorHandle = ps.bodySystem.addBody(floor, { bodyType: 'static' });
    return { ps, floorHandle };
}

/** Drop the character onto the floor and let it settle, before anything is measured. */
function settle(ps: PhysicsSystem, cc: CharacterControllerSystem, steps = 60) {
    for (let i = 0; i < steps; i++) ps.onUpdate(STEP);
}

describe('move / stop (#79)', () => {
    test('walking emits move once, and stopping emits stop once', () => {
        const { ps } = makeWorld('character-move');
        const cc = new CharacterControllerSystem(ps);
        try {
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            assert.isTrue(cc.isGrounded, 'the character never reached the floor');
            assert.isFalse(cc.isMoving, 'standing still reads as moving');

            const log: string[] = [];
            const speeds: number[] = [];
            cc.events.on('move', (speed) => {
                log.push('move');
                speeds.push(speed);
            });
            cc.events.on('stop', () => log.push('stop'));

            cc.move(new THREE.Vector3(1, 0, 0));
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            assert.deepEqual(log, ['move'], 'walking did not emit exactly one move');
            assert.isTrue(cc.isMoving);
            assert.isAbove(speeds[0], cc.moveThreshold);

            cc.move(new THREE.Vector3(0, 0, 0));
            for (let i = 0; i < 120 && !log.includes('stop'); i++) ps.onUpdate(STEP);
            assert.deepEqual(log, ['move', 'stop'], 'stopping did not emit exactly one stop');
            assert.isFalse(cc.isMoving);

            // and it stays stopped: the hysteresis must not flap around the threshold
            for (let i = 0; i < 60; i++) ps.onUpdate(STEP);
            assert.deepEqual(log, ['move', 'stop']);
        } finally {
            cc.destroy();
            ps.destroy('character-move');
        }
    });

    test('riding a moving platform is not walking', () => {
        // #79's open question: `GetLinearVelocity()` includes the platform's velocity, so
        // without subtracting `GetGroundVelocity()` a passenger reads as a pedestrian.
        const ps = new PhysicsSystem('character-platform');
        const cc = new CharacterControllerSystem(ps);
        try {
            const platform = new THREE.Mesh(new THREE.BoxGeometry(40, 1, 40));
            platform.position.set(0, -1, 0);
            const handle = ps.bodySystem.addBody(platform, { bodyType: 'kinematic' });
            const platformBody = ps.bodySystem.getBody(handle)!;

            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            assert.isTrue(cc.isGrounded, 'the character never reached the platform');

            let moves = 0;
            cc.events.on('move', () => moves++);
            // carry the character along x at a speed well past the move threshold
            platformBody.velocity = new THREE.Vector3(6, 0, 0);
            for (let i = 0; i < 90; i++) {
                platformBody.velocity = new THREE.Vector3(6, 0, 0);
                ps.onUpdate(STEP);
            }

            assert.isAbove(cc.position.x, 1, 'the platform never carried the character');
            assert.equal(moves, 0, 'being carried was reported as moving');
            assert.isFalse(cc.isMoving);
        } finally {
            cc.destroy();
            ps.destroy('character-platform');
        }
    });
});

describe('slide (#80)', () => {
    test('a 60 degree ramp emits slide', () => {
        const ps = new PhysicsSystem('character-slide');
        try {
            // well past the 45 degree default max slope, so Jolt reports OnSteepGround
            const ramp = new THREE.Mesh(new THREE.BoxGeometry(60, 2, 60));
            ramp.position.set(0, 0, 0);
            ramp.rotation.z = THREE.MathUtils.degToRad(60);
            ramp.updateMatrixWorld();
            ps.bodySystem.addBody(ramp, { bodyType: 'static' });

            const cc = new CharacterControllerSystem(ps);
            try {
                cc.position = new THREE.Vector3(0, 4, 0);
                const log: string[] = [];
                const speeds: number[] = [];
                cc.events.on('slide', (speed) => {
                    log.push('slide');
                    speeds.push(speed);
                });
                cc.events.on('slideEnd', () => log.push('slideEnd'));

                for (let i = 0; i < 120 && log.length === 0; i++) ps.onUpdate(STEP);

                assert.deepEqual(log, ['slide'], 'the steep ramp never reported a slide');
                assert.isTrue(cc.isSliding);
                assert.equal(cc.groundState, 'OnSteepGround');
                assert.isAbove(speeds[0], cc.slideThreshold);
            } finally {
                cc.destroy();
            }
        } finally {
            ps.destroy('character-slide');
        }
    });

    test('standing on flat ground never reports sliding', () => {
        const { ps } = makeWorld('character-noslide');
        const cc = new CharacterControllerSystem(ps);
        try {
            let slides = 0;
            cc.events.on('slide', () => slides++);
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc, 120);
            assert.isTrue(cc.isGrounded);
            assert.isFalse(cc.isSliding);
            assert.equal(slides, 0);
        } finally {
            cc.destroy();
            ps.destroy('character-noslide');
        }
    });
});

describe('jump, land, ground and airborne', () => {
    test('jumping emits jump, then airborne, then ground and land', () => {
        const { ps } = makeWorld('character-jump');
        const cc = new CharacterControllerSystem(ps);
        try {
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            assert.isTrue(cc.isGrounded);

            const log: string[] = [];
            let airtime = -1;
            let jumpCount = -1;
            cc.events.on('jump', (count) => {
                log.push('jump');
                jumpCount = count;
            });
            cc.events.on('land', (time) => {
                log.push('land');
                airtime = time;
            });
            cc.events.on('ground', () => log.push('ground'));
            cc.events.on('airborne', () => log.push('airborne'));

            // the default jumpSpeed of 15 m/s under earth gravity is a little over 3 seconds of
            // flight, so give it a generous ceiling rather than a tight one
            cc.jump();
            for (let i = 0; i < 400 && !log.includes('land'); i++) ps.onUpdate(STEP);

            assert.include(log, 'jump', 'the jump was never reported');
            assert.include(log, 'airborne', 'leaving the ground was never reported');
            assert.include(log, 'land', 'the landing was never reported');
            assert.equal(jumpCount, 1, 'the first jump was not counted as the first');
            assert.isAbove(airtime, 0, 'the landing reported no air time');
            // ordering: jump, then airborne, then ground immediately before land
            assert.isBelow(log.indexOf('jump'), log.indexOf('airborne'));
            assert.isBelow(log.indexOf('airborne'), log.indexOf('land'));
            assert.equal(log[log.indexOf('land') - 1], 'ground', 'ground must precede land');
            assert.isTrue(cc.isGrounded);
        } finally {
            cc.destroy();
            ps.destroy('character-jump');
        }
    });
});

describe('forwarded contacts (#187)', () => {
    test('contactAdded / Persisted / Removed all fire, with a usable payload', () => {
        const { ps, floorHandle } = makeWorld('character-contacts');
        const cc = new CharacterControllerSystem(ps);
        try {
            // something to walk into so a contact is added, persisted and then removed
            const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 40));
            wall.position.set(6, 1, 0);
            const wallHandle = ps.bodySystem.addBody(wall, { bodyType: 'static' });

            const kinds: string[] = [];
            const seen: { handle: number; hasBody: boolean; normalLength: number }[] = [];
            const record = (kind: string) => (payload: CharacterContactPayload) => {
                kinds.push(kind);
                seen.push({
                    handle: payload.handle,
                    hasBody: payload.body !== undefined,
                    normalLength: payload.normal.length()
                });
            };
            cc.events.on('contactAdded', record('added'));
            cc.events.on('contactPersisted', record('persisted'));
            cc.events.on('contactRemoved', record('removed'));

            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            cc.move(new THREE.Vector3(1, 0, 0));
            for (let i = 0; i < 180; i++) ps.onUpdate(STEP);
            cc.move(new THREE.Vector3(-1, 0, 0));
            for (let i = 0; i < 180; i++) ps.onUpdate(STEP);

            assert.include(kinds, 'added');
            assert.include(kinds, 'persisted');
            assert.include(kinds, 'removed', 'a contact was never reported as removed');
            const floorContact = seen.find((c) => c.handle === floorHandle);
            assert.isDefined(floorContact, 'the floor never turned up in the contact stream');
            assert.isTrue(floorContact!.hasBody, 'a registered body resolved to undefined');
            assert.closeTo(floorContact!.normalLength, 1, 1e-3, 'the contact normal is not unit');
            assert.isDefined(
                seen.find((c) => c.handle === wallHandle),
                'the wall never turned up in the contact stream'
            );
        } finally {
            cc.destroy();
            ps.destroy('character-contacts');
        }
    });

    test('nothing is queued when nothing is subscribed', () => {
        const { ps } = makeWorld('character-contacts-zero');
        const cc = new CharacterControllerSystem(ps);
        try {
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            assert.equal(cc.events.mask, 0, 'the mask claims a subscriber');
            // the state edges still work with no contact subscription at all
            assert.isTrue(cc.isGrounded);
        } finally {
            cc.destroy();
            ps.destroy('character-contacts-zero');
        }
    });
});

describe('subscription and cost', () => {
    test('a listener subscribed as an inline arrow is removed by its handle', () => {
        const { ps } = makeWorld('character-unsub');
        const cc = new CharacterControllerSystem(ps);
        try {
            let calls = 0;
            const off = cc.events.on('contactPersisted', () => calls++);
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);
            assert.isAbove(calls, 0, 'never fired');

            off();
            const after = calls;
            for (let i = 0; i < 20; i++) ps.onUpdate(STEP);
            assert.equal(calls, after, 'the handle did not remove the subscription');
            assert.equal(cc.events.mask, 0, 'the mask still claims a subscriber');
            // and removing it twice is a no-op
            off();
            assert.equal(cc.events.listenerCount('contactPersisted'), 0);
        } finally {
            cc.destroy();
            ps.destroy('character-unsub');
        }
    });

    test('200 steps with every handler attached allocate nothing on the Jolt heap', () => {
        const { ps } = makeWorld('character-alloc');
        const cc = new CharacterControllerSystem(ps);
        try {
            let contacts = 0;
            for (const type of ['contactAdded', 'contactPersisted', 'contactRemoved'] as const)
                cc.events.on(type, (payload) => {
                    contacts++;
                    void payload.position.x;
                    void payload.normal.y;
                });
            for (const type of [
                'move',
                'stop',
                'slide',
                'slideEnd',
                'jump',
                'land',
                'ground',
                'airborne'
            ] as const)
                cc.events.on(type, () => {});

            cc.position = new THREE.Vector3(0, 0, 0);
            // warm everything (the queue's records, the shared scratch objects, the pools)
            // before counting: installAllocTracker swaps Raw.module's identity, which rebuilds
            // the joltScratch singletons once.
            settle(ps, cc, 90);
            cc.move(new THREE.Vector3(1, 0, 0));
            for (let i = 0; i < 30; i++) ps.onUpdate(STEP);
            assert.isAbove(contacts, 0, 'nothing was dispatched, so nothing was measured');

            const alloc = installAllocTracker(Raw);
            try {
                cc.move(new THREE.Vector3(1, 0, 0));
                ps.onUpdate(STEP);
                const before = alloc.live();
                for (let i = 0; i < 200; i++) {
                    // keep it walking, jumping and landing so every path is exercised
                    if (i % 50 === 0) cc.jump();
                    cc.move(new THREE.Vector3(i % 100 < 50 ? 1 : -1, 0, 0));
                    ps.onUpdate(STEP);
                }
                assert.equal(alloc.live(), before, 'the character event path leaks Jolt objects');
                assert.equal(alloc.foreignDestroys(), 0, 'something freed a Jolt owned temporary');
            } finally {
                alloc.uninstall();
            }
        } finally {
            cc.destroy();
            ps.destroy('character-alloc');
        }
    });
});

describe('the action API still agrees with the typed one', () => {
    test("on('move') sees the same edge as events.on('move')", () => {
        const { ps } = makeWorld('character-action');
        const cc = new CharacterControllerSystem(ps);
        try {
            cc.position = new THREE.Vector3(0, 0, 0);
            settle(ps, cc);

            const actions: unknown[] = [];
            const typed: unknown[] = [];
            const off = cc.on('move', (_action, payload) => actions.push(payload));
            cc.events.on('move', (speed) => typed.push(speed));

            cc.move(new THREE.Vector3(1, 0, 0));
            for (let i = 0; i < 60 && typed.length === 0; i++) ps.onUpdate(STEP);

            assert.equal(typed.length, 1);
            assert.deepEqual(actions, typed, 'the two subscription styles disagree');

            off();
            cc.move(new THREE.Vector3(0, 0, 0));
            for (let i = 0; i < 120; i++) ps.onUpdate(STEP);
            assert.equal(actions.length, 1, 'the action handle did not unsubscribe');
        } finally {
            cc.destroy();
            ps.destroy('character-action');
        }
    });
});
