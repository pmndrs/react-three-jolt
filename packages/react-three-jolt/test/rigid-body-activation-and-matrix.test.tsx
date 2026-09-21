// `<RigidBody activateOnChange>` and `<RigidBody matrixAutoUpdate>` (issues #167, #168): the
// declarative props reach `BodyState.activateOnChange` / `BodyState.matrixAutoUpdate`, both at
// creation and reactively.

import { create } from '@react-three/test-renderer';
import React from 'react';
import type { Object3D } from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** Captures the world so the test can step it by hand. */
function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

test('<RigidBody activateOnChange={false}> reaches BodyState and stops the group setter from waking it', async () => {
    let system: PhysicsSystem | undefined;
    const body = React.createRef<BodyState>();

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <RigidBody ref={body} activateOnChange={false} position={[0, 5, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    assert.isDefined(body.current);
    assert.isTrue(body.current!.activateOnChange === false, 'the prop did not reach BodyState');

    system!.bodyInterface.DeactivateBody(body.current!.BodyID);
    assert.isFalse(body.current!.body.IsActive());

    body.current!.group = 5;
    assert.isFalse(
        body.current!.body.IsActive(),
        'the group setter woke the body despite activateOnChange={false}'
    );

    await renderer.unmount();
});

test('<RigidBody matrixAutoUpdate={false}> reaches BodyState and the three.js object', async () => {
    let system: PhysicsSystem | undefined;
    const body = React.createRef<BodyState>();

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <RigidBody ref={body} matrixAutoUpdate={false} position={[0, 5, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    assert.isDefined(body.current);
    assert.isFalse(body.current!.matrixAutoUpdate, 'the prop did not reach BodyState');
    assert.isFalse(
        (body.current!.object as Object3D).matrixAutoUpdate,
        "the prop did not turn off three's own Object3D.matrixAutoUpdate"
    );

    for (let i = 0; i < 30; i++) system!.onUpdate(STEP);
    // still falling / resting - either way object.matrix should track the live pose, not stay
    // at its creation-time identity-composed value forever
    assert.notEqual(
        body.current!.object.matrix.elements[13],
        5,
        'object.matrix was never written to by the sync'
    );

    await renderer.unmount();
});
