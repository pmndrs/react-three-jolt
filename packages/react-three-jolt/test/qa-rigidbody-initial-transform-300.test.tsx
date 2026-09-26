// Regression coverage for #300: a newly mounted <RigidBody> (or a newly added
// <InstancedRigidBodies> instance) used to sit at its default identity transform - the origin -
// until a later effect (or the next physics tick) moved it, which is exactly the one-frame flash
// at 0,0,0 the maintainer saw in the FooterFunnel example before a freshly spawned body jumped
// into place.
//
// Headless caveat: there is no real requestAnimationFrame/paint boundary in this test
// environment (@react-three/test-renderer flushes layout *and* passive effects together, with
// no async gap between them the way a real browser leaves one before it paints), so "one
// browser-painted frame at the origin" cannot be observed directly here. A `useLayoutEffect`
// probe placed after <RigidBody> in the tree was tried and rejected for this reason - it passed
// even against the pre-fix code, because by the time it ran the passive body-creation effect had
// already run too, in the same flush.
//
// What CAN be proven headlessly instead, for <RigidBody>: before this fix, the object3D's
// position/rotation/scale were written *only* inside the body-creation effect, which bails out
// (via an early `return`) whenever no body ever gets created - e.g. `colliders={false}` with no
// collider children (a real, supported case: meshes-as-decoration-only, documented on the prop).
// In that case the old code left the object3D at its default transform forever, not just for one
// frame. This fix's own `useLayoutEffect` is unconditional - it runs regardless of whether a body
// is ever created - so the spawn transform now reaches the object3D even here. That is a
// deterministic, timing-independent difference between the old and new code, and this test fails
// against the pre-fix source and passes against the fix (verified by hand: `git stash` the source
// changes to RigidBody.tsx and re-run).
//
// For <InstancedRigidBodies> the bug is a genuine, headlessly-observable timing gap: a newly
// added instance's matrix is written only by the *next physics tick*
// (`PhysicsSystem.syncBodyToObject`), so the test below asserts the newest instance's
// `InstancedMesh` matrix already matches its real (jittered) spawn pose immediately after it is
// added, without ever calling `system.onUpdate()`.
import { create, waitFor } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import type { Mesh } from 'three';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { InstancedRigidBodies } from '../src/components/InstancedRigidBodies';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { BodySystem } from '../src/systems/body-system';

// <Physics> suspends on the real (async) wasm load, which @react-three/test-renderer's create()
// cannot await through Suspense on its own - see smoke.test.tsx for the full explanation.
// Pre-resolving seeds suspend-react's cache so every create()/update() below mounts synchronously.
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function BodySystemCapture({ onReady }: { onReady: (bodySystem: BodySystem) => void }) {
    const { bodySystem } = useJolt();
    React.useEffect(() => {
        onReady(bodySystem);
    }, [bodySystem, onReady]);
    return null;
}

function totalBodyCount(bodySystem: BodySystem) {
    return (
        bodySystem.dynamicBodies.size +
        bodySystem.staticBodies.size +
        bodySystem.kinematicBodies.size
    );
}

test('<RigidBody colliders={false}> with no collider children still gets its spawn transform even though no body is ever created', async () => {
    const meshRef = React.createRef<Mesh>();

    const renderer = await create(
        <Physics>
            {/* No collider children + colliders={false}: the body-creation effect bails out
                (devWarn + return) without ever creating a body - the old code's only path to
                setting the object3D's transform, so this is a case it could never reach. */}
            <RigidBody
                colliders={false}
                position={[3, 7, -2]}
                rotation={[0, Math.PI / 2, 0]}
                scale={[2, 2, 2]}
            >
                <mesh ref={meshRef}>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
    await waitFor(() => !!meshRef.current?.parent);
    // let any effects that were going to run have their chance to
    await new Promise((resolve) => setTimeout(resolve, 0));

    const object = meshRef.current!.parent!;
    assert.approximately(
        object.position.distanceTo(new THREE.Vector3(3, 7, -2)),
        0,
        1e-6,
        `object3D.position was ${object.position.toArray()} - the spawn position never reached ` +
            'the object3D'
    );
    const expectedQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, Math.PI / 2, 0)
    );
    assert.approximately(
        object.quaternion.angleTo(expectedQuaternion),
        0,
        1e-6,
        'object3D rotation never reached the object3D'
    );
    assert.approximately(
        object.scale.distanceTo(new THREE.Vector3(2, 2, 2)),
        0,
        1e-6,
        'object3D scale never reached the object3D'
    );

    await renderer.unmount();
});

const box = () => (
    <>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial />
    </>
);

test('<InstancedRigidBodies>: a newly added instance has its spawn matrix immediately, not just on the next physics tick', async () => {
    let bodySystem: BodySystem | undefined;
    const capture = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodies count={3}>{box()}</InstancedRigidBodies>
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    await waitFor(() => totalBodyCount(bodySystem!) === 3);

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
            <InstancedRigidBodies count={4}>{box()}</InstancedRigidBodies>
        </Physics>
    );
    await waitFor(() => totalBodyCount(bodySystem!) === 4);

    // No `system.onUpdate()` has run - if the InstancedMesh's matrix for the newest instance were
    // still whatever the mesh started with (identity), this would read back as the origin
    // regardless of the body's real (jittered) spawn pose.
    const states = [...bodySystem!.dynamicBodies.values()] as BodyState[];
    const newest = states.find((state) => state.index === 3);
    assert.isDefined(newest, 'the newest instance was not found in bodySystem.dynamicBodies');

    const matrix = new THREE.Matrix4();
    (newest!.object as THREE.InstancedMesh).getMatrixAt(newest!.index!, matrix);
    const matrixPosition = new THREE.Vector3().setFromMatrixPosition(matrix);
    const realPosition = newest!.position;

    assert.approximately(
        matrixPosition.distanceTo(realPosition),
        0,
        1e-5,
        `the InstancedMesh's matrix for the newest instance (${matrixPosition.toArray()}) did ` +
            `not match the body's real spawn pose (${realPosition.toArray()}) - it would have ` +
            'rendered at the origin for at least one frame before the next physics tick ' +
            'corrected it'
    );

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={capture} />
        </Physics>
    );
    assert.equal(totalBodyCount(bodySystem!), 0);

    await renderer.unmount();
});
