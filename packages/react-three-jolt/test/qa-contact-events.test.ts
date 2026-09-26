// QA round (#304): the ContactEvents example was "boring" but the maintainer also wants proof
// its three pads actually behave. This builds the same bodies, at the same numbers, that
// apps/examples/src/examples/ContactEvents.tsx drops onto its pads (floor at y=0 size 30, pads
// at x=-6/0/6, y=1.8, size [3, 0.6, 3], items dropped from y=9, gravity 20, restitution 0.35,
// friction 0.6) and asserts what the example claims: the solid pads report collisionEnter for a
// landing body, and the validate pad rejects every contact so its body passes straight through
// to the floor below instead of resting on the pad.
//
// One PhysicsSystem per test - see docs/events.md and test/contact-events.test.ts for the
// one-world-per-file WASM heap rule this file follows.

import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const GRAVITY = 20;
const PAD_Y = 1.8;
const PAD_SIZE = 3;
const PAD_HEIGHT = 0.6;
const DROP_Y = 9;
const FLOOR_SIZE = 30;

beforeAll(async () => {
    await initJolt();
});

/** The example's floor: a static box, top surface at y = 0.25. */
function makeFloor(ps: PhysicsSystem) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(FLOOR_SIZE, 0.5, FLOOR_SIZE));
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, { bodyType: 'static' }))!;
}

/** One of the example's three static pads. */
function makePad(ps: PhysicsSystem, x: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(PAD_SIZE, PAD_HEIGHT, PAD_SIZE));
    mesh.position.set(x, PAD_Y, 0);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, { bodyType: 'static' }))!;
}

/** One of the example's dropped boxes, at a pad's x, falling from the example's drop height. */
function dropBox(ps: PhysicsSystem, x: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, DROP_Y, 0);
    const box = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
    box.restitution = 0.35;
    box.friction = 0.6;
    return box;
}

describe('solid pads (props / useBodyEvent both go through the same body event API)', () => {
    test('a box dropped on a pad fires collisionEnter and comes to rest on it', () => {
        const ps = new PhysicsSystem('qa-contact-events-prop');
        ps.setGravity(GRAVITY);
        try {
            makeFloor(ps);
            const pad = makePad(ps, -6);
            const box = dropBox(ps, -6);

            let enters = 0;
            let lastPadHandle: number | undefined;
            pad.onCollisionEnter((e) => {
                enters++;
                lastPadHandle = e.other.handle;
            });

            for (let i = 0; i < 180 && !box.isSleeping; i++) ps.onUpdate(STEP);

            assert.isAbove(enters, 0, 'the pad never reported a collisionEnter');
            assert.equal(
                lastPadHandle,
                box.handle,
                'the enter payload was not for the dropped box'
            );
            // it rests on the pad (top at PAD_Y + PAD_HEIGHT/2), not on the floor far below
            assert.isAbove(
                box.position.y,
                PAD_Y,
                'the box fell through a pad that should catch it'
            );
            assert.closeTo(box.position.y, PAD_Y + PAD_HEIGHT / 2 + 0.5, 0.15);
        } finally {
            ps.destroy('qa-contact-events-prop');
        }
    });
});

describe('validate pad', () => {
    test('onContactValidate returning false rejects every contact, so the box passes through to the floor', () => {
        const ps = new PhysicsSystem('qa-contact-events-validate');
        ps.setGravity(GRAVITY);
        try {
            makeFloor(ps);
            const pad = makePad(ps, 0);
            const box = dropBox(ps, 0);

            let validations = 0;
            let entersOnPad = 0;
            pad.onContactValidate(() => {
                validations++;
                return false;
            });
            pad.onCollisionEnter(() => entersOnPad++);

            for (let i = 0; i < 180 && !box.isSleeping; i++) ps.onUpdate(STEP);

            assert.isAbove(
                validations,
                0,
                'onContactValidate never ran - the box never reached the pad'
            );
            assert.equal(entersOnPad, 0, 'a rejected contact still reported a collisionEnter');
            // it settles on the floor (top at y = 0.25), well below the pad it fell through
            assert.isBelow(box.position.y, PAD_Y, 'the box did not fall through the rejecting pad');
            assert.closeTo(box.position.y, 0.75, 0.15);
        } finally {
            ps.destroy('qa-contact-events-validate');
        }
    });
});
