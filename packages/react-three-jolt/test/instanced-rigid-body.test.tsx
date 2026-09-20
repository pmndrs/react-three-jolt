// Regression coverage for #24 (InstancedRigidBody never removed the bodies it created, and
// never released the InstancedMesh - or the geometry/material it owned - it built) and #143
// (BodyState's `set color` fell through its non-instanced branch into `setColorAt`, a method
// that only exists on THREE.InstancedMesh). Everything here runs against the real jolt-physics
// wasm module and the real InstancedRigidBodyMesh component, mounted with @react-three/test-renderer.
import { create, waitFor } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { InstancedRigidBodyMesh } from '../src/components/InstancedRigidBody';
import { Physics } from '../src/components/Physics';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { BodySystem } from '../src/systems/body-system';
import { installAllocTracker } from './jolt-alloc';

// See heightfield.test.tsx: <Physics> suspends on a real (async) wasm load, which
// @react-three/test-renderer's create() can't await through Suspense on its own. Pre-resolving
// the load and seeding suspend-react's cache means every `create()` below finds it already
// resolved and returns synchronously.
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function totalBodyCount(bodySystem: BodySystem) {
    return (
        bodySystem.dynamicBodies.size +
        bodySystem.staticBodies.size +
        bodySystem.kinematicBodies.size
    );
}

// Grabs the live BodySystem out of the Physics context so tests can assert on real body counts
// without reaching into component internals.
function BodySystemCapture({ onReady }: { onReady: (bodySystem: BodySystem) => void }) {
    const { bodySystem } = useJolt();
    React.useEffect(() => {
        onReady(bodySystem);
    }, [bodySystem, onReady]);
    return null;
}

const box = () => (
    <>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial />
    </>
);

test('unmount removes every body it created, releases the InstancedMesh, and leaks no Jolt allocations', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);

    // Warm-up pass, outside the tracker: creates and destroys one throwaway body so the shared
    // Jolt scratch objects (joltScratch etc.) are already built before we start counting.
    const warmup = bodySystem!.getBody(
        bodySystem!.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
    )!;
    warmup.destroy();
    assert.equal(totalBodyCount(bodySystem!), 0);

    const alloc = installAllocTracker(Raw);
    try {
        // installAllocTracker swaps Raw.module's identity, which rebuilds joltScratch's
        // singletons the first time something touches them again - do that under the tracker
        // before measuring the baseline, or that one-time rebuild reads as a "leak" below.
        const warmup2 = bodySystem!.getBody(
            bodySystem!.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
        )!;
        warmup2.destroy();
        const before = alloc.live();

        await renderer.update(
            <Physics>
                <BodySystemCapture onReady={capture} />
                <InstancedRigidBodyMesh count={20}>{box()}</InstancedRigidBodyMesh>
            </Physics>
        );
        await waitFor(() => totalBodyCount(bodySystem!) === 20);

        // remove the InstancedRigidBodyMesh from the tree - React runs its unmount cleanup the
        // same way a full renderer.unmount() would, but <Physics> (and bodySystem) stay alive so
        // there's something left to assert on afterwards.
        await renderer.update(
            <Physics>
                <BodySystemCapture onReady={capture} />
            </Physics>
        );

        assert.equal(totalBodyCount(bodySystem!), 0, 'unmount left bodies behind');
        assert.equal(
            alloc.live(),
            before,
            `unmount leaked ${alloc.live() - before} Jolt allocations: ${JSON.stringify(alloc.liveByType())}`
        );
    } finally {
        alloc.uninstall();
    }

    await renderer.unmount();
});

test('changing count adds/removes bodies incrementally, growing and shrinking, without leaking', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={20}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    await waitFor(() => totalBodyCount(bodySystem!) === 20);

    // shrinking used to throw: the old code copied up to the OLD count's worth of matrices into
    // the new (smaller) InstancedMesh's buffer, overrunning it.
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={10}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => totalBodyCount(bodySystem!) === 10);

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={30}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => totalBodyCount(bodySystem!) === 30);

    // PhysicsSystem.destroy() (see physics-system.ts) documents that React tears a parent down
    // before its children, so a bare `renderer.unmount()` would destroy the whole joltInterface
    // before InstancedRigidBodyMesh's own cleanup runs, and its removeBody calls would no-op on
    // an already-destroyed physics system. Assert teardown the way heightfield.test.tsx does:
    // remove the component via update() while <Physics> (and bodySystem) are still alive.
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    assert.equal(totalBodyCount(bodySystem!), 0);

    await renderer.unmount();
});

