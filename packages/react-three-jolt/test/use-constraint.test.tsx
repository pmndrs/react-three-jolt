// `useConstraint`'s cleanup used to call a `removeConstraint` that did nothing, so every
// constraint a component ever created outlived it. These tests mount the hook for real and
// check the physics system's constraint registry drains on unmount, including under
// StrictMode.

import { create } from '@react-three/test-renderer';
import React, { act, useRef } from 'react';
import * as THREE from 'three';
import { assert, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { useConstraint, useJolt } from '../src/hooks';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

const box = (x: number, y: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, 0);
    return mesh;
};

type HarnessProps = { onReady: (system: PhysicsSystem) => void };

/**
 * Makes its own bodies instead of using `<RigidBody>` so the test is about the constraint
 * hook only. The bodies are created on first render so both refs are populated by the time
 * the hook's effect runs.
 */
const Harness = ({ onReady }: HarnessProps) => {
    const { physicsSystem } = useJolt();
    const bodies = useRef<{ a: BodyState; b: BodyState } | null>(null);
    if (!bodies.current) {
        const bodySystem = physicsSystem.bodySystem;
        const a = bodySystem.getBody(bodySystem.addBody(box(0, 10), { bodyType: 'static' }))!;
        const b = bodySystem.getBody(bodySystem.addBody(box(0, 8)))!;
        bodies.current = { a, b };
        onReady(physicsSystem);
    }
    const a = useRef<BodyState | null>(bodies.current.a);
    const b = useRef<BodyState | null>(bodies.current.b);

    useConstraint('distance', a, b, { min: 0, max: 2 });
    return null;
};

test('useConstraint removes its constraint on unmount', async () => {
    let system: PhysicsSystem | undefined;
    const renderer = await create(
        <Physics>
            <Harness onReady={(s) => (system = s)} />
        </Physics>
    );

    await settle(() => system !== undefined);
    assert.isDefined(system, 'Physics never mounted its children');
    assert.equal(system!.constraintSystem.constraints.size, 1, 'constraint was not created');

    await renderer.unmount();
    assert.equal(system!.constraintSystem.constraints.size, 0, 'constraint outlived the component');
});

// r3f's reconciler currently renders twice but mounts effects once under StrictMode. This
// pins that down: if it ever starts double-invoking effects, the discarded first mount must
// still tear down exactly the constraint it created rather than leaving a second one behind.
test('useConstraint survives a StrictMode remount without leaking', async () => {
    let system: PhysicsSystem | undefined;
    const renderer = await create(
        <Physics>
            <React.StrictMode>
                <Harness onReady={(s) => (system = s)} />
            </React.StrictMode>
        </Physics>
    );

    await settle(() => system !== undefined);
    assert.isDefined(system, 'Physics never mounted its children');
    assert.equal(
        system!.constraintSystem.constraints.size,
        1,
        'StrictMode remount left a stale constraint behind'
    );

    await renderer.unmount();
    assert.equal(system!.constraintSystem.constraints.size, 0);
});
