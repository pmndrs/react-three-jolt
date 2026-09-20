//various Jolt/Three tools for meshes
// I HATE we need to import this raw module

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';

// create a heightfeild type floor
// from the jolt js example
export function createMeshFloor(
    n: number,
    cellSize: number,
    _maxHeight: number,
    posX: number,
    posY: number,
    posZ: number
) {
    const jolt = Raw.module;
    // Create regular grid of triangles
    const height = (x: number, y: number) => Math.sin(x / 2) * Math.cos(y / 3);
    const triangles = new jolt.TriangleList();
    triangles.resize(n * n * 2);
    for (let x = 0; x < n; ++x)
        for (let z = 0; z < n; ++z) {
            const center = (n * cellSize) / 2;

            const x1 = cellSize * x - center;
            const z1 = cellSize * z - center;
            const x2 = x1 + cellSize;
            const z2 = z1 + cellSize;

            {
                const t = triangles.at((x * n + z) * 2);
                const v1 = t.get_mV(0),
                    v2 = t.get_mV(1),
                    v3 = t.get_mV(2);
                (v1.x = x1), (v1.y = height(x, z)), (v1.z = z1);
                (v2.x = x1), (v2.y = height(x, z + 1)), (v2.z = z2);
                (v3.x = x2), (v3.y = height(x + 1, z + 1)), (v3.z = z2);
            }

            {
                const t = triangles.at((x * n + z) * 2 + 1);
                const v1 = t.get_mV(0),
                    v2 = t.get_mV(1),
                    v3 = t.get_mV(2);
                (v1.x = x1), (v1.y = height(x, z)), (v1.z = z1);
                (v2.x = x2), (v2.y = height(x + 1, z + 1)), (v2.z = z2);
                (v3.x = x2), (v3.y = height(x + 1, z)), (v3.z = z1);
            }
        }
    const materials = new jolt.PhysicsMaterialList();
    const shape = new jolt.MeshShapeSettings(triangles, materials).Create().Get();
    jolt.destroy(triangles);
    jolt.destroy(materials);

    // Create body
    const creationSettings = new jolt.BodyCreationSettings(
        shape,
        new jolt.RVec3(posX, posY, posZ),
        new jolt.Quat(0, 0, 0, 1),
        jolt.EMotionType_Static,
        0
    );
    return creationSettings;
}

// Direct from the Jolt JS Example
// Create a geometry from the RAW verts of a shape
// The Jolt example has a smoother version that uses shapes, this is more raw which
// is overkill for simpler/common shapes
export function createMeshFromShape(shape: Jolt.Shape): THREE.BufferGeometry {
    const jolt = Raw.module;
    // Get triangle data
    const scale = new jolt.Vec3(1, 1, 1);
    const triContext = new jolt.ShapeGetTriangles(
        shape,
        jolt.AABox.prototype.sBiggest(),
        shape.GetCenterOfMass(),
        jolt.Quat.prototype.sIdentity(),
        scale
    );
    jolt.destroy(scale);

    // Get a view on the triangle data (does not make a copy)
    const vertices = new Float32Array(
        jolt.HEAPF32.buffer,
        triContext.GetVerticesData(),
        triContext.GetVerticesSize() / Float32Array.BYTES_PER_ELEMENT
    );

    // Now move the triangle data to a buffer and clone it so that we can free the memory from the C++ heap (which could be limited in size)
    const buffer = new THREE.BufferAttribute(vertices, 3).clone();
    jolt.destroy(triContext);

    // Create a three mesh
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', buffer);
    geometry.computeVertexNormals();

    return geometry;
}
