// <Ragdoll> (issue #251): the declarative wrapper around RagdollSystem. Builds its template from
// the first <skinnedMesh> found among its children (a synthetic one, built in code - no assets)
// and spawns one instance on mount.
//
// Each test mounts its own <Physics> tree (its own PhysicsSystem/world) and spawns at most once -
// see test/ragdoll-system.test.ts's module doc for why: a second `CreateRagdoll()` on the same
// PhysicsSystem, after a previous ragdoll on it was destroyed, is a known jolt-physics 1.1
// limitation, not something to work around by sharing a world across these tests.

import { create } from '@react-three/test-renderer';
import React from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, Ragdoll, type RagdollHandle, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { BodySystem } from '../src/systems/body-system';
import type { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** Captures the world so a test can step it by hand. */
function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

/** A synthetic SkinnedMesh (no assets, no loader) - root -> spine -> {armL, armR}. */
function SyntheticRig() {
    const mesh = React.useMemo(() => {
        const root = new THREE.Bone();
        root.name = 'root';
        root.position.set(0, 6, 0);
        const spine = new THREE.Bone();
        spine.name = 'spine';
        spine.position.set(0, -1.2, 0);
        root.add(spine);
        const armL = new THREE.Bone();
        armL.name = 'armL';
        armL.position.set(-0.6, -1, 0);
        spine.add(armL);
        const armR = new THREE.Bone();
        armR.name = 'armR';
        armR.position.set(0.6, -1, 0);
        spine.add(armR);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
        const skinned = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
        skinned.add(root);
        skinned.bind(new THREE.Skeleton([root, spine, armL, armR]));
        return skinned;
    }, []);
    return <primitive object={mesh} />;
}

const Floor = () => (
    <RigidBody type="static" position={[0, -0.5, 0]}>
        <mesh>
            <boxGeometry args={[500, 1, 500]} />
        </mesh>
    </RigidBody>
);

function totalDynamicBodies(bodySystem: BodySystem) {
    return bodySystem.dynamicBodies.size;
}

test('<Ragdoll> spawns one body per joint on mount, and removes them on unmount', async () => {
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Ragdoll>
                <SyntheticRig />
            </Ragdoll>
        </Physics>
    );

    assert.isDefined(system);
    // the effect that builds the template/spawns the instance runs on mount; give it a tick
    for (let i = 0; i < 2 && totalDynamicBodies(system!.bodySystem) === 0; i++)
        system!.onUpdate(STEP);

    assert.equal(totalDynamicBodies(system!.bodySystem), 4, 'expected one body per joint (4)');

    await renderer.update(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
        </Physics>
    );
    assert.equal(
        totalDynamicBodies(system!.bodySystem),
        0,
        'ragdoll bodies were not removed on unmount'
    );

    await renderer.unmount();
});

test('<Ragdoll> falls and reports onCollisionEnter per part when it lands', async () => {
    let system: PhysicsSystem | undefined;
    const enters: string[] = [];

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <Ragdoll onCollisionEnter={(e) => enters.push(e.target.object?.name ?? '?')}>
                <SyntheticRig />
            </Ragdoll>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 200 && enters.length === 0; i++) system!.onUpdate(STEP);

    assert.isAbove(enters.length, 0, 'no part reported landing on the floor');
    for (const name of enters) assert.isTrue(['root', 'spine', 'armL', 'armR'].includes(name));

    await renderer.unmount();
});

test('<Ragdoll> ref exposes parts/getPart/setVelocity/addImpulse, and the pose reaches the bones', async () => {
    let system: PhysicsSystem | undefined;
    // an object ref, not a callback ref: `useForwardedRef` (the same hook <InstancedRigidBodies>
    // uses) only understands `MutableRefObject`s - a callback ref is silently ignored.
    const handleRef = React.createRef<RagdollHandle | undefined>();
    let rootBone: THREE.Bone | undefined;

    function Rig() {
        const ref = React.useRef<THREE.Bone>(null);
        const mesh = React.useMemo(() => {
            const root = new THREE.Bone();
            root.name = 'root';
            root.position.set(0, 6, 0);
            const spine = new THREE.Bone();
            spine.name = 'spine';
            spine.position.set(0, -1.2, 0);
            root.add(spine);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
            geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
            geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
            const skinned = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
            skinned.add(root);
            skinned.bind(new THREE.Skeleton([root, spine]));
            rootBone = root;
            return skinned;
        }, []);
        return <primitive ref={ref} object={mesh} />;
    }

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Ragdoll ref={handleRef}>
                <Rig />
            </Ragdoll>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 2 && !handleRef.current; i++) system!.onUpdate(STEP);

    const handle = handleRef.current;
    assert.isDefined(handle);
    assert.equal(handle!.parts.length, 2);
    assert.isDefined(handle!.getPart('root'));
    assert.isDefined(handle!.getPart('spine'));
    assert.isUndefined(handle!.getPart('nonexistent'));

    const startY = rootBone!.position.y;
    for (let i = 0; i < 30; i++) system!.onUpdate(STEP);
    // captureStep() runs off `afterStep`, which fires from a plain onUpdate() call too - the
    // bone should have moved from its initial local position as the ragdoll fell.
    assert.notEqual(rootBone!.position.y, startY, 'the pose sync never wrote to the bone');

    assert.doesNotThrow(() => handle!.setVelocity([0, 5, 0]));
    assert.doesNotThrow(() => handle!.addImpulse('spine', [0, 0, 1]));

    await renderer.unmount();
});
