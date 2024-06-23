import { act } from '@react-three/test-renderer';
import React from 'react';
import { describe, expect, test } from 'vitest';
import { Physics, RigidBody, RigidBodyRef, vec3 } from '../src';
import { JoltTestMount, create } from './test-utils';

describe('Smoke Tests', () => {
    test('gravity', async () => {
        const rigidBodyRef = React.createRef<RigidBodyRef>();

        const { joltContext } = await create((onReady) => (
            <Physics gravity={[0, -10, 0]}>
                <JoltTestMount ready={onReady} />

                <RigidBody ref={rigidBodyRef} type="dynamic">
                    <mesh>
                        <boxGeometry />
                    </mesh>
                </RigidBody>
            </Physics>
        ));

        const positionBefore = vec3.three(rigidBodyRef.current!.body.GetPosition());

        await act(async () => {
            joltContext.step(1 / 60);
        });

        const positionAfter = vec3.three(rigidBodyRef.current!.body.GetPosition());

        expect(positionBefore.y).toBeGreaterThan(positionAfter.y);
    });
});
