//various Jolt/Three tools for meshes
// I HATE we need to import this raw module

import { Raw } from '../raw';
import { createShapeFromSettings, releaseShape } from '../systems/shape-system';

// `createMeshFromShape` lives in systems/shape-system.ts now - it used to exist here and there
// byte for byte. Re-exported so existing imports from utils/mesh-tools keep working.
export { createMeshFromShape } from '../systems/shape-system';

// create a heightfeild type floor
// from the jolt js example
// NOTE: the returned BodyCreationSettings is the caller's to destroy once the body is created.
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
                ((v1.x = x1), (v1.y = height(x, z)), (v1.z = z1));
                ((v2.x = x1), (v2.y = height(x, z + 1)), (v2.z = z2));
                ((v3.x = x2), (v3.y = height(x + 1, z + 1)), (v3.z = z2));
            }

            {
                const t = triangles.at((x * n + z) * 2 + 1);
                const v1 = t.get_mV(0),
                    v2 = t.get_mV(1),
                    v3 = t.get_mV(2);
                ((v1.x = x1), (v1.y = height(x, z)), (v1.z = z1));
                ((v2.x = x2), (v2.y = height(x + 1, z + 1)), (v2.z = z2));
                ((v3.x = x2), (v3.y = height(x + 1, z)), (v3.z = z1));
            }
        }
    const materials = new jolt.PhysicsMaterialList();
    // createShapeFromSettings destroys the settings and hands back a shape we own a ref on
    const shape = createShapeFromSettings(new jolt.MeshShapeSettings(triangles, materials));
    jolt.destroy(triangles);
    jolt.destroy(materials);

    // Create body
    const position = new jolt.RVec3(posX, posY, posZ);
    const rotation = new jolt.Quat(0, 0, 0, 1);
    const creationSettings = new jolt.BodyCreationSettings(
        shape,
        position,
        rotation,
        jolt.EMotionType_Static,
        0
    );
    // the settings copied the transform and took their own reference on the shape
    jolt.destroy(position);
    jolt.destroy(rotation);
    releaseShape(shape);

    return creationSettings;
}
