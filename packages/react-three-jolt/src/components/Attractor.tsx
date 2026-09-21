// <Attractor> and useAttractor (issue #159).
//
// A point in the world that pulls (or, with a negative strength, pushes) every dynamic body
// within `range` of it. The API mirrors @react-three/rapier's `<Attractor>` - same prop names,
// same three falloff curves, same `gravitationalConstant` - so a scene can be ported across.
//
// It runs from `useBeforePhysicsStep` (#157), NOT from `useFrame`: a force applied once per
// rendered frame is frame rate dependent, because a frame may run zero, one or five physics
// substeps. Per substep is the only place a force means a fixed amount of momentum.

import React, { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useBeforePhysicsStep, useJolt } from '../hooks';
import type { BodyState } from '../systems/body-state';
import { joltScratch } from '../utils';

/**
 * How the pull falls off with distance, given strength `s`, range `r`, distance `d`, the
 * attracted body's mass `m` and the gravitational constant `G`:
 *
 * - `'static'` - `s`. Constant everywhere inside `range`, and independent of mass: every body
 *   accelerates the same. The default, and the easiest to tune.
 * - `'linear'` - `s * (d / r)`. Ramps *up* with distance, so it is gentlest at the centre. This
 *   is rapier's curve, kept identical for parity.
 * - `'newtonian'` - `G * s * m / d²`. Real gravity: inverse square, proportional to mass. Needs
 *   a very large `strength` to do anything with the default `G` of 6.673e-11.
 */
export type AttractorType = 'static' | 'linear' | 'newtonian';

export interface AttractorOptions {
    /**
     * World position of the attractor, when there is no `target`. `<Attractor>` passes its own
     * group instead, which is what makes it respect the transform of whatever it is nested in.
     */
    position?: THREE.Vector3 | [number, number, number];
    /** An object whose *world* position is the attractor's, re-read every substep. */
    target?: RefObject<THREE.Object3D | null>;
    /** Force magnitude at the curve's reference point. Negative repels. @default 1 */
    strength?: number;
    /** Bodies further than this from the attractor are untouched. @default 10 */
    range?: number;
    /** Which falloff curve to use. See {@link AttractorType}. @default 'static' */
    type?: AttractorType;
    /** Only used by `type="newtonian"`. @default 6.673e-11 */
    gravitationalConstant?: number;
    /** Stop attracting without unmounting (and without unsubscribing). @default true */
    enabled?: boolean;
    /**
     * `'force'` accumulates into the body for this one substep, which is frame rate independent
     * and what you almost always want. `'impulse'` changes the velocity directly, ignoring both
     * mass and the substep length; it is here because rapier's attractor works that way.
     * @default 'force'
     */
    mode?: 'force' | 'impulse';
    /**
     * Only attract bodies whose collision group id is this one (`<RigidBody group>`). Left out,
     * every dynamic body in range is attracted.
     */
    group?: number;
    /**
     * Arbitrary per-body filter, called once per body per substep. Return false to skip it. Must
     * not create or destroy bodies - it runs inside the step callback.
     */
    filter?: (body: BodyState) => boolean;
    /**
     * Wake sleeping bodies that come into range. Without this an attractor cannot start a body
     * moving, and - worse - Jolt never clears the force accumulated on a sleeping body, so the
     * pull would go off all at once whenever something else happened to wake it.
     * @default true
     */
    activate?: boolean;
}

/** Everything the step callback reads, kept in one mutable object so the callback never closes over props. */
type AttractorParams = Required<
    Pick<
        AttractorOptions,
        'strength' | 'range' | 'type' | 'gravitationalConstant' | 'enabled' | 'mode' | 'activate'
    >
> & {
    group?: number;
    filter?: (body: BodyState) => boolean;
};

/**
 * Attract every dynamic body within `range` of a point, once per physics substep.
 *
 * The imperative half of `<Attractor>`. Returns the world position the attraction is being
 * applied from, which is live: it is rewritten every substep and must not be retained.
 *
 * Zero allocations per step - the body list is walked with `forEach` and a hoisted callback, the
 * force goes through the shared `joltScratch` vector, and the parameters live in a mutable object
 * rather than in the callback's closure.
 */
