// Issue #88: bumping the character's head on a ceiling/overhang used to leave its upward
// velocity untouched, so it kept pushing into the obstacle (and visibly "floating" against it)
// until gravity alone canceled the velocity out several steps later. `CharacterContactListenerJS`
// now cancels the upward component of the velocity response for any contact whose normal falls
// within `headAngle` of straight-down (the underside of a ceiling), and fires `onHeadHit` once
// per such contact.
//
// These tests exercise the real WASM module (no mocks): a floor, a static box ceiling 2m above
// it, and a character jumping hard enough to reach 3m of unobstructed height.
//
// A single `PhysicsSystem` is shared across every test here (each scenario gets its own floor and
// character offset far apart on X), matching every other real-module test file in this repo
// (character-controller-alloc.test.ts, character-controller-destroy.test.ts, ...): creating a
// fresh `PhysicsSystem` per test was tried first and turned out to be flaky - a head/ceiling
// contact genuinely handled and canceled in one PhysicsSystem could still show up in another
// PhysicsSystem's `onHeadHit` results later in the same file, which is an artifact of running
// several independent Jolt worlds in one process/module rather than anything in this fix's logic.

import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import {
    CharacterControllerSystem,
    type HeadHitInfo
} from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('head-collision');
});

const GRAVITY = 9.81;
const TIME_STEP = 1 / 60;
// Enough impulse that, absent any obstruction, the character's feet would reach ~3m:
// peakHeight = jumpSpeed^2 / (2 * gravity).
const UNOBSTRUCTED_PEAK = 3;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * UNOBSTRUCTED_PEAK);

// A small capsule so a 2m-high ceiling sits well inside the jump's unobstructed range while the
// character still comfortably fits underneath it at rest. Total extent from feet to head is
// `height + 2 * radius`.
const CAPSULE_RADIUS = 0.3;
const CAPSULE_HEIGHT = 0.2;

// Each scenario gets its own floor (and optional ceiling) far enough apart on X that they can
// never physically interact within the same shared `PhysicsSystem`.
let nextLaneX = 0;
function nextLane() {
    nextLaneX += 100;
    return nextLaneX;
}

function makeFloor(x: number) {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(x, -0.5, 0); // top face at y = 0
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
}

// A static box whose underside sits at `undersideY`.
function makeCeiling(x: number, undersideY: number) {
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    ceiling.position.set(x, undersideY + 0.5, 0);
    ps.bodySystem.addBody(ceiling, { bodyType: 'static' });
}

function makeCharacter(x: number, onHeadHit?: (info: HeadHitInfo) => void) {
    const cc = new CharacterControllerSystem(ps);
    cc.setCapsule(CAPSULE_RADIUS, CAPSULE_HEIGHT);
    cc.jumpSpeed = JUMP_SPEED;
    cc.onHeadHit = onHeadHit;
    cc.position = new THREE.Vector3(x, 0.05, 0);
    return cc;
}

// Let the character land and settle onto the floor before driving a jump.
function settle(steps = 30) {
    for (let i = 0; i < steps; i++) ps.onUpdate(TIME_STEP);
}

// Run the simulation for `steps`, recording the peak feet height (relative to `startY`) and
// every head-hit event.
//
// The cancellation itself lands one step after the contact is detected (see the notes on
// `OnContactSolve` in character-controller.ts: it flags the hit, and `prePhysicsUpdate` applies
// `SetLinearVelocity` at the *start* of the next step, before that step recomputes movement) -
// so `velocityYAfterHitStep` is read one step later than `hitStepIndex`, matching "within one
// step of the contact" rather than "on the same step".
function runJump(cc: CharacterControllerSystem, steps: number) {
    let peakHeight = cc.position.y;
    let hitStepIndex = -1;
    let velocityYAfterHitStep = Number.NaN;
    const hits: HeadHitInfo[] = [];
    const onHeadHit = cc.onHeadHit;
    cc.onHeadHit = (info) => {
        hits.push(info);
        onHeadHit?.(info);
    };

    for (let i = 0; i < steps; i++) {
        ps.onUpdate(TIME_STEP);
        peakHeight = Math.max(peakHeight, cc.position.y);
        if (hitStepIndex === -1 && hits.length > 0) hitStepIndex = i;
        else if (hitStepIndex === i - 1) velocityYAfterHitStep = cc.linearVelocity.y;
    }
    return { peakHeight, hits, hitStepIndex, velocityYAfterHitStep };
}

