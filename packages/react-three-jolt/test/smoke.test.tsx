import { create } from '@react-three/test-renderer';
import React from 'react';
import { assert, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import type { BodyState } from '../src/systems';

test('smoke', async () => {
    await create(
        <Physics>
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );
});

test('updates rigid body friction from props', async () => {
    const rigidBodyRef = React.createRef<BodyState>();

    const renderer = await create(
        <Physics>
            <RigidBody ref={rigidBodyRef} friction={0.9}>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.closeTo(rigidBodyRef.current!.body.GetFriction(), 0.9, 1e-3);

    await renderer.update(
        <Physics>
            <RigidBody ref={rigidBodyRef} friction={0}>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.closeTo(rigidBodyRef.current!.body.GetFriction(), 0, 1e-3);
});
