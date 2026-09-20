// useBeforePhysicsStep / useAfterPhysicsStep (issue #157) plus the step listener ordering they
// sit on. The ordering assertion is the contract T2's contact flush slots into:
//   beforeStep -> pending actions -> Step() -> queued events -> afterStep.

import { create } from '@react-three/test-renderer';
import React from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useAfterPhysicsStep, useBeforePhysicsStep, useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

beforeAll(async () => {
    await initJolt();
});

test('beforeStep runs before the step and afterStep after it', () => {
    const ps = new PhysicsSystem('step-order');
    try {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        box.position.set(0, 10, 0);
        const state = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

        const seen: string[] = [];
        let before = 0;
        let after = 0;
        ps.onBeforeStep(() => {
            seen.push('before');
            before = state.position.y;
        });
        ps.onAfterStep(() => {
            seen.push('after');
            after = state.position.y;
        });

        ps.onUpdate(1 / 60);
        assert.deepEqual(seen, ['before', 'after']);
        assert.isBelow(after, before, 'the body did not move between beforeStep and afterStep');
    } finally {
        ps.destroy('step-order');
    }
});

test('the deprecated add/removeStepListener pair still works, and now removes inline arrows', () => {
    const ps = new PhysicsSystem('step-legacy');
    try {
        let calls = 0;
        const fn = () => {
            calls++;
        };
        // registered on both lists, the case `removeContactListener`'s else-if chain got wrong
        ps.addPreStepListener(fn);
        ps.addPostStepListener(fn);
        ps.onUpdate(1 / 60);
        assert.equal(calls, 2);

        ps.removeStepListener(fn);
        ps.onUpdate(1 / 60);
        assert.equal(calls, 2, 'removeStepListener left a subscription behind');

        // the new return value works for an arrow, which identity removal never could
        const off = ps.addPreStepListener(() => calls++);
        ps.onUpdate(1 / 60);
        off();
        ps.onUpdate(1 / 60);
        assert.equal(calls, 3);
    } finally {
        ps.destroy('step-legacy');
    }
});

test('the step hooks subscribe once and unsubscribe on unmount', async () => {
    const counts = { before: 0, after: 0 };
    const order: string[] = [];
    let system: PhysicsSystem | undefined;

    const Probe = () => {
        const { physicsSystem } = useJolt();
        system = physicsSystem;
        // inline arrows: if the hook depended on callback identity this would resubscribe every
        // render, and the counts below would climb
        useBeforePhysicsStep(() => {
            counts.before++;
            order.push('before');
        });
        useAfterPhysicsStep(() => {
            counts.after++;
            order.push('after');
        });
        return null;
    };

    // The Probe mounts and unmounts inside a <Physics> that stays mounted throughout, so the
    // world is still alive when we assert that unmounting removed the subscriptions.
    const tree = (withProbe: boolean) => (
        <Physics>
            {withProbe ? <Probe /> : null}
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree(true));

    assert.isDefined(system);
    system!.onUpdate(1 / 60);
    assert.equal(counts.before, 1, 'beforeStep hook fired the wrong number of times');
    assert.equal(counts.after, 1);
    assert.deepEqual(order, ['before', 'after']);

    // a re-render must not add a second subscription
    await renderer.update(tree(true));
    system!.onUpdate(1 / 60);
    assert.equal(counts.before, 2, 'the hook resubscribed on re-render');
    assert.equal(counts.after, 2);

    // unmounting only the subscriber has to take both subscriptions with it
    await renderer.update(tree(false));
    const stepped = { ...counts };
    system!.onUpdate(1 / 60);
    assert.deepEqual(counts, stepped, 'a step hook survived unmount');

    await renderer.unmount();
});