export function useAttractor(options: AttractorOptions = {}): THREE.Vector3 {
    const { bodySystem, physicsSystem } = useJolt();
    const origin = useRef(new THREE.Vector3()).current;

    // Mutable parameter block, rewritten on every render and read (never captured) by the step
    // callback below.
    const params = useRef<AttractorParams>({
        strength: 1,
        range: 10,
        type: 'static',
        gravitationalConstant: 6.673e-11,
        enabled: true,
        mode: 'force',
        activate: true
    }).current;
    params.strength = options.strength ?? 1;
    params.range = options.range ?? 10;
    params.type = options.type ?? 'static';
    params.gravitationalConstant = options.gravitationalConstant ?? 6.673e-11;
    params.enabled = options.enabled ?? true;
    params.mode = options.mode ?? 'force';
    params.activate = options.activate ?? true;
    params.group = options.group;
    params.filter = options.filter;

    const targetRef = useRef<RefObject<THREE.Object3D | null> | undefined>(options.target);
    targetRef.current = options.target;
    const positionRef = useRef(options.position);
    positionRef.current = options.position;

    // One long lived per-body callback. `bodySystem.dynamicBodies.forEach(fn)` with a stable
    // `fn` is the only way to walk the map without allocating an iterator every substep.
    const applyToBody = useRef((state: BodyState): void => {
        const body = state.body;
        if (!body.IsDynamic()) return;
        if (params.group !== undefined && state.group !== params.group) return;
        if (params.filter && !params.filter(state)) return;

        // `GetPosition()` hands back a pointer to a static temporary: read it, never keep it,
        // never destroy it.
        const bodyPosition = body.GetPosition();
        const dx = origin.x - bodyPosition.GetX();
        const dy = origin.y - bodyPosition.GetY();
        const dz = origin.z - bodyPosition.GetZ();
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance === 0 || distance > params.range) return;

        let magnitude: number;
        switch (params.type) {
            case 'linear':
                magnitude = params.strength * (distance / params.range);
                break;
            case 'newtonian': {
                const inverseMass = body.GetMotionProperties().GetInverseMass();
                const mass = inverseMass > 0 ? 1 / inverseMass : 0;
                magnitude =
                    (params.gravitationalConstant * params.strength * mass) / (distance * distance);
                break;
            }
            default:
                magnitude = params.strength;
                break;
        }
        // Two attractors sitting on top of each other, or a zero range, would otherwise send a
        // body to infinity (and to NaN on the frame after that).
        if (!Number.isFinite(magnitude)) magnitude = params.strength;
        if (magnitude === 0) return;

        if (!body.IsActive()) {
            if (!params.activate) return;
            bodySystem.bodyInterface.ActivateBody(state.BodyID);
        }

        // normalise and scale in one multiply
        const scale = magnitude / distance;
        // `AddForce`/`AddImpulse` take the vector by value and accumulate it, so the shared
        // scratch object is safe and this stays allocation free. Legal here because the step
        // callback runs before `Step()`, with Jolt idle.
        const force = joltScratch.vec3(dx * scale, dy * scale, dz * scale);
        if (params.mode === 'impulse') body.AddImpulse(force);
        else body.AddForce(force);
    }).current;

    const step = useRef(() => {
        if (!params.enabled) return;
        if (physicsSystem.destroyed) return;
        const target = targetRef.current?.current;
        if (target) {
            // World position, so a nested `<Attractor>` follows whatever it is parented to.
            target.getWorldPosition(origin);
        } else {
            const position = positionRef.current;
            if (Array.isArray(position)) origin.set(position[0], position[1], position[2]);
            else if (position) origin.copy(position);
            else origin.set(0, 0, 0);
        }
        bodySystem.dynamicBodies.forEach(applyToBody);
    }).current;

    useBeforePhysicsStep(step);

    // Warm the shared scratch vector at mount rather than inside the first step, so an
    // allocation-counting test sees a flat line from the first substep on.
    useEffect(() => {
        joltScratch.vec3(0, 0, 0);
    }, []);

    return origin;
}

export interface AttractorProps extends Omit<AttractorOptions, 'target' | 'position'> {
    /** Local position, applied to the wrapper group - so it composes with any parent transform. */
    position?: THREE.Vector3 | [number, number, number];
    /** Anything you want to render at the attractor, e.g. a marker mesh. */
    children?: ReactNode;
}

/**
 * Pulls every dynamic body within `range` toward its world position, once per physics substep.
 *
 * ```tsx
 * <Attractor position={[0, 4, 0]} range={12} strength={40} type="linear" />
 * ```
 *
 * It renders a `<group>`, so it can be nested, animated or parented to a moving object and the
 * attraction follows - the world position of that group is re-read every substep. The step
 * subscription is removed on unmount.
 *
 * | prop | default | meaning |
 * | --- | --- | --- |
 * | `position` | `[0,0,0]` | local position of the wrapper group |
 * | `strength` | `1` | force magnitude; negative repels |
 * | `range` | `10` | bodies further away are untouched |
 * | `type` | `'static'` | `'static'` \| `'linear'` \| `'newtonian'` - see {@link AttractorType} |
 * | `gravitationalConstant` | `6.673e-11` | `'newtonian'` only |
 * | `mode` | `'force'` | `'force'` (frame rate independent) or `'impulse'` (rapier's behaviour) |
 * | `enabled` | `true` | turn the attraction off without unmounting |
 * | `group` | - | only attract bodies with this `<RigidBody group>` id |
 * | `filter` | - | `(body) => boolean`, called per body per substep |
 * | `activate` | `true` | wake sleeping bodies in range |
 */
export function Attractor({ position, children, ...options }: AttractorProps) {
    const ref = useRef<THREE.Group>(null);
    useAttractor({ ...options, target: ref });
    return (
        <group ref={ref} position={position}>
            {children}
        </group>
    );
}
