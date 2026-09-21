// Named collider components - issue #155.
//
// These are thin, typed wrappers over `<Shape>`: each one turns an `args` tuple into the
// `ShapeOptions` that `<Shape>` already understands and passes everything else straight through.
// There is no second code path - a `<CuboidCollider>` produces exactly the `ShapeDescriptor` the
// equivalent `<Shape>` would, and is registered with its parent (a `<RigidBody>` or an enclosing
// `<Shape>`) the same way.
//
// ## The `args` convention
//
// `args` follows @react-three/rapier so the most-copied snippet in the r3f physics world works
// here unchanged, which means **half extents**: `<CuboidCollider args={[hx, hy, hz]}>` is a box
// `2hx x 2hy x 2hz`, and the capsule/cylinder/cone take a *half* height. `<Shape>`'s own props
// are unchanged and stay in three.js semantics (`size` is the full extent, `height` is the full
// height / the cylindrical section) - the conversion lives here and nowhere else.
//
// ## What a collider can and cannot carry
//
// `position`/`rotation` place it inside the body (its offset within the compound). `userData`,
// `name` and the per-sub-shape event props are issue #13's and behave exactly as on `<Shape>`.
// `sensor`, `friction` and `restitution` are **body level** in Jolt and are documented as such on
// `ShapeProps`; mass and density belong on `<RigidBody>`.
import React, { forwardRef, memo } from 'react';

import type { NumberArray, ShapeOptions, Vec3Tuple } from '../../systems';
import { Shape, type ShapeHandle, type ShapeProps } from './Shape';

/** Everything a collider passes straight through to `<Shape>`. */
export type ColliderProps = Omit<
    ShapeProps,
    | 'type'
    | 'children'
    | 'size'
    | 'radius'
    | 'height'
    | 'topRadius'
    | 'bottomRadius'
    | 'points'
    | 'vertices'
    | 'verts'
    | 'indices'
    | 'indexes'
    | 'geometry'
    | 'object'
    | 'mesh'
    | 'heights'
    | 'sampleCount'
    | 'heightScale'
    | 'dynamic'
>;

/**
 * Build a collider component: `args` -> `<Shape>` options. One factory so every collider agrees
 * on prop forwarding, ref forwarding, memoisation and the `isJoltShape` marker `<RigidBody>`
 * looks for when it decides whether to wait for child shapes.
 */
const makeCollider = <Args extends readonly unknown[]>(
    displayName: string,
    type: NonNullable<ShapeProps['type']>,
    toOptions: (args: Args) => Omit<ShapeOptions, 'children'>,
    defaultArgs: Args
) => {
    const Collider = memo(
        forwardRef<ShapeHandle, ColliderProps & { args?: Args }>(
            ({ args, ...props }, forwardedRef) => (
                <Shape
                    ref={forwardedRef}
                    type={type}
                    {...toOptions(args ?? defaultArgs)}
                    {...props}
                />
            )
        )
    ) as React.MemoExoticComponent<
        React.ForwardRefExoticComponent<
            ColliderProps & { args?: Args } & React.RefAttributes<ShapeHandle>
        >
    > & { isJoltShape?: boolean };
    Collider.displayName = displayName;
    // `<RigidBody>` scans its children for shapes; the marker beats a displayName string match.
    Collider.isJoltShape = true;
    return Collider;
};

//* Convex primitives =========================================================

/** `[halfWidth, halfHeight, halfDepth]` - rapier's cuboid convention. */
export type CuboidArgs = [number, number, number];
/**
 * A box. `args` are **half extents**, so `args={[0.5, 0.5, 0.5]}` is a 1x1x1 cube.
 *
 * ```tsx
 * <RigidBody colliders={false}>
 *     <CuboidCollider args={[0.5, 0.5, 0.5]} position={[0, 1, 0]} />
 * </RigidBody>
 * ```
 */
export const CuboidCollider = makeCollider<CuboidArgs>(
    'CuboidCollider',
    'box',
    ([hx, hy, hz]) => ({ size: [hx * 2, hy * 2, hz * 2] as Vec3Tuple }),
    [0.5, 0.5, 0.5]
);

