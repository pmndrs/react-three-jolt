// Activation accounting: `activeBodyCount`, `activityChange` and `settled` (issue #52).
//
// The count is maintained by the activation listener rather than by scanning bodies, which is
// the whole point: `settled` costs one integer comparison per step no matter how many bodies
// there are.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

function makeWorld(pid: string) {
    const ps = new PhysicsSystem(pid);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    return ps;
}

function addBox(ps: PhysicsSystem, x: number, y: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, 0);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
}

test('settled fires once when the last body falls asleep, and again after a wake', () => {
    const ps = makeWorld('activity-settled');
    try {
        const activity: [number, number][] = [];
        let settled = 0;
        ps.events.on('activityChange', (active, total) => activity.push([active, total]));
        ps.events.on('settled', () => settled++);

        const a = addBox(ps, 0, 1);
        const b = addBox(ps, 3, 1);
        // a static floor is never awake, so it is not part of the total
        assert.equal(ps.bodySystem.simulatedBodyCount, 2);
        assert.equal(ps.bodySystem.activeBodyCount, 2, 'AddBody did not count as an activation');

        for (let i = 0; i < 400 && settled === 0; i++) ps.onUpdate(STEP);

        assert.equal(settled, 1, 'the world never reported itself settled');
        assert.isTrue(ps.bodySystem.isSettled);
        assert.equal(ps.bodySystem.activeBodyCount, 0);
        assert.isTrue(a.isSleeping && b.isSleeping);

        // activityChange is edge triggered: one entry per change, ending at 0 of 2
        assert.deepEqual(activity.at(-1), [0, 2]);
        assert.isAtLeast(activity.length, 2);
        for (let i = 1; i < activity.length; i++)
            assert.notEqual(activity[i][0], activity[i - 1][0], 'a no-op change was reported');

        // staying asleep must not keep firing
        const settledAfter = settled;
        const activityAfter = activity.length;
        for (let i = 0; i < 30; i++) ps.onUpdate(STEP);
        assert.equal(settled, settledAfter, 'settled fired again while nothing moved');
        assert.equal(activity.length, activityAfter);

        // waking one body un-settles the world, and it settles again afterwards
        ps.bodyInterface.ActivateBody(a.BodyID);
        a.addImpulse(new THREE.Vector3(0, 6, 0));
        ps.onUpdate(STEP);
        assert.equal(ps.bodySystem.activeBodyCount, 1);
        assert.deepEqual(activity.at(-1), [1, 2]);

        for (let i = 0; i < 400 && settled === settledAfter; i++) ps.onUpdate(STEP);
        assert.equal(settled, settledAfter + 1, 'the world never settled a second time');
    } finally {
        ps.destroy('activity-settled');
    }
});

test('an empty world does not announce itself settled', () => {
    const ps = makeWorld('activity-empty');
    try {
        let settled = 0;
        const activity: number[] = [];
        ps.events.on('settled', () => settled++);
        ps.events.on('activityChange', (active) => activity.push(active));

        for (let i = 0; i < 10; i++) ps.onUpdate(STEP);
        assert.equal(settled, 0, 'a world that never moved claimed to have settled');
        assert.deepEqual(activity, [0], 'the initial state should be reported exactly once');
    } finally {
        ps.destroy('activity-empty');
    }
});

test('removing the last awake body settles the world', () => {
    const ps = makeWorld('activity-remove');
    try {
        let settled = 0;
        ps.events.on('settled', () => settled++);
        const box = addBox(ps, 0, 4);
        ps.onUpdate(STEP);
        assert.equal(ps.bodySystem.activeBodyCount, 1);

        // RemoveBody deactivates the body synchronously, which has to decrement the count
        ps.bodySystem.removeBody(box.handle);
        ps.onUpdate(STEP);
        assert.equal(ps.bodySystem.activeBodyCount, 0, 'a removed body stayed counted as awake');
        assert.equal(ps.bodySystem.simulatedBodyCount, 0);
        assert.equal(settled, 1);
    } finally {
        ps.destroy('activity-remove');
    }
});
