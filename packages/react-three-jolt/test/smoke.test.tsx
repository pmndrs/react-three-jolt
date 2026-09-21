import { create, waitFor } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import { preload } from 'suspend-react';
import { beforeAll, expect, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { PhysicsSystem } from '../src/systems/physics-system';

// `<Physics>` suspends on the async wasm load, and @react-three/test-renderer's `create()`
// cannot await through Suspense: it used to return here with the tree still suspended, the test
// unmounted a tree that had never mounted, and the load promise then resolved *after* the test
// function returned. React logged "a suspended resource finished loading ... not wrapped in
// act(...)" and a couple of "an update to Physics ... not wrapped in act(...)" from that
// detached microtask, which vitest forwards to the main process over its worker rpc. On a slow
// runner those landed while the file's environment was already being torn down, so the run
// failed with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` even
// though every test passed.
//
// Pre-resolving seeds suspend-react's cache so `create()` below mounts synchronously, and the
// test then owns the whole lifecycle: nothing is still in flight when it returns. (Same trick
// as physics-lifecycle.test.tsx and instanced-rigid-body.test.tsx.)
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Publishes the live world, so the test can tell "mounted" from "still suspended". */
function Capture({ onReady }: { onReady: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem);
    }, [physicsSystem, onReady]);
    return null;
}

test('smoke', async () => {
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture onReady={(s) => (system = s)} />
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );

    // the tree really mounted rather than hanging on Suspense, and the body reached the world
    await waitFor(() => !!system);
    await waitFor(() => system!.bodySystem.bodies.size >= 1);

    // A mounted <Physics> owns a real JoltInterface (~20MB of wasm heap) and a live frame loop,
    // so hand it back rather than leaving both running until the worker is torn down.
    await renderer.unmount();
    // `<Physics>` defers the world teardown past the commit onto a microtask; drain it so the
    // world is gone before the test returns.
    await act(async () => {
        await Promise.resolve();
    });
    expect(system!.destroyed).toBe(true);
});
