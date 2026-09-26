// Ragdolls demo (issue #253): a GLTF character playing a walk animation in 'animated' mode,
// click-to-go-limp via setMode('ragdoll'), a respawn button that reuses the SAME RagdollSettings
// template (issue #275's fix - see docs/ragdolls.md), a pile of passive ragdolls dropped from
// height (also sharing that one template), and a debug capsule toggle.
//
// Uses `RagdollSystem` directly (not the `<Ragdoll>` component) for the hero + pile, because
// `<Ragdoll>` always builds a fresh template on mount with no way to hand it a pre-built one -
// see `RagdollActor` below. `PoweredRagdoll.tsx` (this same folder) shows the other, simpler way:
// the public `<Ragdoll>` component, for the common case that doesn't need template reuse.
import { Environment, useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import {
    Physics,
    type RagdollInstance,
    type RagdollMode,
    type RagdollTemplate,
    useAfterPhysicsStep,
    useBeforePhysicsStep,
    useJolt
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, useControls } from 'leva';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';
import {
    buildSoldierParts,
    type ClonedCharacter,
    cloneCharacter,
    restoreRootBonePosition,
    SOLDIER_URL
} from './ragdollCharacter';

//* RagdollActor: spawns/drives ONE instance from a shared template ==========================

interface RagdollActorProps {
    template: RagdollTemplate;
    source: THREE.Object3D;
    position: [number, number, number];
    mode: RagdollMode;
    debug: boolean;
    /** Bumping this destroys the current instance and spawns a fresh one from the SAME template - issue #275's respawn fix, exercised by the demo's "Respawn" button. */
    respawnKey: number;
    /** Clicking the character sets its mode to 'ragdoll' (limp). */
    clickToLimp?: boolean;
    /** Clip to play (from the source GLTF) while in 'animated' mode. */
    animationClip?: THREE.AnimationClip;
    onModeChange?: (mode: RagdollMode) => void;
}

function RagdollActor({
    template,
    source,
    position,
    mode,
    debug,
    respawnKey,
    clickToLimp,
    animationClip,
    onModeChange
}: RagdollActorProps) {
    const { physicsSystem } = useJolt();
    const { scene: r3fScene } = useThree();
    const groupRef = useRef<THREE.Group>(null);
    const instanceRef = useRef<RagdollInstance | undefined>(undefined);
    const mixerRef = useRef<THREE.AnimationMixer | undefined>(undefined);
    // Bumped after every (re)spawn so the debug-capsule effect below (which needs a live
    // `instanceRef.current`) re-runs - refs alone don't trigger effect re-runs.
    const [spawnGeneration, setSpawnGeneration] = useState(0);

    // Build + spawn (or respawn) whenever `respawnKey` changes - every run spawns from the SAME
    // `template`, never rebuilding it (see docs/ragdolls.md's "reusable template" finding).
    useEffect(() => {
        if (!physicsSystem || !groupRef.current) return;

        // `position` is baked into the CLONE's own transform (not a wrapping <group position>) -
        // see cloneCharacter/normalizeRagdollRoot's doc comments for why a positioned wrapper
        // silently breaks the 'animated'/'powered' drive target's root-position convention.
        const offset = new THREE.Vector3(...position);
        const cloned: ClonedCharacter = cloneCharacter(source, r3fScene, offset);
        groupRef.current.add(cloned.scene);

        const instance = physicsSystem.ragdollSystem.spawn(template, {
            bones: cloned.bones,
            activation: 'activate',
            mode,
            blendTime: 0.25
        });
        instanceRef.current = instance;

        // `spawn()` creates every part at the position BAKED INTO `template` at build time
        // (wherever the source character's bones sat when `buildTemplate` ran - here, an
        // unpositioned `gltf.scene`, i.e. effectively world origin) - it has no per-spawn
        // position/offset option of its own (see `SpawnRagdollOptions`). Left alone, every
        // instance spawned from one shared template - the whole point of the pile below, and of
        // reusing one template across respawns - would start stacked on top of each other at that
        // one baked location, regardless of `position`. Translate every part by the SAME `offset`
        // the visual clone above was placed with, keeping the rigid body (a uniform translation
        // preserves every constraint's relative geometry - nothing to resolve, no pop on the
        // first step) and the bind-pose-relative visual clone in agreement.
        for (const state of instance.bodyStates) {
            state.position = state.position.clone().add(offset);
        }

        let mixer: THREE.AnimationMixer | undefined;
        if (animationClip) {
            mixer = new THREE.AnimationMixer(cloned.scene);
            mixer.clipAction(animationClip).play();
            mixerRef.current = mixer;
        }

        setSpawnGeneration((n) => n + 1);

        return () => {
            instance.destroy();
            groupRef.current?.remove(cloned.scene);
            // The root bone (and its whole subtree) lives directly under `r3fScene`, not under
            // `cloned.scene` - see normalizeRagdollRoot - so it needs its own removal here.
            r3fScene.remove(cloned.bones[0]);
            mixer?.stopAllAction();
            mixerRef.current = undefined;
            instanceRef.current = undefined;
        };
        // `template`/`source`/`animationClip`/`mode`/`position` are read once per spawn by design
        // - `respawnKey` is the intentional re-run trigger; `mode` reactivity after spawn is its
        // own effect below, matching `<Ragdoll mode>`'s split between build-time and reactive props.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [physicsSystem, template, respawnKey]);

    // `mode` IS reactive after spawn (RagdollInstance.setMode) - matches `<Ragdoll mode>`.
    const lastMode = useRef(mode);
    useEffect(() => {
        if (!instanceRef.current) return;
        if (lastMode.current !== mode) instanceRef.current.setMode(mode);
        lastMode.current = mode;
    }, [mode, spawnGeneration]);

    // Debug capsules: same pattern as `<Ragdoll debug>` - add/remove each part's proxy Object3D
    // at the scene root (it was built with an identity world matrix, see ragdoll-system.ts).
    useEffect(() => {
        const instance = instanceRef.current;
        if (!instance) return;
        for (const state of instance.bodyStates) {
            if (debug) r3fScene.add(state.object);
            else r3fScene.remove(state.object);
            state.debug = debug;
        }
        return () => {
            for (const state of instance.bodyStates) r3fScene.remove(state.object);
        };
    }, [debug, r3fScene, spawnGeneration]);

    // Animation mixer update BEFORE the physics step, same rendered frame (issue #252's doc:
    // "not itself enforced by this package, the caller's useFrame priority ... has to make it
    // so") - negative priority runs before <Physics>'s own default-priority FrameStepper.
    useFrame(
        (_state, delta) => {
            mixerRef.current?.update(delta);
        },
        { priority: -1 }
    );

    useBeforePhysicsStep((delta) => instanceRef.current?.driveStep(delta));
    useAfterPhysicsStep((delta) => {
        const instance = instanceRef.current;
        if (!instance) return;
        instance.captureStep(delta);
        // issue #253's documented gap: captureStep() always zeroes the root bone's own local
        // translation - restore it from GetRootOffset() every substep. See ragdollCharacter.ts.
        restoreRootBonePosition(instance);
    });
    useFrame(() => {
        const instance = instanceRef.current;
        if (!instance) return;
        if (physicsSystem?.interpolate && physicsSystem.timeStep !== 'vary') {
            instance.applyInterpolated(physicsSystem.frameAlpha);
        }
    });

    // NOT positioned here - `position` is baked into the cloned character itself (see the spawn
    // effect above), so this group stays at identity and exists only as a click-target/mount
    // point for the visual scene.
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: r3f <group> is a 3D scene node, not an HTML/a11y element
        <group
            ref={groupRef}
            onClick={(e) => {
                if (!clickToLimp || !instanceRef.current) return;
                e.stopPropagation();
                onModeChange?.('ragdoll');
                instanceRef.current.setMode('ragdoll');
            }}
        />
    );
}

//* Scene: builds the shared template once, renders the hero + a pile from it ================

interface RagdollSceneProps {
    debug: boolean;
    heroMode: RagdollMode;
    setHeroMode: (mode: RagdollMode) => void;
    respawnKey: number;
}

function RagdollScene({ debug, heroMode, setHeroMode, respawnKey }: RagdollSceneProps) {
    const gltf = useGLTF(SOLDIER_URL);
    const { physicsSystem } = useJolt();
    const [template, setTemplate] = useState<RagdollTemplate>();

    const walkClip = useMemo(
        () => THREE.AnimationClip.findByName(gltf.animations, 'Walk') ?? undefined,
        [gltf.animations]
    );

    // Build the template exactly once, from the ORIGINAL loaded skeleton (never rebuilt - see
    // docs/ragdolls.md's "RagdollSettings is a reusable template"). Every RagdollActor below
    // spawns from THIS SAME template with its own cloned bones (SpawnRagdollOptions.bones).
    useEffect(() => {
        if (!physicsSystem) return;
        let mesh: THREE.SkinnedMesh | undefined;
        gltf.scene.traverse((c) => {
            if (!mesh && (c as THREE.SkinnedMesh).isSkinnedMesh) mesh = c as THREE.SkinnedMesh;
        });
        if (!mesh) return;
        const built = physicsSystem.ragdollSystem.buildTemplate(mesh.skeleton, {
            parts: buildSoldierParts(mesh.skeleton.bones),
            defaultConstraint: 'swingTwist'
        });
        setTemplate(built);
        return () => {
            built.destroy();
            setTemplate(undefined);
        };
    }, [physicsSystem, gltf]);

    const pilePositions = useMemo<[number, number, number][]>(
        () => [
            [3, 6, 0],
            [-3, 7, 1],
            [1.5, 9, -1.5],
            [-1.5, 8, 2],
            [0, 11, 0]
        ],
        []
    );

    if (!template) return null;

    return (
        <>
            <RagdollActor
                template={template}
                source={gltf.scene}
                position={[0, 1.05, 0]}
                mode={heroMode}
                debug={debug}
                respawnKey={respawnKey}
                clickToLimp
                animationClip={walkClip}
                onModeChange={setHeroMode}
            />
            {pilePositions.map((pos, i) => (
                <RagdollActor
                    key={i}
                    template={template}
                    source={gltf.scene}
                    position={pos}
                    mode="ragdoll"
                    debug={debug}
                    respawnKey={0}
                />
            ))}
        </>
    );
}

//* Top-level demo =============================================================================

export function Ragdolls() {
    const { module } = useDemo();
    const [debug, setDebug] = useState(false);
    const [heroMode, setHeroMode] = useState<RagdollMode>('animated');
    const [respawnKey, setRespawnKey] = useState(0);

    useControls('Ragdolls', {
        'debug capsules': { value: debug, onChange: setDebug },
        'hero mode': {
            value: heroMode,
            options: ['animated', 'powered', 'ragdoll'] as RagdollMode[],
            onChange: (v: RagdollMode) => setHeroMode(v)
        },
        Respawn: button(() => setRespawnKey((k) => k + 1))
    });

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
                <RagdollScene
                    debug={debug}
                    heroMode={heroMode}
                    setHeroMode={setHeroMode}
                    respawnKey={respawnKey}
                />
                <Floor size={80} position={[0, 0, 0]} />
            </Physics>
            <Environment preset="apartment" />
        </>
    );
}
