// QA round (2026-09-26): "the cloth is bending down over the box and clipping". Investigating
// per BRIEF.md's checklist (the #300 rigid-body fix: BodyState.invertedWorldMatrix used to take
// the object's OWN matrixWorld instead of its PARENT's), SoftBodyState.syncGeometry had a related
// but distinct gap: it wrote Jolt's WORLD-space `body.GetPosition()`/`GetRotation()` straight into
// `object.position`/`.quaternion` with NO conversion into the object's parent space at all -
// `BodyState`'s per-frame sync (`PhysicsSystem.syncBodyToObject`) does this conversion via
// `invertedWorldMatrix`; `SoftBodyState.syncGeometry` did not.
//
// It doesn't show up in either shipped soft-body demo today (Cloth.tsx, SoftBodies.tsx) because
// their <Cloth>/<SoftBody> meshes sit directly under the scene root - an identity parent, where
// the missing conversion is a no-op. It becomes visible the moment a soft body is nested under
// ANY non-identity parent (a positioned/rotated <group>, a common layout pattern) - the mesh
// renders in completely the wrong place/orientation, which would present exactly as "bending
// down and clipping" through anything place relative to that group (a box, in this case).
//
// This test builds a soft body (via the library's systems API, no React) as a child of a
// THREE.Object3D parent with a non-identity transform, and checks the RENDERED world position
// (mesh.matrixWorld, after updateWorldMatrix) matches the body's actual simulated world pose.
import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

let ps: PhysicsSystem;
beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-soft-body-parent-space');
});

test('a soft body nested under a transformed parent renders at the correct world pose', () => {
    // A parent with a non-identity transform - a positioned, rotated group, as any layout might
    // use to place a cluster of demo content.
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, -5);
    parent.rotation.set(0, Math.PI / 2, 0);
    parent.updateWorldMatrix(true, false);

    const geometry = new THREE.SphereGeometry(0.5, 8, 6);
    const mesh = new THREE.Mesh(geometry);
    parent.add(mesh);

    // Pin every vertex so the body never moves under gravity - this test is about where the
    // (static) body renders, not about simulating a fall.
    const worldPosition: [number, number, number] = [3, 4, 1];
    const handle = ps.softBodySystem.addBody(mesh, {
        position: worldPosition,
        fixed: () => true
    });

    for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);

    mesh.updateWorldMatrix(true, false);
    const renderedWorldPosition = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);

    expect(renderedWorldPosition.x).toBeCloseTo(worldPosition[0], 3);
    expect(renderedWorldPosition.y).toBeCloseTo(worldPosition[1], 3);
    expect(renderedWorldPosition.z).toBeCloseTo(worldPosition[2], 3);

    ps.softBodySystem.removeBody(handle);
});
