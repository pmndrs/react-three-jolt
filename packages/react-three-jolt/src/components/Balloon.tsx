// <Balloon> (issue #244): a convenience wrapper around <SoftBody pressure> for the other common
// soft-body shape - a closed, pressurized sphere that resists collapsing, the counterpart to
// <Cloth> for an open, unpressurized plane.
import React, { type ReactNode } from 'react';
import type { Vector3 } from 'three';
import { SoftBody, type SoftBodyProps } from './SoftBody';

export interface BalloonProps extends Omit<SoftBodyProps, 'children' | 'pressure'> {
    /** Sphere radius. Default `1`. */
    radius?: number;
    /** `THREE.SphereGeometry`'s `widthSegments`/`heightSegments` - kept modest by default (see
     * `docs/api/soft-bodies.mdx#performance`: every vertex is read back every rendered frame). */
    widthSegments?: number;
    heightSegments?: number;
    /** Inflation pressure - a closed mesh with a positive pressure resists collapsing. Default
     * `2500`, comfortably above the weight of a body its own size landing on it (see
     * `test/soft-body.test.ts`'s pressurized-sphere test, which uses the same figure). */
    pressure?: number;
    position?: Vector3 | [number, number, number];
    /** Material(s) for the generated `<mesh>`. Defaults to a `<meshStandardMaterial>`. */
    children?: ReactNode;
    castShadow?: boolean;
    receiveShadow?: boolean;
}

export const Balloon = React.memo(function Balloon({
    radius = 1,
    widthSegments = 16,
    heightSegments = 12,
    pressure = 2500,
    position,
    children,
    castShadow = true,
    receiveShadow = true,
    ref,
    ...softBodyOptions
}: BalloonProps) {
    return (
        <SoftBody ref={ref} pressure={pressure} {...softBodyOptions}>
            <mesh position={position} castShadow={castShadow} receiveShadow={receiveShadow}>
                <sphereGeometry args={[radius, widthSegments, heightSegments]} />
                {children ?? <meshStandardMaterial color="hotpink" />}
            </mesh>
        </SoftBody>
    );
});