test('a StrictMode mount leaves exactly N bodies, and unmount clears them', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <React.StrictMode>
                <InstancedRigidBodyMesh count={7}>{box()}</InstancedRigidBodyMesh>
            </React.StrictMode>
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    await waitFor(() => totalBodyCount(bodySystem!) === 7);
    // give any (incorrect) duplicate creation a chance to show up before asserting
    await Promise.resolve();
    assert.equal(
        totalBodyCount(bodySystem!),
        7,
        'StrictMode mount left stale or duplicate bodies behind'
    );

    // see the comment in the count-change test above: assert teardown via update(), not the
    // renderer's own unmount().
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    assert.equal(totalBodyCount(bodySystem!), 0);

    await renderer.unmount();
});

test('mounting at count 0 and growing to 20 works (#194)', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    // count={0} used to throw "Cannot set properties of null (setting 'needsUpdate')": with no
    // instances `setColorAt` never runs, so three never lazily creates `instanceColor`.
    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={0}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    assert.equal(totalBodyCount(bodySystem!), 0, 'count 0 created bodies');

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={20}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => totalBodyCount(bodySystem!) === 20);

    // and back down to zero, which is the same guard from the other side
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh count={0}>{box()}</InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => totalBodyCount(bodySystem!) === 0);

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    await renderer.unmount();
});

test('setting color on an instanced body writes into the InstancedMesh color buffer', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };
    const instances = React.createRef<BodyState[]>();

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodyMesh ref={instances} count={3}>
                {box()}
            </InstancedRigidBodyMesh>
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    await waitFor(() => totalBodyCount(bodySystem!) === 3);
    await waitFor(() => !!instances.current && instances.current.length === 3);

    const instance = instances.current![1];
    const mesh = instance.object as THREE.InstancedMesh;
    assert.isTrue(mesh.isInstancedMesh, 'body did not resolve to the InstancedMesh');
    const versionBefore = mesh.instanceColor!.version;

    instance.color = '#ff00ff';

    const readBack = new THREE.Color();
    mesh.getColorAt(1, readBack);
    const expected = new THREE.Color('#ff00ff');
    assert.closeTo(readBack.r, expected.r, 1e-6);
    assert.closeTo(readBack.g, expected.g, 1e-6);
    assert.closeTo(readBack.b, expected.b, 1e-6);
    // `needsUpdate` is a write-only setter (no getter) - `version` is how three.js itself proves
    // the GPU buffer was told to re-upload.
    assert.isAbove(
        mesh.instanceColor!.version,
        versionBefore,
        'instanceColor.needsUpdate was never set'
    );

    // a neighboring instance must be untouched
    mesh.getColorAt(0, readBack);
    assert.notEqual(readBack.getHexString(), expected.getHexString());

    await renderer.unmount();
});

test('setting color on a body wrapping a plain mesh updates its material without touching a shared material', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);

    // Two plain (non-instanced) bodies whose meshes share one material - exactly the case the
    // color setter must not break by mutating the material in place.
    const sharedMaterial = new THREE.MeshStandardMaterial({ color: '#00ff00' });
    const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedMaterial);
    const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sharedMaterial);
    meshB.position.set(5, 0, 0);

    const bodyA = bodySystem!.getBody(bodySystem!.addBody(meshA))!;
    const bodyB = bodySystem!.getBody(bodySystem!.addBody(meshB))!;
    assert.isFalse(bodyA.isInstance);
    assert.strictEqual(meshA.material, sharedMaterial);
    assert.strictEqual(meshB.material, sharedMaterial);

    // this used to fall through the missing `return` into `setColorAt`, which doesn't exist on
    // a plain THREE.Mesh
    expect(() => {
        bodyA.color = '#ff0000';
    }).not.toThrow();

    assert.notStrictEqual(
        meshA.material,
        sharedMaterial,
        'the color setter never cloned the material'
    );
    assert.strictEqual(
        meshB.material,
        sharedMaterial,
        'the sibling mesh lost its material reference'
    );
    assert.equal(
        (sharedMaterial as THREE.MeshStandardMaterial).color.getHexString(),
        '00ff00',
        'the shared material itself was mutated'
    );
    assert.equal((meshA.material as THREE.MeshStandardMaterial).color.getHexString(), 'ff0000');
    assert.equal(bodyA.color.getHexString(), 'ff0000');

    // a second write must reuse the same (already-owned) clone, not clone again
    const ownedMaterial = meshA.material;
    bodyA.color = '#0000ff';
    assert.strictEqual(meshA.material, ownedMaterial);

    bodyA.destroy();
    bodyB.destroy();
    await renderer.unmount();
});
