// <Ragdoll> (issue #251): a thin React wrapper around `RagdollSystem`, in the same spirit as
// `<RigidBody>` - finds the `SkinnedMesh` among its children, builds a `RagdollTemplate` from its
// `Skeleton` once on mount, spawns one `RagdollInstance` from it, and tears both down on unmount.
//
// `parts`/`layer` are deliberately NOT reactive: docs/ragdolls.md's spike found that rebuilding a
// `RagdollSettings` template repeatedly (instead of reusing one) corrupts the wasm heap after a
// couple of cycles, so this component builds its template exactly once per mount, the same way
// `<RigidBody>`'s shape is built once and then only ever *updated* in place, never rebuilt from
// scratch on every render.

import { useFrame, useThree } from '@react-three/fiber';
import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Layer } from '../constants';
import { useAfterPhysicsStep, useEventCallback, useForwardedRef, useJolt } from '../hooks';
import type { BodyState } from '../systems/body-state';
import type { BodyEventMap } from '../systems/events';
import {
    type RagdollInstance,
    type RagdollJointConstraint,
    type RagdollPartsConfig,
    type RagdollTemplate
} from '../systems/ragdoll-system';
import { anyVec3, devWarn, vec3 } from '../utils';

export interface RagdollProps {
    children?: ReactNode;
    /** Per-bone capsule/constraint overrides, keyed by bone name. Set once, at mount - see the module doc. */
    parts?: RagdollPartsConfig;
    /** Default constraint for every joint that doesn't say its own in `parts`. Default `'swingTwist'`. */
    defaultConstraint?: RagdollJointConstraint;
    /** Whether the ragdoll starts simulated. Default `true`. Flipping it to `true` after mount calls `Ragdoll.Activate()`; there is no documented way to deactivate a live ragdoll (see docs/ragdolls.md), so flipping it back to `false` after mount has no effect. */
    activate?: boolean;
    /** Jolt object layer every part is created on. Default `Layer.MOVING`, so the ragdoll collides with the world out of the box. */
    layer?: number;
    /** Draw a wireframe capsule for every part (reuses `BodyState.debug`, the same overlay `<RigidBody debug>` uses). */
    debug?: boolean;
    /** Imperative access: part `BodyState`s, `setVelocity`, `addImpulse`. */
    ref?: React.Ref<RagdollHandle | undefined>;

    //* Events --------------------------------------------
    // Same names/payloads as `<RigidBody>`, fanned out to every part's BodyState (issue #251:
    // "onCollisionEnter per part via existing body events") - `payload.target.object` is the
    // part's proxy Object3D, named after its bone, so a handler can tell parts apart.
    onCollisionEnter?: BodyEventMap['collisionEnter'];
    onCollisionPersist?: BodyEventMap['collisionPersist'];
    onCollisionExit?: BodyEventMap['collisionExit'];
    onSensorEnter?: BodyEventMap['sensorEnter'];
    onSensorExit?: BodyEventMap['sensorExit'];
    onSleep?: BodyEventMap['sleep'];
    onWake?: BodyEventMap['wake'];
}

export interface RagdollHandle {
    /** One `BodyState` per joint, `parts[i]` <-> the skeleton's joint index `i`. */
    parts: BodyState[];
    /** `parts[i]` for the joint named `boneName`. */
    getPart: (boneName: string) => BodyState | undefined;
    /** Set every part's linear velocity to the same value - a coherent "throw". */
    setVelocity: (velocity: anyVec3) => void;
    /** Add an impulse to one named part. Warns (and no-ops) for an unknown bone name. */
    addImpulse: (boneName: string, impulse: anyVec3) => void;
    /** The underlying instance, for anything this handle doesn't wrap directly. */
    instance: RagdollInstance;
}

/** Subscribe `handler` to one event type on every part of `instance`. Mirrors `useBodyEvent`. */
function useRagdollEvent<K extends keyof BodyEventMap>(
    instance: RagdollInstance | undefined,
    type: K,
    handler: BodyEventMap[K] | undefined
): void {
    const callback = useEventCallback(handler);
    const enabled = handler !== undefined;
    useEffect(() => {
        if (!instance || !enabled) return;
        const unsubs = instance.bodyStates.map((state) =>
            state.on(type, callback as BodyEventMap[K])
        );
        return () => {
            for (const off of unsubs) off();
        };
    }, [instance, enabled, type, callback]);
}

/** The first `SkinnedMesh` found in `root`'s subtree, or `undefined`. */
function findSkinnedMesh(root: THREE.Object3D | null): THREE.SkinnedMesh | undefined {
    if (!root) return undefined;
    let found: THREE.SkinnedMesh | undefined;
    root.traverse((child) => {
        if (!found && child instanceof THREE.SkinnedMesh) found = child;
    });
    return found;
}

