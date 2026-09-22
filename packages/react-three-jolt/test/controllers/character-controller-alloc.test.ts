// Issue #76 in the controllers package: the CharacterVirtual setters built a Jolt object with
// `vec3.jolt()` / `quat.jolt()` and destroyed it afterwards, which freed the caller's own object
// whenever the caller passed a Jolt vector in. They now go through the shared scratch objects,
// so the per-frame setters allocate nothing at all.
//
// The tracker lives in the core package's test folder; `Raw` is imported from the built
// `@react-three/jolt` bundle, which is the module the controllers actually talk to.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CharacterControllerSystem } from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

let ps: PhysicsSystem;
let cc: CharacterControllerSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('controllers-alloc');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    cc = new CharacterControllerSystem(ps);
});

const cases: [string, () => void][] = [
    ['position', () => (cc.position = new THREE.Vector3(0, 3, 0))],
    ['rotation', () => (cc.rotation = new THREE.Quaternion(0, 0, 0, 1))],
    ['linearVelocity', () => (cc.linearVelocity = new THREE.Vector3(1, 0, 0))],
    ['up', () => (cc.up = new THREE.Vector3(0, 1, 0))],
    ['shapeOffset', () => (cc.shapeOffset = new THREE.Vector3(0, 0, 0))],
    ['isSlopeTooSteep', () => void cc.isSlopeTooSteep(new THREE.Vector3(0, 1, 0))]
];

for (const [name, call] of cases) {
    test(`${name} leaves the live allocation count unchanged`, () => {
        call();
        const alloc = installAllocTracker(Raw);
        try {
            call(); // first call under the tracked module builds the shared scratch objects
            const before = alloc.live();
            for (let i = 0; i < 10; i++) call();
            assert.equal(
                alloc.live(),
                before,
                `${name} leaked ${alloc.live() - before} objects over 10 calls: ` +
                    JSON.stringify(alloc.liveByType())
            );
            assert.equal(alloc.foreignDestroys(), 0, `${name} freed something it does not own`);
        } finally {
            alloc.uninstall();
        }
    });
}

test('setters still take effect and the character still steps', () => {
    cc.position = new THREE.Vector3(0, 3, 0);
    assert.closeTo(cc.position.y, 3, 1e-3);
    cc.linearVelocity = new THREE.Vector3(1, 0, 0);
    assert.closeTo(cc.linearVelocity.x, 1, 1e-3);

    cc.move(new THREE.Vector3(1, 0, 0));
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.isFinite(cc.position.x);
    assert.isBelow(cc.position.y, 3, 'character did not fall onto the floor');
});

test('a Jolt vector handed to a setter survives the call', () => {
    // the exact shape of #76: hand a setter the Jolt vector the caller owns. The setter used to
    // pass it straight through to `destroy()`, so the caller's own `destroy()` was a double free.
    const alloc = installAllocTracker(Raw);
    try {
        // warm the shared scratch objects first, they are rebuilt per Jolt module
        cc.linearVelocity = new THREE.Vector3(0, 0, 0);
        const current = new Raw.module.Vec3(2, 4, 6);
        const before = alloc.live();
        cc.linearVelocity = current as never;
        assert.equal(alloc.live(), before, 'the setter freed the vector the caller owns');
        assert.equal(current.GetX(), 2);
        assert.closeTo(cc.linearVelocity.x, 2, 1e-3);
        // with the old passthrough this second free threw "double destroy"
        Raw.module.destroy(current);
        assert.equal(alloc.live(), before - 1);
    } finally {
        alloc.uninstall();
    }
});
