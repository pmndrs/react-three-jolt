// SoftBodySystem / <SoftBody> (issue #243), against the real jolt-physics wasm module.
//
// Two behavioral cases from the issue: a pinned cloth-like quad sags under gravity, and a closed,
// pressurized mesh resists collapsing (keeps its volume above a threshold) - here, landing on a
// floor. Plus lifecycle: the shared settings/creation settings/body are all freed, double destroy
// is a no-op, and the WASM heap comes back after add/remove.
import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import {
    buildSoftBodySharedSettings,
    prepareSoftBodyGeometry,
    SoftBodyState
} from '../src/systems/soft-body-system';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('soft-body');
    // One-time cost (verified empirically): the first ever soft body step in a JoltInterface's
    // lifetime lazily allocates ~97-99KB of scratch space for the soft body solver, which then
    // stays allocated - it is not a per-body resource and is not freed until the JoltInterface
    // itself is. Warm that up here so the leak test below measures steady-state, not that
    // one-time cost.
    const warmup = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1));
    const handle = ps.softBodySystem.addBody(warmup, {});
    ps.onUpdate(1 / 60);
    ps.softBodySystem.removeBody(handle);
});

/** Signed volume of a closed triangle mesh from its world-space vertex positions (divergence
 * theorem: V = (1/6) * sum over triangles of v0 . (v1 x v2)). */
function meshVolume(geometry: THREE.BufferGeometry): number {
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const index = geometry.index!;
    let volume = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
        a.fromBufferAttribute(pos, index.getX(i));
        b.fromBufferAttribute(pos, index.getX(i + 1));
        c.fromBufferAttribute(pos, index.getX(i + 2));
        volume += a.dot(b.clone().cross(c));
    }
    return Math.abs(volume) / 6;
}

test('a closed, pressurized sphere lands on a floor and keeps its volume above a threshold', () => {
    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floorMesh.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floorMesh, { bodyType: 'static' });

    const geometry = new THREE.SphereGeometry(1, 12, 8);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(0, 3, 0);
    const restVolume = meshVolume(prepareSoftBodyGeometry(geometry));

    const handle = ps.softBodySystem.addBody(mesh, {
        pressure: 2500,
        numIterations: 6,
        friction: 0.5
    });

    for (let i = 0; i < 180; i++) ps.onUpdate(1 / 60);

    // it fell and landed, rather than floating or falling through the floor
    assert.isBelow(mesh.position.y, 3, 'the sphere never fell');
    assert.isAbove(mesh.position.y, -1, 'the sphere fell through the floor');

    const restingVolume = meshVolume(mesh.geometry);
    // pressure resists the floor's compression - a real (uncompensated) volume loss from resting
    // on a flat floor would be a small fraction of the sphere; well over half survives.
    assert.isAbove(
        restingVolume,
        restVolume * 0.5,
        `pressure did not hold: rest volume ${restVolume.toFixed(3)}, resting volume ${restingVolume.toFixed(3)}`
    );

    ps.softBodySystem.removeBody(handle);
    ps.bodySystem.removeAllBodies();
});

test('a cloth pinned along one edge sags under gravity while the pinned edge stays put', () => {
    const geometry = new THREE.PlaneGeometry(4, 4, 6, 6);
    geometry.rotateX(-Math.PI / 2); // lay it flat
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(0, 5, 0);

    // Record which (post-merge) vertex indices are pinned from the REST geometry - addBody
    // overwrites mesh.geometry's position attribute with live simulated positions every step,
    // so this has to be captured before that happens, not re-derived from it afterward.
    const restGeometry = prepareSoftBodyGeometry(geometry);
    const restPos = restGeometry.attributes.position as THREE.BufferAttribute;
    const isPinnedRest = (i: number) => Math.abs(restPos.getZ(i) - 2) < 1e-4;

    // pin one whole edge (z === 2 in local/rest space) rather than all four corners: an
    // inextensible net pinned at all four corners has no slack to sag at all (verified while
    // building this system) - pinning one edge leaves the rest free to hang.
    const handle = ps.softBodySystem.addBody(mesh, {
        compliance: 0,
        numIterations: 5,
        fixed: (position) => Math.abs(position.z - 2) < 1e-4
    });

    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);

    const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    let pinnedMinY = Infinity;
    let freeMaxDrop = 0;
    for (let i = 0; i < posAttr.count; i++) {
        const local = new THREE.Vector3().fromBufferAttribute(posAttr, i);
        const world = local.clone().applyQuaternion(mesh.quaternion).add(mesh.position);
        if (isPinnedRest(i)) pinnedMinY = Math.min(pinnedMinY, world.y);
        else freeMaxDrop = Math.max(freeMaxDrop, 5 - world.y);
    }

    assert.approximately(pinnedMinY, 5, 0.2, 'a pinned vertex moved noticeably in world space');
    assert.isAbove(freeMaxDrop, 0.5, 'nothing far from the pinned edge sagged under gravity');

    ps.softBodySystem.removeBody(handle);
});

test('the mesh geometry is indexed/merged and driven by the simulation every step', () => {
    const geometry = new THREE.SphereGeometry(1, 8, 6);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(0, 10, 0);
    const handle = ps.softBodySystem.addBody(mesh, { pressure: 500 });

    // addBody replaces mesh.geometry with a merged/indexed one
    expect(mesh.geometry.index).not.toBeNull();
    expect(mesh.geometry.boundingSphere).not.toBeNull();
    const vertexCountAfterMerge = mesh.geometry.attributes.position.count;

    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);

    expect(mesh.geometry.attributes.position.count).toBe(vertexCountAfterMerge);
    // the object3D tracks the body's pose (like a <RigidBody>), so it moved under gravity
    expect(mesh.position.y).toBeLessThan(10);

    ps.softBodySystem.removeBody(handle);
});

test('buildSoftBodySharedSettings throws on a non-indexed geometry', () => {
    const geometry = new THREE.SphereGeometry(1, 4, 4).toNonIndexed();
    expect(() => buildSoftBodySharedSettings(geometry)).toThrow(/indexed/);
});

test('destroy() is idempotent; a second call is a no-op, not a double free', () => {
    const alloc = installAllocTracker(Raw);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4));
    const handle = ps.softBodySystem.addBody(mesh, {});
    const state = ps.softBodySystem.getBody(handle) as SoftBodyState;

    state.destroy();
    expect(state.disposed).toBe(true);
    expect(() => state.destroy()).not.toThrow();

    // removeBody on an already-destroyed handle must also be a no-op
    ps.softBodySystem.removeBody(handle);
    expect(ps.softBodySystem.getBody(handle)).toBeUndefined();

    expect(alloc.destroyed()).toBeGreaterThan(0);
    alloc.uninstall();
    // the handle was never re-added to the map by destroy() itself
    ps.softBodySystem.bodies.delete(handle);
});

test('add and remove does not leak the WASM heap, across several rounds', () => {
    const jolt = Raw.module;
    const before = jolt.JoltInterface.prototype.sGetFreeMemory();
    for (let round = 0; round < 8; round++) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6));
        mesh.position.set(0, 10, 0);
        const handle = ps.softBodySystem.addBody(mesh, { pressure: 1000 });
        for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);
        ps.softBodySystem.removeBody(handle);
    }
    const after = jolt.JoltInterface.prototype.sGetFreeMemory();
    assert.isAtLeast(
        after,
        before - 256,
        `leaked ${before - after} bytes of WASM heap across 8 add/remove rounds`
    );
});