/** `[radius]`. */
export type BallArgs = [number];
/** A sphere of `args={[radius]}`. */
export const BallCollider = makeCollider<BallArgs>(
    'BallCollider',
    'sphere',
    ([radius]) => ({ radius }),
    [0.5]
);

/** `[halfHeight, radius]`, where `halfHeight` is half the **cylindrical section**. */
export type CapsuleArgs = [number, number];
/**
 * A capsule. `args={[halfHeight, radius]}`: the total height of the shape is
 * `halfHeight * 2 + radius * 2`, matching rapier and three.js' `CapsuleGeometry`.
 */
export const CapsuleCollider = makeCollider<CapsuleArgs>(
    'CapsuleCollider',
    'capsule',
    ([halfHeight, radius]) => ({ height: halfHeight * 2, radius }),
    [0.5, 0.5]
);

/** `[halfHeight, radius]`. */
export type CylinderArgs = [number, number];
/** A cylinder. `args={[halfHeight, radius]}`, so the full height is `halfHeight * 2`. */
export const CylinderCollider = makeCollider<CylinderArgs>(
    'CylinderCollider',
    'cylinder',
    ([halfHeight, radius]) => ({ height: halfHeight * 2, radius }),
    [0.5, 0.5]
);

/** `[halfHeight, radius]`, `radius` being the radius at the **base**. */
export type ConeArgs = [number, number];
/**
 * A cone, pointing +Y. Jolt has no cone shape, so this is a `taperedCylinder` whose top radius
 * is `0` - geometrically identical, and it keeps the (zero) convex radius Jolt needs for a
 * degenerate end cap.
 */
export const ConeCollider = makeCollider<ConeArgs>(
    'ConeCollider',
    'taperedCylinder',
    ([halfHeight, radius]) => ({
        height: halfHeight * 2,
        topRadius: 0,
        bottomRadius: radius,
        convexRadius: 0
    }),
    [0.5, 0.5]
);

//* Mesh backed shapes ========================================================

/** `[points]` - a flat `[x, y, z, x, y, z, ...]` array or `Float32Array`. */
export type ConvexHullArgs = [Float32Array | number[]];
/**
 * The convex hull of a point cloud. `args={[points]}` takes a flat `[x, y, z, ...]` array; hand
 * it `geometry.attributes.position.array` straight from three.js.
 */
export const ConvexHullCollider = makeCollider<ConvexHullArgs>(
    'ConvexHullCollider',
    'convex',
    ([points]) => ({ points }),
    [[]]
);

/** `[vertices, indices]`, both flat. */
export type TrimeshArgs = [Float32Array | number[], Uint32Array | Uint16Array | number[]];
/**
 * A triangle mesh. `args={[vertices, indices]}`, both flat arrays.
 *
 * Jolt cannot simulate a **dynamic** body with a mesh shape (there is no mesh-vs-mesh collision
 * and the body falls through the world), so a trimesh on a dynamic body is converted to a convex
 * hull with a warning - issue #112. Put it on a `type="static"` body.
 */
export const TrimeshCollider = makeCollider<TrimeshArgs>(
    'TrimeshCollider',
    'trimesh',
    ([vertices, indices]) => ({ vertices, indices }),
    [[], []]
);

/** `[heights, sampleCount, scale]`. */
export type HeightfieldArgs = [NumberArray, number, Vec3Tuple];
/**
 * A heightfield. `args={[samples, size, scale]}`:
 * - `samples` - `size * size` heights, row major
 * - `size` - samples per edge; Jolt needs `blockSize * 2^n` (blockSize defaults to 2)
 * - `scale` - distance between samples on x/z, height multiplier on y
 *
 * Heightfields are static geometry: put this on a `type="static"` body. For a heightfield built
 * from a three.js plane, use [`<Heightfield>`](../Heightfield) or `<Shape type="heightfield">`.
 */
export const HeightfieldCollider = makeCollider<HeightfieldArgs>(
    'HeightfieldCollider',
    'heightfield',
    ([heights, sampleCount, scale]) => ({ heights, sampleCount, heightScale: scale }),
    [[], 2, [1, 1, 1]]
);