// React 19 native convention (#49): a plain function component, `ref` is an ordinary prop.
export const Ragdoll = React.memo(function Ragdoll(props: RagdollProps) {
    const {
        children,
        parts,
        defaultConstraint,
        activate = true,
        layer = Layer.MOVING,
        debug = false,
        ref: forwardedRef,

        onCollisionEnter,
        onCollisionPersist,
        onCollisionExit,
        onSensorEnter,
        onSensorExit,
        onSleep,
        onWake
    } = props;

    const groupRef = useRef<THREE.Object3D>(null);
    const { physicsSystem } = useJolt();
    const { scene } = useThree();

    const built = useRef(false);
    const templateRef = useRef<RagdollTemplate | undefined>(undefined);
    const instanceRef = useRef<RagdollInstance | undefined>(undefined);
    const [instance, setInstance] = useState<RagdollInstance>();
    const ragdollRef = useForwardedRef<RagdollHandle | undefined>(forwardedRef ?? null, undefined);

    //* Build the template + spawn the instance, once ------------------------
    useEffect(() => {
        if (!physicsSystem || built.current) return;
        const mesh = findSkinnedMesh(groupRef.current);
        if (!mesh?.skeleton) {
            devWarn(
                'react-three-jolt: <Ragdoll> found no <skinnedMesh> among its children - ' +
                    'nothing to build a ragdoll from.'
            );
            return;
        }
        built.current = true;

        const template = physicsSystem.ragdollSystem.buildTemplate(mesh.skeleton, {
            parts,
            defaultConstraint,
            layer
        });
        const spawned = physicsSystem.ragdollSystem.spawn(template, {
            activation: activate ? 'activate' : 'deactivate'
        });
        templateRef.current = template;
        instanceRef.current = spawned;
        setInstance(spawned);
        // `parts`/`defaultConstraint`/`layer` are deliberately not deps (see the module doc) -
        // build-time only, and the `built` guard above makes this effect run its real body
        // exactly once regardless of how often `physicsSystem` or those props change.
    }, [physicsSystem]);

    //* Teardown, on unmount only ---------------------------------------------
    useEffect(() => {
        return () => {
            const instanceNow = instanceRef.current;
            if (instanceNow) {
                for (const state of instanceNow.bodyStates)
                    state.object.parent?.remove(state.object);
                instanceNow.destroy();
            }
            templateRef.current?.destroy();
            instanceRef.current = undefined;
            templateRef.current = undefined;
            built.current = false;
        };
        // unmount-only teardown: deps intentionally empty.
    }, []);

    //* Activation (issue #251's `activate` prop) -----------------------------
    const wasActive = useRef(activate);
    useEffect(() => {
        if (!instance) return;
        if (activate && !wasActive.current) instance.ragdoll.Activate();
        wasActive.current = activate;
    }, [instance, activate]);

    //* Debug capsules (reuses BodyState.debug, same overlay <RigidBody debug> uses) ----------
    useEffect(() => {
        if (!instance) return;
        for (const state of instance.bodyStates) {
            // Parented at the scene root, not under this component's own object3D: a part's
            // proxy Object3D was created (and its `invertedWorldMatrix` captured) as an
            // unparented object with an identity world matrix - see `RagdollSystem.spawn`. The
            // physics frame sync writes its pose assuming that same identity parent transform,
            // so it must stay at scene-root depth, not become a child of a group that might
            // itself be transformed.
            if (debug) scene.add(state.object);
            else scene.remove(state.object);
            state.debug = debug;
        }
        return () => {
            for (const state of instance.bodyStates) scene.remove(state.object);
        };
    }, [instance, debug, scene]);

    //* Per-frame pose sync (issue #251: after each step, write body transforms into the bones) -
    // `captureStep()` runs once per physics SUBSTEP (mirrors `BodyState.capturePose`, called from
    // `PhysicsSystem.fixedTimeStep`'s own per-substep loop) and, as a side effect, writes the live
    // (uninterpolated) pose onto the bones too. The `useFrame` below runs once per RENDERED frame,
    // after `<Physics>`'s own step (it is a descendant mounted after `<FrameStepper>`, so its
    // subscription is registered - and therefore called - later, the same ordering `<Debug>`
    // relies on) - when interpolation is on, it overwrites that live write with a properly
    // blended one, respecting interpolation the same way `<RigidBody>`'s own body-to-object sync
    // does (see `PhysicsSystem.syncBodyToObject`).
    useAfterPhysicsStep(() => instanceRef.current?.captureStep());
    useFrame(() => {
        const current = instanceRef.current;
        if (!current) return;
        if (physicsSystem.interpolate && physicsSystem.timeStep !== 'vary') {
            current.applyInterpolated(physicsSystem.frameAlpha);
        }
    });

    //* Events -------------------------------------------
    useRagdollEvent(instance, 'collisionEnter', onCollisionEnter);
    useRagdollEvent(instance, 'collisionPersist', onCollisionPersist);
    useRagdollEvent(instance, 'collisionExit', onCollisionExit);
    useRagdollEvent(instance, 'sensorEnter', onSensorEnter);
    useRagdollEvent(instance, 'sensorExit', onSensorExit);
    useRagdollEvent(instance, 'sleep', onSleep);
    useRagdollEvent(instance, 'wake', onWake);

    //* Imperative handle ---------------------------------
    useEffect(() => {
        if (!instance) {
            ragdollRef.current = undefined;
            return;
        }
        ragdollRef.current = {
            parts: instance.bodyStates,
            getPart: (boneName: string) => instance.getBodyState(boneName),
            setVelocity: (velocity: anyVec3) => {
                const v = vec3.three(velocity);
                for (const state of instance.bodyStates) state.velocity = v;
            },
            addImpulse: (boneName: string, impulse: anyVec3) => {
                const state = instance.getBodyState(boneName);
                if (!state) {
                    devWarn(`react-three-jolt: <Ragdoll> addImpulse - unknown bone "${boneName}"`);
                    return;
                }
                state.addImpulse(vec3.three(impulse));
            },
            instance
        };
    }, [instance, ragdollRef]);

    return <object3D ref={groupRef}>{children}</object3D>;
});
