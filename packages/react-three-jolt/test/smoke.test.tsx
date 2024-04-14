import { create } from '@react-three/test-renderer';
import React from 'react';
import { test } from 'vitest';
import { Physics, RigidBody } from '../src';

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
