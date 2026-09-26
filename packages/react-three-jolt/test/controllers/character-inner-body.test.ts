// Issue #73 asked for Jolt's standard `Character` controller, on the grounds that it "acts
// within the physics simulation" and so suits NPCs that the world should collide with. That
// class isn't exposed by jolt-physics (and upstream considers it inferior to CharacterVirtual),
// but the property it was wanted for is reachable from CharacterVirtual: `mInnerBodyShape`
// creates a real body the character keeps glued to itself, which other bodies collide with.
//
// These tests prove the three things that matter: the body exists, the world actually collides
// with it, and it doesn't leak.

import * as THREE from 'three';
import { afterEach, assert, beforeAll, beforeEach, expect, test } from 'vitest';
import { CharacterControllerSystem } from '../../src/controllers/systems/character-controller';
import { initJolt, Layer, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
});

beforeEach(() => {
    ps = new PhysicsSystem('inner-body');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

// every test builds its own world; without this the wasm heap runs out after six of them
afterEach(() => {
    ps.destroy();
});

test('no inner body by default: the character is invisible to the rest of the world', () => {
    const cc = new CharacterControllerSystem(ps);
    try {
        assert.equal(cc.hasInnerBody, false);
        assert.equal(cc.innerBodyId, undefined);
    } finally {
        cc.destroy();
    }
});

test('innerBody: true creates a real body with a valid id', () => {
    const cc = new CharacterControllerSystem(ps, { innerBody: true });
    try {
        assert.equal(cc.hasInnerBody, true);
        const id = cc.innerBodyId;
        assert.isDefined(id);
        // an unassigned BodyID is cInvalidBodyID (0xffffffff); a real one indexes the body manager
        assert.notEqual(id!.GetIndexAndSequenceNumber(), 0xffffffff);
        assert.isTrue(ps.bodyInterface.IsAdded(id!), 'inner body should be added to the world');
    } finally {
        cc.destroy();
    }
});

test('a dynamic body resting against the character is held up by the inner body', () => {
    const cc = new CharacterControllerSystem(ps, { innerBody: true });
    try {
        cc.setCapsule(0.5, 2);
        cc.position = new THREE.Vector3(0, 0, 0);

        // a small box dropped just above the capsule's crown: with an inner body it lands on the
        // character, without one it falls straight through to the floor at y ~= -0.5
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4));
        box.position.set(0, 3.2, 0);
        const handle = ps.bodySystem.addBody(box, { bodyType: 'dynamic' });

        for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);

        const resting = ps.bodySystem.getBody(handle)!.position.y;
        expect(resting).toBeGreaterThan(1);
    } finally {
        cc.destroy();
    }
});

test('the same box falls past a character that has no inner body', () => {
    const cc = new CharacterControllerSystem(ps);
    try {
        cc.setCapsule(0.5, 2);
        cc.position = new THREE.Vector3(0, 0, 0);

        const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4));
        box.position.set(0, 3.2, 0);
        const handle = ps.bodySystem.addBody(box, { bodyType: 'dynamic' });

        for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);

        const resting = ps.bodySystem.getBody(handle)!.position.y;
        expect(resting).toBeLessThan(1);
    } finally {
        cc.destroy();
    }
});

test('setCapsule resizes the inner body, not just the character shape', () => {
    const cc = new CharacterControllerSystem(ps, { innerBody: true });
    try {
        const before = cc.innerBodyId!.GetIndexAndSequenceNumber();
        cc.setCapsule(0.8, 3);
        // SetInnerBodyShape swaps the shape in place: same body, new extents
        assert.equal(cc.innerBodyId!.GetIndexAndSequenceNumber(), before);
        const shape = ps.bodyInterface.GetShape(cc.innerBodyId!);
        const bounds = shape.GetLocalBounds();
        const height = bounds.mMax.GetY() - bounds.mMin.GetY();
        // capsule total height = height + 2 * radius = 3 + 1.6
        expect(height).toBeGreaterThan(4);
    } finally {
        cc.destroy();
    }
});

test('innerBodyLayer places the body on the requested object layer', () => {
    const cc = new CharacterControllerSystem(ps, {
        innerBody: true,
        innerBodyLayer: Layer.KINEMATIC
    });
    try {
        const layer = ps.bodyInterface.GetObjectLayer(cc.innerBodyId!);
        assert.equal(layer, Layer.KINEMATIC);
    } finally {
        cc.destroy();
    }
});

test('destroy() takes the inner body with it and leaks nothing', () => {
    // warm up: first construction builds shared scratch objects
    new CharacterControllerSystem(ps, { innerBody: true }).destroy();

    const alloc = installAllocTracker(Raw);
    try {
        const before = alloc.live();
        const cc = new CharacterControllerSystem(ps, { innerBody: true });
        const id = cc.innerBodyId!;
        assert.isTrue(ps.bodyInterface.IsAdded(id));
        cc.destroy();

        assert.equal(cc.innerBodyId, undefined, 'innerBodyId must not survive destroy()');
        assert.equal(
            alloc.live(),
            before,
            `leaked ${alloc.live() - before}: ${JSON.stringify(alloc.liveByType())}`
        );
        // NB: `foreignDestroys()` is deliberately not asserted here. A full construct/destroy
        // cycle frees a number of wrappers the tracker never saw allocated (it is installed
        // after the world and its borrowed filter objects exist), and the count is identical -
        // 15 at the time of writing - with and without an inner body. `live()` returning to its
        // starting value is the question that matters for this issue.
    } finally {
        alloc.uninstall();
    }
});
