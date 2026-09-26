// QA round (2026-09-26): "the ball is split open on the side" - a SphereGeometry soft body's
// UV seam (and poles) never welds shut. Root cause: prepareSoftBodyGeometry ran three's
// mergeVertices() straight on the source geometry, which only merges vertices whose EVERY
// attribute matches. SphereGeometry duplicates a column of vertices at the UV seam (u=0 and
// u=1 at the same position, different uv), so those never merge into one Jolt vertex - the
// physics mesh has an actual gap there, and pressure/tension pulls it open.
//
// This test builds the Jolt vertex/face data straight from prepareSoftBodyGeometry (no React,
// no rendering) and checks it is a closed manifold: the physics vertex count matches the number
// of geometrically-unique positions, and every edge is shared by exactly two faces (no boundary
// edges - a split-open seam shows up as edges that only belong to one triangle).
import * as THREE from 'three';
import { expect, test } from 'vitest';
import { prepareSoftBodyGeometry } from '../src/systems/soft-body-system';

function countUniquePositions(geometry: THREE.BufferGeometry, tolerance = 1e-4): number {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const seen = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
        const key = [pos.getX(i), pos.getY(i), pos.getZ(i)]
            .map((v) => Math.round(v / tolerance))
            .join(',');
        seen.add(key);
    }
    return seen.size;
}

/** Every undirected edge of every triangle, keyed low-high; the value is how many triangles use
 * it. A closed manifold has every edge used by exactly 2 triangles - a seam left unwelded shows
 * up as edges used by only 1. */
function edgeUseCounts(geometry: THREE.BufferGeometry): Map<string, number> {
    const index = geometry.index!;
    const counts = new Map<string, number>();
    const bump = (a: number, b: number) => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    };
    for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        bump(a, b);
        bump(b, c);
        bump(c, a);
    }
    return counts;
}

test('a SphereGeometry soft body welds shut: vertex count matches unique positions, no boundary edges', () => {
    const geometry = new THREE.SphereGeometry(1, 12, 8);
    const prepared = prepareSoftBodyGeometry(geometry);

    const uniquePositions = countUniquePositions(geometry);
    const weldedVertexCount = prepared.attributes.position.count;
    expect(weldedVertexCount).toBe(uniquePositions);

    const counts = edgeUseCounts(prepared);
    const boundaryEdges = [...counts.values()].filter((n) => n !== 2);
    expect(
        boundaryEdges.length,
        `expected every edge shared by exactly 2 faces (closed manifold); found ${boundaryEdges.length} edges that are not - the mesh has an open seam`
    ).toBe(0);
});

test('a PlaneGeometry (already a clean quad grid) stays unaffected: no accidental over-merging', () => {
    const geometry = new THREE.PlaneGeometry(4, 4, 6, 6);
    const prepared = prepareSoftBodyGeometry(geometry);

    // a flat, open plane keeps its border edges (used by exactly 1 face) - position-only welding
    // must not merge distinct grid vertices into each other.
    const expectedVertexCount = (6 + 1) * (6 + 1);
    expect(prepared.attributes.position.count).toBe(expectedVertexCount);

    const counts = edgeUseCounts(prepared);
    const interiorEdges = [...counts.values()].filter((n) => n === 2).length;
    const boundaryEdges = [...counts.values()].filter((n) => n === 1).length;
    // a 6x6 quad grid (split into 2 triangles per quad) has a known border length
    expect(boundaryEdges).toBe(4 * 6);
    expect(interiorEdges).toBeGreaterThan(0);
});
