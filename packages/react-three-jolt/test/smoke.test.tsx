import { create } from '@react-three/test-renderer';
import React from 'react';
import { test } from 'vitest';
import { Physics, RigidBody } from '../src';

test('smoke', async () => {
    const renderer = await create(
        <Physics>
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );
    // A mounted <Physics> owns a real JoltInterface (~20MB of wasm heap) and a live frame loop,
    // so hand it back rather than leaving both running until the worker is torn down.
    await renderer.unmount();
});
