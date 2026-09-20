// Collision groups (issue #95).
//
// Two things were broken here. `BodySystem.standardCollisionGroup` was a SINGLE shared
// `Jolt.CollisionGroup` handed to every body that asked for one, so setting a group/sub group on
// one body rewrote the instance the next body was created from. And the runtime setters were
// stubbed out on the belief that `SetCollisionGroup` wasn't exposed - jolt-physics 1.1.0 has
// `BodyInterface.SetCollisionGroup(BodyID, CollisionGroup)`.
//
// Everything below runs against the real WASM module: two stacked boxes either rest on each other
// or fall through, which is the only assertion that actually proves the filter reached Jolt.
//
// The React trees are built with createElement so this file can stay a plain `.ts`.

import { create } from '@react-three/test-renderer';
import { createElement as h } from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

let ps: PhysicsSystem;
// every test drops its boxes in a fresh column so the shared world never has them interact
let laneX = 0;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('collision-groups');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

type BoxOptions = { group?: number; subGroup?: number; y: number };

function addBox({ group, subGroup, y }: BoxOptions, x: number): BodyState {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, 0);
    const handle = ps.bodySystem.addBody(mesh, { group, subGroup });
    const state = ps.bodySystem.getBody(handle);
    assert.isDefined(state, 'body was not registered');
    return state as BodyState;
}

function settle(frames = 240) {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
}

// A lower box resting on the floor with an upper box dropped on top of it. If the two collide the
// upper one comes to rest around y = 1.5; if the filter lets it pass it ends up on the floor at
// y = 0.5 like the lower one.
function stackedPair(lower: Omit<BoxOptions, 'y'>, upper: Omit<BoxOptions, 'y'>) {
    laneX += 10;
    return {
        lower: addBox({ ...lower, y: 0.5 }, laneX),
        upper: addBox({ ...upper, y: 3 }, laneX)
    };
}

test('two bodies in the same group stack when their sub groups collide', () => {
    ps.bodySystem.enableCollision(1, 2);
    const { upper } = stackedPair({ group: 7, subGroup: 1 }, { group: 7, subGroup: 2 });

    settle();
    assert.isAbove(
        upper.position.y,
        1.2,
        'the upper box fell through even though its sub group pair collides'
    );
});

test('disabling a sub group pair lets the two bodies fall through each other', () => {
    ps.bodySystem.disableCollision(3, 4);
    assert.isFalse(ps.bodySystem.isCollisionEnabled(3, 4));

    const { upper } = stackedPair({ group: 7, subGroup: 3 }, { group: 7, subGroup: 4 });

    settle();
    assert.isBelow(
        upper.position.y,
        1.2,
        'the upper box stacked even though collision between the sub groups is disabled'
    );

    // and it is only that pair: a different group id ignores the filter entirely
    ps.bodySystem.enableCollision(3, 4);
});

test('bodies in different groups ignore the sub group table', () => {
    ps.bodySystem.disableCollision(5, 6);
    // same sub group pair, but the GROUP ids differ - Jolt short circuits to "collide"
    const { upper } = stackedPair({ group: 10, subGroup: 5 }, { group: 11, subGroup: 6 });

    settle();
    assert.isAbove(upper.position.y, 1.2, 'different groups were filtered against each other');
    ps.bodySystem.enableCollision(5, 6);
});

test('setting a group on one body leaves every other body alone', () => {
    // the shared-instance bug: `standardCollisionGroup` was one object, so this used to move B too
    laneX += 10;
    const a = addBox({ group: 20, subGroup: 1, y: 5 }, laneX);
    const b = addBox({ group: 20, subGroup: 2, y: 5 }, laneX + 2);

    a.group = 99;
    a.subGroup = 8;

    assert.equal(a.group, 99, "body A's group did not take");
    assert.equal(a.subGroup, 8, "body A's sub group did not take");
    assert.equal(b.group, 20, "changing body A's group moved body B's too");
    assert.equal(b.subGroup, 2, "changing body A's sub group moved body B's too");

    // the `collisionGroup` / `collisionSubGroup` aliases are the same values
    assert.equal(a.collisionGroup, 99);
    assert.equal(a.collisionSubGroup, 8);
    b.collisionGroup = 21;
    b.collisionSubGroup = 9;
    assert.equal(b.group, 21);
    assert.equal(b.subGroup, 9);
});

test('changing a group at runtime takes effect on the next step', () => {
    ps.bodySystem.disableCollision(11, 12);

    // they start in DIFFERENT groups, so the disabled pair does not apply and they stack
    const { lower, upper } = stackedPair({ group: 30, subGroup: 11 }, { group: 31, subGroup: 12 });
    settle();
    assert.isAbove(upper.position.y, 1.2, 'the pair never stacked to begin with');

    // move the upper box into the lower one's group: now the disabled pair applies and it drops
    upper.group = 30;
    assert.equal(upper.group, 30, 'the runtime group change never reached the body');
    assert.isTrue(upper.body.IsActive(), 'the body was not woken by the group change');

    settle();
    assert.isBelow(
        upper.position.y,
        1.2,
        'the box did not fall through after being moved into the filtered group'
    );
    assert.closeTo(lower.position.y, 0.5, 0.2, 'the lower box moved');

    ps.bodySystem.enableCollision(11, 12);
});

