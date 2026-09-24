// createClothGeometry / resolveClothFixed (issue #244), against the real jolt-physics wasm
// module for the parts that touch a soft body. The pure-geometry pieces (dimensions, pin
// selection) don't need Jolt at all and are asserted directly.
import * as THREE from 'three';
import { assert, beforeAll, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { createClothGeometry, resolveClothFixed } from '../src/systems/cloth';
import { PhysicsSystem } from '../src/systems/physics-system';
import { prepareSoftBodyGeometry } from '../src/systems/soft-body-system';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('cloth');
    // Warm up the soft body solver's one-time scratch allocation (~99KB, see soft-body.test.ts)
    // so it doesn't show up as a "leak" in this file's own heap assertions.
    const warmup = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1));
    const handle = ps.softBodySystem.addBody(warmup, {});
    ps.onUpdate(1 / 60);
    ps.softBodySystem.removeBody(handle);
});

// * createClothGeometry ----------------------------------------------------

test('createClothGeometry returns a plane of the requested size and resolution', () => {
    const geometry = createClothGeometry(4, 2, 5, 3);
    expect(geometry).toBeInstanceOf(THREE.PlaneGeometry);

    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    // (segmentsX + 1) * (segmentsY + 1) vertices, three.js's own PlaneGeometry contract
    expect(posAttr.count).toBe(6 * 4);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < posAttr.count; i++) {
        minX = Math.min(minX, posAttr.getX(i));
        maxX = Math.max(maxX, posAttr.getX(i));
        minY = Math.min(minY, posAttr.getY(i));
        maxY = Math.max(maxY, posAttr.getY(i));
        // facing +Z, lying flat in its own local XY plane - createClothGeometry does no rotation
        expect(posAttr.getZ(i)).toBe(0);
    }
    assert.approximately(minX, -2, 1e-6);
    assert.approximately(maxX, 2, 1e-6);
    assert.approximately(minY, -1, 1e-6);
    assert.approximately(maxY, 1, 1e-6);
});

// * resolveClothFixed --------------------------------------------------------

test("resolveClothFixed('top') pins exactly the vertices on the plane's top edge", () => {
    const width = 4;
    const height = 4;
    const geometry = createClothGeometry(width, height, 6, 6);
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const fixed = resolveClothFixed('top', width, height);
    assert.isFunction(fixed);

    const pinnedCount = countPinned(posAttr, fixed as (p: THREE.Vector3, i: number) => boolean);
    // a 6-segment plane has a 7-vertex top row
    expect(pinnedCount).toBe(7);
});

test("resolveClothFixed('corners') pins exactly the four corners", () => {
    const width = 4;
    const height = 6;
    const geometry = createClothGeometry(width, height, 5, 7);
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const fixed = resolveClothFixed('corners', width, height);

    const pinnedCount = countPinned(posAttr, fixed as (p: THREE.Vector3, i: number) => boolean);
    expect(pinnedCount).toBe(4);
});

test('resolveClothFixed passes an explicit number[] straight through', () => {
    const fixed = resolveClothFixed([0, 3, 7], 4, 4);
    expect(fixed).toEqual([0, 3, 7]);
});

function countPinned(
    posAttr: THREE.BufferAttribute,
    predicate: (position: THREE.Vector3, index: number) => boolean
): number {
    const v = new THREE.Vector3();
    let count = 0;
    for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i);
        if (predicate(v, i)) count++;
    }
    return count;
}

// * Integration: a real top-pinned cloth soft body ---------------------------

