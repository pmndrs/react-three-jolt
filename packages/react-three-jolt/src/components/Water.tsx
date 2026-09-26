// <Water> (issue #240): a box shaped water volume. Every dynamic body whose broad-phase AABB
// overlaps it gets `Body.ApplyBuoyancyImpulse` once per physics substep - see
// `systems/buoyancy-system.ts`, which does the actual work, and `useBuoyancy`, the imperative
// half of this component.
//
// Modeled on <Attractor>: renders a <group> so it composes with the scene tree, and re-syncs the
// registered volume whenever a prop changes rather than tearing it down and rebuilding it
// (`updateVolume` is a plain JS record replace, not a wasm allocation, so this costs nothing).
// Unlike <Attractor> it does not track a moving parent's *world* transform every substep -
// `surfaceHeight` in particular is used as given, so a <Water> nested under something that moves
// should keep it in world space itself.

import React, { type ReactNode, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useBuoyancy } from '../hooks/use-buoyancy';
import type { BodyState } from '../systems/body-state';
import type { BuoyancyVolumeOptions } from '../systems/buoyancy-system';
import { vec3 } from '../utils';

export interface WaterProps {
    /** Local position of the wrapper group / volume center. @default [0, 0, 0] */
    position?: THREE.Vector3 | [number, number, number];
    /** Full width/height/depth of the volume - not half-extents. @default [10, 4, 10] */
    size?: THREE.Vector3 | [number, number, number];
    /**
     * World space Y of the water surface. @default the top face of the box (`position.y +
     * size.y / 2`) - only meaningful in world space, so set this explicitly if `<Water>` is
     * nested under a transformed parent.
     */
    surfaceHeight?: number;
    /** How strongly a submerged body is pushed back up. @default 1.5 */
    buoyancy?: number;
    /** Linear velocity damping while (partially) submerged. @default 0.3 */
    linearDrag?: number;
    /** Angular velocity damping while (partially) submerged. @default 0.05 */
    angularDrag?: number;
    /** Fluid velocity - a current, added straight into the impulse. @default [0, 0, 0] */
    flow?: THREE.Vector3 | [number, number, number];
    /** Stop applying buoyancy without unmounting. @default true */
    enabled?: boolean;
    /** Wake a sleeping body whose AABB enters the volume. @default true */
    activate?: boolean;
    /** Only affect bodies with this `<RigidBody group>` id. */
    group?: number;
    /** Arbitrary per-body filter, called once per body per substep it overlaps this volume. */
    filter?: (body: BodyState) => boolean;
    /** Render a translucent plane at the surface, sized to the box's X/Z footprint. @default false */
    visible?: boolean;
    /** Surface plane color, when `visible`. @default '#3f83a3' */
    color?: THREE.ColorRepresentation;
    /** Surface plane opacity, when `visible`. @default 0.55 */
    opacity?: number;
    /** Anything else you want rendered at the volume, e.g. a custom surface mesh. */
    children?: ReactNode;
}

const DEFAULT_POSITION: [number, number, number] = [0, 0, 0];
const DEFAULT_SIZE: [number, number, number] = [10, 4, 10];
const DEFAULT_FLOW: [number, number, number] = [0, 0, 0];

/**
 * A box shaped body of water. Every dynamic body whose bounds overlap it floats, drags and rides
 * any `flow` current, once per physics substep - see `systems/buoyancy-system.ts`.
 *
 * ```tsx
 * <Water position={[0, 0, 0]} size={[20, 6, 20]} buoyancy={1.2} flow={[1, 0, 0]} visible />
 * ```
 *
 * | prop | default | meaning |
 * | --- | --- | --- |
 * | `position` | `[0,0,0]` | local position of the wrapper group / volume center |
 * | `size` | `[10,4,10]` | full box dimensions |
 * | `surfaceHeight` | top of the box | world space Y of the water surface |
 * | `buoyancy` | `1.5` | how strongly a submerged body is pushed back up |
 * | `linearDrag` / `angularDrag` | `0.3` / `0.05` | damping while (partially) submerged |
 * | `flow` | `[0,0,0]` | fluid velocity, a current |
 * | `enabled` | `true` | turn buoyancy off without unmounting |
 * | `activate` | `true` | wake a sleeping body the volume's AABB catches |
 * | `group` | - | only affect bodies with this `<RigidBody group>` id |
 * | `filter` | - | `(body) => boolean`, called per body per substep it overlaps |
 * | `visible` | `false` | render a translucent surface plane |
 */
export function Water({
    position = DEFAULT_POSITION,
    size = DEFAULT_SIZE,
    surfaceHeight,
    buoyancy,
    linearDrag,
    angularDrag,
    flow = DEFAULT_FLOW,
    enabled,
    activate,
    group,
    filter,
    visible = false,
    color = '#3f83a3',
    opacity = 0.55,
    children
}: WaterProps) {
    const { addVolume, updateVolume, removeVolume } = useBuoyancy();

    // A ref would be the usual choice here, but the id has to be readable from the *second*
    // effect below (which keeps the volume in sync) without becoming a dependency that forces a
    // brand new id every time a prop changes - a plain mutable holder captured once does that.
    const idHolder = useMemo<{ current: number | null }>(() => ({ current: null }), []);

    const options: BuoyancyVolumeOptions = {
        position,
        size,
        surfaceHeight,
        buoyancy,
        linearDrag,
        angularDrag,
        flow,
        enabled,
        activate,
        group,
        filter
    };

    // Register once per mount. `options` is deliberately not a dependency - kept in sync by the
    // effect below instead, so a prop change patches the existing volume rather than
    // removing/re-adding it (there is no wasm cost to patching; `updateVolume` is a plain JS
    // record replace).
    useEffect(() => {
        idHolder.current = addVolume(options);
        return () => {
            if (idHolder.current !== null) removeVolume(idHolder.current);
            idHolder.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addVolume, removeVolume]);

    // Re-sync on every render: `updateVolume` is a cheap Map.set, not a per-substep cost, so
    // there's no need for a value-equality key the way `useConstraint` needs one to avoid
    // rebuilding an actual wasm constraint.
    useEffect(() => {
        if (idHolder.current !== null) updateVolume(idHolder.current, options);
    });

    const planeSize = useMemo<[number, number]>(() => {
        const s = vec3.three(size);
        return [s.x, s.z];
    }, [size]);

    const planeLocalY = useMemo(() => {
        const p = vec3.three(position);
        const s = vec3.three(size);
        const resolvedSurface = surfaceHeight ?? p.y + s.y / 2;
        return resolvedSurface - p.y;
    }, [position, size, surfaceHeight]);

    return (
        <group position={position}>
            {visible && (
                <mesh position={[0, planeLocalY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                    <planeGeometry args={planeSize} />
                    <meshStandardMaterial
                        color={color}
                        transparent
                        opacity={opacity}
                        depthWrite={false}
                    />
                </mesh>
            )}
            {children}
        </group>
    );
}