test('a body created without a group can still be grouped later', () => {
    ps.bodySystem.disableCollision(13, 14);
    laneX += 10;
    const lower = addBox({ y: 0.5 }, laneX);
    const upper = addBox({ y: 3 }, laneX);

    lower.group = 40;
    lower.subGroup = 13;
    upper.group = 40;
    upper.subGroup = 14;

    settle();
    assert.isBelow(upper.position.y, 1.2, 'a lazily created collision group was not applied');
    ps.bodySystem.enableCollision(13, 14);
});

test('out of range sub groups are rejected instead of corrupting the filter table', () => {
    const bodySystem = ps.bodySystem;
    laneX += 10;
    const body = addBox({ group: 50, subGroup: 1, y: 5 }, laneX);

    // Jolt indexes a packed bit triangle with no release-build bounds check, so this used to
    // write outside the table.
    body.subGroup = bodySystem.subGroupCount + 100;
    assert.equal(body.subGroup, 1, 'an out of range sub group was written to the body');

    bodySystem.disableCollision(0, bodySystem.subGroupCount);
    bodySystem.disableCollision(-1, 0);
    // a sub group cannot be filtered against itself - the (n, n) slot aliases a real pair
    bodySystem.setGroupCollision(2, 2, false);
    assert.isTrue(bodySystem.isCollisionEnabled(0, 1), 'a rejected call still touched the table');
});

test('collision groups are freed when their bodies are removed', () => {
    // warm everything up first: the tracker swaps Raw.module's identity, and the filter table is
    // built lazily, so neither may happen inside the counted window.
    ps.bodySystem.enableCollision(1, 2);
    const alloc = installAllocTracker(Raw, {
        types: ['CollisionGroup'],
        throwOnDoubleDestroy: true
    });
    try {
        const before = alloc.live();

        laneX += 10;
        const handles = [
            addBox({ group: 60, subGroup: 1, y: 5 }, laneX).handle,
            addBox({ group: 60, subGroup: 2, y: 8 }, laneX).handle,
            // this one gets its group lazily, from the setter
            addBox({ y: 11 }, laneX).handle
        ];
        ps.bodySystem.getBody(handles[2])!.group = 60;

        assert.equal(alloc.live() - before, 3, 'a body did not get its own CollisionGroup');
        assert.isDefined(ps.bodySystem.getCollisionGroup(handles[0]));

        settle(10);
        handles.forEach((handle) => ps.bodySystem.removeBody(handle));

        assert.equal(alloc.live(), before, 'removing the bodies leaked their collision groups');
        assert.isUndefined(ps.bodySystem.getCollisionGroup(handles[0]));

        // Removing a body twice must not double free. `throwOnDoubleDestroy` watches wrapper
        // identity, so a second destroy of the same CollisionGroup fails here loudly.
        // (`foreignDestroys` is not asserted: only CollisionGroup is tracked, so every RVec3 /
        // Quat / BodyCreationSettings the body paths legitimately free counts as "foreign".)
        handles.forEach((handle) => ps.bodySystem.removeBody(handle));
        assert.equal(alloc.live(), before);
    } finally {
        alloc.uninstall();
    }
});

test('the group filter table is ref counted, not leaked', () => {
    const system = new PhysicsSystem('collision-groups-teardown');
    const bodySystem = system.bodySystem;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(0, 5, 0);
    const handle = bodySystem.addBody(mesh, { group: 1, subGroup: 1 });

    const table = bodySystem.groupFilter;
    // one reference of ours, one from the CollisionGroup we hold, one from the body's own copy
    assert.isAbove(table.GetRefCount(), 1, 'nothing took a reference on the filter table');

    bodySystem.removeBody(handle);
    bodySystem.destroy();
    system.destroy('collision-groups-teardown');
});

// --- react component ---------------------------------------------------------------------

function probe(box: { ps?: PhysicsSystem }) {
    return h(function Probe() {
        box.ps = useJolt().physicsSystem;
        return null;
    });
}

function tree(box: { ps?: PhysicsSystem }, bodyProps: Record<string, unknown>) {
    return h(
        Physics,
        { paused: true },
        probe(box),
        h(RigidBody, { position: [0, 5, 0], ...bodyProps }, h('mesh', null, h('boxGeometry', null)))
    );
}

const onlyBody = (world: PhysicsSystem) => [...world.bodySystem.dynamicBodies.values()][0];

test('<RigidBody group subGroup> reaches the body and stays reactive', async () => {
    const box: { ps?: PhysicsSystem } = {};
    const renderer = await create(tree(box, { group: 1, subGroup: 2 }));

    const world = box.ps!;
    assert.isDefined(world, '<Physics> never provided a physics system');
    const body = onlyBody(world);
    assert.isDefined(body, '<RigidBody> never created a body');
    assert.equal(body.group, 1, 'the group prop never reached the body');
    assert.equal(body.subGroup, 2, 'the subGroup prop never reached the body');
    assert.isDefined(
        world.bodySystem.getCollisionGroup(body.handle),
        'the body did not get its own CollisionGroup'
    );

    await renderer.update(tree(box, { group: 4, subGroup: 5 }));
    assert.equal(body.group, 4, 'changing the group prop did nothing');
    assert.equal(body.subGroup, 5, 'changing the subGroup prop did nothing');

    // 0 is a valid id and used to be swallowed by a truthy check
    await renderer.update(tree(box, { group: 0, subGroup: 0 }));
    assert.equal(body.group, 0, 'group={0} was ignored');
    assert.equal(body.subGroup, 0, 'subGroup={0} was ignored');

    await renderer.unmount();
});
