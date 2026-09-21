// <RigidBody dynamicMeshStrategy> / <Physics defaultDynamicMeshStrategy> (issue #211).
//
// `dynamicMeshStrategy` (issue #112) has always existed on `GenerateBodyOptions`, but the
// documented `'error'` opt-out was only reachable by building the body yourself through
// `bodySystem.addBody` - there was no way to ask for it from the component tree. These tests
// exercise the two new props end to end, through a real `<RigidBody>`/`<Physics>` mount.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { beforeAll, expect, test, vi } from 'vitest';
import { Physics, RigidBody } from '../src';
import { initJolt } from '../src/raw';

beforeAll(async () => {
    await initJolt();
});

test('<RigidBody type="dynamic" dynamicMeshStrategy="error"> around a trimesh throws', async () => {
    // React logs the effect's uncaught error to console.error before it propagates; keep the
    // test output clean the same way test/colliders.test.tsx's sensor-mix test does.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
        create(
            <Physics>
                <RigidBody type="dynamic" shape="trimesh" dynamicMeshStrategy="error">
                    <mesh>
                        <icosahedronGeometry args={[1, 1]} />
                    </mesh>
                </RigidBody>
            </Physics>
        )
    ).rejects.toThrow(/cannot simulate a dynamic body with a trimesh/);
    error.mockRestore();
});

test('a static body with the same trimesh and dynamicMeshStrategy="error" is unaffected', async () => {
    // the strategy only ever applies to a *dynamic* body - a static trimesh is always fine
    const renderer = await create(
        <Physics>
            <RigidBody type="static" shape="trimesh" dynamicMeshStrategy="error">
                <mesh>
                    <icosahedronGeometry args={[1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
    await renderer.unmount();
});

test('<Physics defaultDynamicMeshStrategy="error"> applies to a body that sets none of its own', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
        create(
            <Physics defaultDynamicMeshStrategy="error">
                <RigidBody type="dynamic" shape="trimesh">
                    <mesh>
                        <icosahedronGeometry args={[1, 1]} />
                    </mesh>
                </RigidBody>
            </Physics>
        )
    ).rejects.toThrow(/cannot simulate a dynamic body with a trimesh/);
    error.mockRestore();
});

test('a <RigidBody dynamicMeshStrategy> wins over <Physics defaultDynamicMeshStrategy>', async () => {
    // the world default is 'error'; the body explicitly opts back into the default 'convex'
    // behaviour, which warns and succeeds instead of throwing
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const renderer = await create(
        <Physics defaultDynamicMeshStrategy="error">
            <RigidBody type="dynamic" shape="trimesh" dynamicMeshStrategy="convex">
                <mesh>
                    <icosahedronGeometry args={[1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
    await renderer.unmount();
    warn.mockRestore();
});
