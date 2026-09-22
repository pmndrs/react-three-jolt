// Which CharacterContactListenerJS callbacks does jolt-physics 1.1.0 actually invoke?
//
// This was a live disagreement: the dependency bump found Jolt throwing "you forgot
// OnContactPersisted" until seven callbacks were assigned, while the events RFC read the 1.1.0
// typings as requiring exactly four. Neither is checkable statically - emscripten's
// JSImplementation glue does a *lazy* `hasOwnProperty` check, one per call site, and throws
// from inside the WASM callback only when Jolt reaches a callback JavaScript never assigned.
//
// So the answer is whatever the runtime does. This test wraps every callback the binding
// declares, runs a character against the world, and fails if Jolt called one the controller
// does not implement.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { CharacterControllerSystem } from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem } from '../../src/index';

// every method on CharacterContactListenerJS in jolt-physics 1.1.0 (dist/types.d.ts)
const DECLARED = [
    'OnAdjustBodyVelocity',
    'OnContactValidate',
    'OnCharacterContactValidate',
    'OnContactAdded',
    'OnContactPersisted',
    'OnContactRemoved',
    'OnCharacterContactAdded',
    'OnCharacterContactPersisted',
    'OnCharacterContactRemoved',
    'OnContactSolve',
    'OnCharacterContactSolve'
] as const;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('character-contacts');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // something to walk into, so contacts persist and are removed rather than never happening
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 20));
    wall.position.set(3, 1, 0);
    ps.bodySystem.addBody(wall, { bodyType: 'static' });
});

test('jolt only calls the character contact callbacks the controller implements', () => {
    const cc = new CharacterControllerSystem(ps);
    // biome-ignore lint/suspicious/noExplicitAny: the listener is deliberately untyped
    const listener = (cc as any).characterContactListener;

    const called = new Set<string>();
    const assigned = new Set<string>();
    const calledButUnassigned: string[] = [];

    for (const name of DECLARED) {
        const own = Object.hasOwn(listener, name);
        if (own) assigned.add(name);
        const original = listener[name];
        // Stays an own property either way, which is what the glue checks. For the unassigned
        // ones this stands in for the throw so the test reports the name instead of dying
        // inside WASM with a string exception.
        // biome-ignore lint/suspicious/noExplicitAny: passthrough
        listener[name] = (...args: any[]) => {
            called.add(name);
            if (!own) {
                calledButUnassigned.push(name);
                // the accept-everything default these all had before they existed
                return name.endsWith('Validate') ? true : undefined;
            }
            return original.apply(listener, args);
        };
    }

    cc.position = new THREE.Vector3(0, 3, 0);
    cc.move(new THREE.Vector3(1, 0, 0));
    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);
    // walk away again so contacts are removed as well as added
    cc.move(new THREE.Vector3(-1, 0, 0));
    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);

    assert.deepEqual(
        calledButUnassigned,
        [],
        'jolt called a CharacterContactListenerJS callback the controller does not assign'
    );

    // The empirical answer, recorded so a future jolt-physics bump that starts or stops calling
    // one of these fails here instead of at a user's runtime. Character-vs-character callbacks
    // only fire once a CharacterVsCharacterCollision is installed, which this controller never
    // does, so they stay unused.
    assert.deepEqual(
        [...called].sort(),
        [
            'OnAdjustBodyVelocity',
            'OnContactAdded',
            'OnContactPersisted',
            'OnContactRemoved',
            'OnContactSolve',
            'OnContactValidate'
        ],
        'the set of character contact callbacks jolt invokes changed'
    );
    assert.deepEqual(
        [...assigned].sort(),
        [...called].sort(),
        'the controller assigns a callback jolt never calls (dead code) or is missing one'
    );
});
