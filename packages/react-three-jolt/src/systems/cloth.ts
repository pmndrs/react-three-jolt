// Cloth helpers (issue #244): a plain geometry factory plus the pin-selection logic `<Cloth>`
// builds on top of `<SoftBody fixed>`. No Jolt calls here - this is pure three.js/JS, kept out of
// soft-body-system.ts because it never touches `Raw.module`.
import * as THREE from 'three';
import type { SoftBodyFixed, SoftBodyPinPredicate } from './soft-body-system';

/**
 * Which vertices `<Cloth pinned>` anchors:
 * - `'top'` - the whole top edge (`y === height / 2` in the plane's local rest space) - a flag on
 *   a pole, a curtain.
 * - `'corners'` - the four corners only. A `compliance: 0` (fully rigid) cloth pinned at all four
 *   corners has no slack to sag at all - raise `compliance` above `0`, or use `'top'`/a custom
 *   `number[]`, to get visible drape (see `docs/api/soft-bodies.mdx`).
 * - `number[]` - explicit vertex indices into the geometry `createClothGeometry` returns (which
 *   is not run through `mergeVertices` itself - `THREE.PlaneGeometry` has no duplicate
 *   positions to begin with, so its authored vertex order is already the merged one).
 */
export type ClothPinned = 'top' | 'corners' | number[];

/**
 * A plain `THREE.PlaneGeometry(width, height, segmentsX, segmentsY)` - the plane's local XY
 * layout (vertices in `[-width/2, width/2]` x `[-height/2, height/2]`, `z = 0`) is exactly what
 * {@link resolveClothFixed}'s `'top'`/`'corners'` predicates assume. Facing +Z with no rotation,
 * it's already the right orientation to hang as a flag/curtain (gravity pulls along -Y in its own
 * local space when the mesh itself isn't rotated); rotate the `<mesh>` (e.g. `-Math.PI / 2` around
 * X) to lay it flat over something instead.
 */
export function createClothGeometry(
    width: number,
    height: number,
    segmentsX: number,
    segmentsY: number
): THREE.PlaneGeometry {
    return new THREE.PlaneGeometry(width, height, segmentsX, segmentsY);
}

/**
 * Turns `<Cloth pinned>` into the `SoftBodyFixed` `<SoftBody fixed>` expects: pass a `number[]`
 * straight through, or build a predicate over the plane's local rest position for `'top'`/
 * `'corners'`. `width`/`height` must be the same values passed to {@link createClothGeometry} -
 * the predicate compares against their half-extents.
 */
export function resolveClothFixed(
    pinned: ClothPinned,
    width: number,
    height: number
): SoftBodyFixed {
    if (Array.isArray(pinned)) return pinned;

    const halfWidth = width / 2;
    const halfHeight = height / 2;
    // Absolute float tolerance scaled to the plane's own size, not a fixed epsilon - a tiny cloth
    // (or a huge one) still compares its edges correctly.
    const epsilon = Math.max(width, height, 1) * 1e-4;

    const top: SoftBodyPinPredicate = (position) => Math.abs(position.y - halfHeight) < epsilon;
    const corners: SoftBodyPinPredicate = (position) =>
        Math.abs(Math.abs(position.x) - halfWidth) < epsilon &&
        Math.abs(Math.abs(position.y) - halfHeight) < epsilon;

    return pinned === 'top' ? top : corners;
}