// `resolveClothFixed`'s 'top'/'corners' predicates read the geometry's own raw, UNROTATED vertex
// data (`createClothGeometry` never rotates anything) - `<Cloth rotation>` lays a sheet flat by
// rotating the mesh/body's *pose* (an object3D transform), never the geometry itself, precisely
// so `fixed` keeps meaning what it says regardless of how the cloth is oriented in the world. This
// test does the same thing `addBody` does through `<SoftBody rotation>`/`mesh.quaternion` directly,
// to drape a "pinned along one edge" sheet flat (world gravity, -Y, ends up perpendicular to the
// rest plane) instead of hanging it vertically (gravity in-plane, an inextensible sheet has
// nothing to sag *into* - see the wind test below for why that orientation needs a sideways force
// instead). Local vertex positions read back every frame (`mesh.geometry`'s position attribute)
// are local to the body's own, possibly-recentred origin (`updatePosition`, the default -
// docs/api/soft-bodies.mdx#vertex-space); converting them to world with the live `mesh.position`/
// `mesh.quaternion` (kept in sync every step, exactly like `soft-body.test.ts`'s own pinned-edge
// test does) is what makes them comparable to a fixed expected position at all.
test('a createClothGeometry sheet, pinned along one edge and laid flat, sags under gravity', () => {
    const width = 4;
    const height = 4;
    const geometry = createClothGeometry(width, height, 6, 6);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(0, 5, 0);

    const restGeometry = prepareSoftBodyGeometry(createClothGeometry(width, height, 6, 6));
    const restPos = restGeometry.attributes.position as THREE.BufferAttribute;
    const fixed = resolveClothFixed('top', width, height);
    // lay flat: local Y (the plane's "up") rotates onto world Z, so gravity (-Y) now pulls
    // perpendicular to the rest plane instead of along it
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const startPosition = new THREE.Vector3(0, 5, 0);

    const handle = ps.softBodySystem.addBody(mesh, {
        rotation,
        compliance: 0,
        numIterations: 5,
        fixed
    });

    for (let i = 0; i < 90; i++) ps.onUpdate(1 / 60);

    const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
    let pinnedMaxDrift = 0;
    let freeMaxDrop = 0;
    const restV = new THREE.Vector3();
    const expectedWorldRest = new THREE.Vector3();
    const liveLocal = new THREE.Vector3();
    const liveWorld = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
        restV.fromBufferAttribute(restPos, i);
        expectedWorldRest.copy(restV).applyQuaternion(rotation).add(startPosition);
        liveLocal.fromBufferAttribute(posAttr, i);
        liveWorld.copy(liveLocal).applyQuaternion(mesh.quaternion).add(mesh.position);
        if ((fixed as (p: THREE.Vector3, i: number) => boolean)(restV, i)) {
            pinnedMaxDrift = Math.max(pinnedMaxDrift, expectedWorldRest.distanceTo(liveWorld));
        } else {
            freeMaxDrop = Math.max(freeMaxDrop, expectedWorldRest.distanceTo(liveWorld));
        }
    }

    assert.isBelow(pinnedMaxDrift, 0.1, 'a pinned vertex moved noticeably in world space');
    assert.isAbove(freeMaxDrop, 0.3, 'nothing far from the pinned edge sagged under gravity');

    ps.softBodySystem.removeBody(handle);
});

// * Wind, the mechanism <examples/Cloth.tsx> uses -----------------------------

test('body.AddForce, applied every substep, swings a top-pinned cloth out of its own plane', () => {
    const jolt = Raw.module;
    const width = 4;
    const height = 4;

    function run(withWind: boolean): number {
        const geometry = createClothGeometry(width, height, 6, 6);
        const mesh = new THREE.Mesh(geometry);
        mesh.position.set(0, 5, 0);

        const handle = ps.softBodySystem.addBody(mesh, {
            compliance: 0,
            numIterations: 5,
            fixed: resolveClothFixed('top', width, height)
        });
        const state = ps.softBodySystem.getBody(handle)!;
        // out-of-plane (Z): the free direction for a sheet rigidly pinned along a line in X - see
        // docs/api/soft-bodies.mdx's wind note.
        const wind = new jolt.Vec3(0, 0, 200);

        for (let i = 0; i < 60; i++) {
            if (withWind) state.body.AddForce(wind);
            ps.onUpdate(1 / 60);
        }
        jolt.destroy(wind);

        const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
        // bottom-center vertex: row 6 (of 0..6), column 3 (of 0..6) in a 7x7 grid, row-major
        // from three.js's own PlaneGeometry vertex order
        const bottomCenterIndex = 6 * 7 + 3;
        const z = posAttr.getZ(bottomCenterIndex);
        ps.softBodySystem.removeBody(handle);
        return z;
    }

    const stillZ = run(false);
    const windZ = run(true);

    assert.approximately(stillZ, 0, 1e-3, 'the un-windy control cloth drifted out of plane');
    assert.isAbove(
        Math.abs(windZ - stillZ),
        0.3,
        'AddForce, applied every substep, did not visibly swing the cloth'
    );
});
