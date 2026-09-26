// PoweredRagdoll demo (issue #253): the public `<Ragdoll>` component (not the low-level
// `RagdollSystem` API `Ragdolls.tsx` uses for template reuse - this is the common case, one
// character, no respawn needed) walking in `mode="powered"` (SwingTwist motors drive it towards
// the animated pose, but an external hit can still shove it around - see docs/ragdolls.md's
// "Drive modes" section) while balls are thrown at it.
import { Environment, useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { BodyState } from '@react-three/jolt';
import {
    Physics,
    Ragdoll,
    type RagdollHandle,
    RigidBody,
    useAfterPhysicsStep
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';
import {
    buildSoldierParts,
    cloneCharacter,
    restoreRootBonePosition,
    SOLDIER_URL
} from './ragdollCharacter';

const CHEST_TARGET = new THREE.Vector3(0, 1.3, 0);

//* The powered character ======================================================================

function PoweredCharacter() {
    const gltf = useGLTF(SOLDIER_URL);
    const { scene: r3fScene } = useThree();
    // Cloned once for this demo's single character - `useMemo` (not per-render) so `<Ragdoll>`
    // only ever sees one stable SkinnedMesh across re-renders. `position` is baked into the clone
    // itself (not a wrapping <group position>) - see ragdollCharacter.ts's normalizeRagdollRoot
    // doc comment for why a positioned wrapper silently breaks 'powered' mode's drive target.
    const cloned = useMemo(
        () => cloneCharacter(gltf.scene, r3fScene, new THREE.Vector3(0, 1.05, 0)),
        [gltf, r3fScene]
    );
    const parts = useMemo(() => buildSoldierParts(cloned.bones), [cloned]);
    const walkClip = useMemo(
        () => THREE.AnimationClip.findByName(gltf.animations, 'Walk') ?? undefined,
        [gltf.animations]
    );
    const mixerRef = useRef<THREE.AnimationMixer | undefined>(undefined);
    const ragdollRef = useRef<RagdollHandle | undefined>(undefined);

    useEffect(() => {
        if (!walkClip) return;
        const mixer = new THREE.AnimationMixer(cloned.scene);
        mixer.clipAction(walkClip).play();
        mixerRef.current = mixer;
        return () => {
            mixer.stopAllAction();
            mixerRef.current = undefined;
        };
    }, [cloned, walkClip]);

    // The root bone (and its whole subtree) lives directly under `r3fScene`, not under
    // `cloned.scene` - see ragdollCharacter.ts's normalizeRagdollRoot - so it needs its own
    // removal when this demo route unmounts.
    useEffect(() => {
        return () => {
            r3fScene.remove(cloned.bones[0]);
        };
    }, [cloned, r3fScene]);

    // Drive the mixer BEFORE <Physics>'s own step, same rendered frame - see Ragdolls.tsx/
    // docs/ragdolls.md's "Drive modes" section for why this ordering matters for 'powered' mode
    // too (it reads the SAME `bones`-current-transform target 'animated' mode does).
    useFrame(
        (_state, delta) => {
            mixerRef.current?.update(delta);
        },
        { priority: -1 }
    );

    // issue #253's documented root-bone gap: `<Ragdoll>`'s own internal `captureStep()` always
    // zeroes the root bone's local translation (see docs/ragdolls.md / ragdollCharacter.ts). Its
    // public API has no option to fix this itself, so restore it from a PARENT-registered
    // `useAfterPhysicsStep` - effects commit bottom-up on mount, so this subscription registers
    // (and therefore runs) after `<Ragdoll>`'s own, the same ordering its module doc relies on
    // for `<Debug>`.
    useAfterPhysicsStep(() => {
        if (ragdollRef.current) restoreRootBonePosition(ragdollRef.current.instance);
    });

    return (
        <Ragdoll ref={ragdollRef} parts={parts} mode="powered" blendTime={0.3}>
            <primitive object={cloned.scene} />
        </Ragdoll>
    );
}

//* Balls thrown at the character ==============================================================

function Ball({ from }: { from: THREE.Vector3 }) {
    const bodyRef = useRef<BodyState | undefined>(undefined);
    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const velocity = CHEST_TARGET.clone().sub(from).normalize().multiplyScalar(10);
        velocity.y += 2.5; // a bit of an arc, not a flat line drive
        body.velocity = velocity;
    }, [from]);

    return (
        <RigidBody ref={bodyRef} position={from.toArray()} mass={3} restitution={0.2}>
            <mesh castShadow receiveShadow>
                <sphereGeometry args={[0.18, 20, 20]} />
                <meshStandardMaterial color="#ff8a3d" />
            </mesh>
        </RigidBody>
    );
}

let nextBallId = 0;

function BallThrower() {
    const [balls, setBalls] = useState<{ id: number; from: THREE.Vector3 }[]>([]);

    useEffect(() => {
        const spawn = () => {
            const angle = Math.random() * Math.PI * 2;
            const radius = 6;
            const from = new THREE.Vector3(
                Math.cos(angle) * radius,
                1.1 + Math.random() * 0.6,
                Math.sin(angle) * radius
            );
            // Keep at most 10 live balls so the demo doesn't grow the world forever.
            setBalls((current) => [...current.slice(-9), { id: nextBallId++, from }]);
        };
        spawn();
        const interval = setInterval(spawn, 1400);
        return () => clearInterval(interval);
    }, []);

    return (
        <>
            {balls.map((ball) => (
                <Ball key={ball.id} from={ball.from} />
            ))}
        </>
    );
}

//* Top-level demo =============================================================================

export function PoweredRagdoll() {
    const { module } = useDemo();

    return (
        <>
            <directionalLight
                castShadow
                position={[5, 10, 5]}
                intensity={3}
                shadow-normalBias={0.04}
            />
            <ambientLight intensity={1.2} />
            <Physics module={module} gravity={20}>
                <JoltMemoryRegistrar />
                <PoweredCharacter />
                <BallThrower />
                <Floor size={40} position={[0, 0, 0]} />
            </Physics>
            <Environment preset="apartment" />
        </>
    );
}
