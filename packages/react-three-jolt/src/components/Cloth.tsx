// <Cloth> (issue #244): a convenience wrapper around <SoftBody> for the common case - a flat
// THREE.PlaneGeometry, pinned along an edge or at its corners, so a demo doesn't have to hand
// build the geometry and a pin predicate every time.
import React, { type ReactNode, useMemo } from 'react';
import { DoubleSide, type Euler, type Vector3 } from 'three';
import { type ClothPinned, createClothGeometry, resolveClothFixed } from '../systems/cloth';
import { SoftBody, type SoftBodyProps } from './SoftBody';

export interface ClothProps extends Omit<SoftBodyProps, 'children' | 'fixed'> {
    /** World size of the plane. Default `4`. */
    width?: number;
    height?: number;
    /** Grid resolution - more segments drape more convincingly, at a steeper per-frame cost
     * (every soft body vertex is read back into the geometry every rendered frame - see
     * `docs/api/soft-bodies.mdx#performance`). Default `10`. */
    segmentsX?: number;
    segmentsY?: number;
    /** See {@link ClothPinned}. Default `'top'`. */
    pinned?: ClothPinned;
    /** Starting world position/rotation of the cloth's `<mesh>` - `<SoftBody>` itself has no
     * `position`/`rotation` prop, these are the mesh's own. */
    position?: Vector3 | [number, number, number];
    rotation?: Euler | [number, number, number];
    /** Material(s) for the generated `<mesh>`. Defaults to a double-sided
     * `<meshStandardMaterial>` - cloth is thin enough that its back face is routinely visible. */
    children?: ReactNode;
    castShadow?: boolean;
    receiveShadow?: boolean;
}

export const Cloth = React.memo(function Cloth({
    width = 4,
    height = 4,
    segmentsX = 10,
    segmentsY = 10,
    pinned = 'top',
    position,
    rotation,
    children,
    castShadow = true,
    receiveShadow = true,
    ref,
    ...softBodyOptions
}: ClothProps) {
    // Both the geometry and the pin predicate depend only on the plane's own dimensions - stable
    // across re-renders as long as those props don't change, so `<SoftBody>`'s creation effect
    // (which reads `fixed` once, at mount) always sees the geometry it actually pinned.
    const geometry = useMemo(
        () => createClothGeometry(width, height, segmentsX, segmentsY),
        [width, height, segmentsX, segmentsY]
    );
    const fixed = useMemo(() => resolveClothFixed(pinned, width, height), [pinned, width, height]);

    return (
        <SoftBody ref={ref} fixed={fixed} {...softBodyOptions}>
            <mesh
                position={position}
                rotation={rotation}
                castShadow={castShadow}
                receiveShadow={receiveShadow}
            >
                <primitive object={geometry} attach="geometry" />
                {children ?? <meshStandardMaterial color="#eeeeee" side={DoubleSide} />}
            </mesh>
        </SoftBody>
    );
});

export { type ClothPinned, createClothGeometry, resolveClothFixed } from '../systems/cloth';