describe('character head collision (issue #88)', () => {
    test('a ceiling contact cancels upward velocity within one step and fires onHeadHit once', () => {
        const x = nextLane();
        makeFloor(x);
        makeCeiling(x, 2); // 2m of clearance above the floor
        const cc = makeCharacter(x);
        settle();
        assert.isTrue(cc.isSupported, 'character did not settle onto the floor before jumping');

        cc.jump();
        const { peakHeight, hits, hitStepIndex, velocityYAfterHitStep } = runJump(cc, 180);

        assert.isAbove(hitStepIndex, -1, 'the character never registered a head/ceiling contact');
        assert.equal(hits.length, 1, 'onHeadHit should fire exactly once');
        assert.isAtMost(
            velocityYAfterHitStep,
            0,
            'vertical velocity was not canceled within one step of the head hit'
        );
        assert.isAtMost(hits[0].previousVerticalSpeed, JUMP_SPEED + 1e-6);
        assert.isAbove(
            hits[0].previousVerticalSpeed,
            0,
            'the head hit was reported while still moving up'
        );
        assert.isBelow(
            peakHeight,
            UNOBSTRUCTED_PEAK - 1,
            'the character rose far closer to the unobstructed 3m peak than the 2m ceiling allows'
        );

        cc.destroy();
    });

    test('without a ceiling in range, vertical velocity stays positive for several steps after the peak would otherwise be blocked', () => {
        // Same jump, same character, but the ceiling is far out of reach - the character should
        // rise (and keep positive vertical velocity) well past where the 2m ceiling would have
        // stopped it, and never report a head hit.
        const x = nextLane();
        makeFloor(x);
        makeCeiling(x, 50);
        const cc = makeCharacter(x);
        settle();

        cc.jump();
        let sawVelocityAboveTwoMeterMark = false;
        for (let i = 0; i < 40; i++) {
            ps.onUpdate(TIME_STEP);
            if (cc.position.y > 2 && cc.linearVelocity.y > 0) sawVelocityAboveTwoMeterMark = true;
        }
        assert.isTrue(
            sawVelocityAboveTwoMeterMark,
            'the character should still be rising well past the 2m mark when nothing is in the way'
        );

        cc.destroy();
    });

    test('an open-sky jump reaches the same peak height as one with the ceiling far out of reach, and never fires onHeadHit', () => {
        const xOpen = nextLane();
        makeFloor(xOpen);
        const ccOpen = makeCharacter(xOpen);
        settle();
        ccOpen.jump();
        const openResult = runJump(ccOpen, 180);
        ccOpen.destroy();

        const xFar = nextLane();
        makeFloor(xFar);
        makeCeiling(xFar, 50); // present, but nowhere near the jump's reach
        const ccFar = makeCharacter(xFar);
        settle();
        ccFar.jump();
        const farResult = runJump(ccFar, 180);
        ccFar.destroy();

        assert.equal(openResult.hits.length, 0, 'an unobstructed jump must never fire onHeadHit');
        assert.equal(farResult.hits.length, 0, 'a distant ceiling must never fire onHeadHit');
        assert.closeTo(
            openResult.peakHeight,
            farResult.peakHeight,
            0.05,
            'the head-hit logic changed the peak height of a jump that never touches anything'
        );
        assert.isAbove(
            openResult.peakHeight,
            UNOBSTRUCTED_PEAK - 1,
            'the open-sky jump did not reach anywhere near its expected unobstructed peak'
        );
    });

    test('allocation count is unchanged across a jump that includes a head hit', () => {
        const x = nextLane();
        makeFloor(x);
        makeCeiling(x, 2);
        const cc = makeCharacter(x);
        settle();

        const alloc = installAllocTracker(Raw);
        try {
            ps.onUpdate(TIME_STEP); // warm-up step: rebuilds the shared scratch singletons
            const before = alloc.live();

            cc.jump();
            for (let i = 0; i < 90; i++) ps.onUpdate(TIME_STEP);

            assert.equal(
                alloc.live(),
                before,
                `jumping into a ceiling leaked ${alloc.live() - before} objects: ` +
                    JSON.stringify(alloc.liveByType())
            );
            assert.equal(
                alloc.foreignDestroys(),
                0,
                'jumping into a ceiling freed something it does not own'
            );
        } finally {
            alloc.uninstall();
            cc.destroy();
        }
    });
});
