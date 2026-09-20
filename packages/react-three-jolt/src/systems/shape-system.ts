// this class has two primary functions:
// To manage the shape functions of Jolt
// To generate the shape from ThreeJS objects

// Inital code ffrom Isaac's Jolt Sketch:
//https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/three-to-jolt.ts

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import {
    BoxGeometry,
    BufferGeometry,
    CapsuleGeometry,
    CylinderGeometry,
    type Object3D,
    SphereGeometry,
    Vector3
} from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { Raw } from '../raw';
import { type anyVec3, quat, vec3 } from '../utils';

export class ShapeSystem {
    private physicsSystem: Jolt.PhysicsSystem;
    //@ts-expect-error
    private bodyInterface: Jolt.BodyInterface;
    constructor(physicsSystem: Jolt.PhysicsSystem) {
        this.physicsSystem = physicsSystem;
        this.bodyInterface = this.physicsSystem.GetBodyInterface();
    }
    // I'm not sure which functions to expose to the runtime
    //getShapeSettingsFromObject = (object: Object3D, shapeType?: AutoShape) => getShapeSettingsFromObject(object, shapeType);
    //getShapeSettingsFromGeometry = (geometry: BufferGeometry, shapeType?: AutoShape) => getShapeSettingsFromGeometry(geometry, shapeType);
}

export type AutoShape =
    | 'box'
    | 'sphere'
    | 'capsule'
    | 'taperedCapsule'
    | 'cylinder'
    | 'convex'
    | 'trimesh'
    | 'compound'
    | 'heightfield';

/* ============================================================================
 * Memory notes (jolt-physics 1.1.0 / emscripten WebIDL binder)
 *
 * - Every `new Raw.module.X()` is a real allocation on the WASM heap and is only freed by
 *   `Raw.module.destroy(x)`. Nothing here is garbage collected.
 * - The list containers (`ArrayVec3`, `VertexList`, `IndexedTriangleList`, ...) *copy* the
 *   value handed to `push_back`, so one scratch object can be re-`Set` for every element.
 *   Allocating a fresh `Vec3`/`Float3`/`IndexedTriangle` per element leaked one WASM object
 *   per vertex/triangle (a 2k-triangle sphere leaked ~3k objects).
 * - `ShapeSettings` and the lists handed to their constructors are copied into the shape by
 *   `Create()`, so both can be destroyed as soon as the shape exists.
 * - `ShapeSettings.Create()` does NOT return a fresh object: the binder hands back a pointer
 *   to a `static ShapeResult` temporary that is overwritten by the next `Create()` call
 *   anywhere in the process. It must never be passed to `destroy()` (that would `delete` a
 *   static) and the reference it holds on the shape must not be relied on - see
 *   `createShapeFromSettings` below.
 * - Statics returned by value (`Vec3::sZero()`, `Quat::sIdentity()`, `AABox::sBiggest()`,
 *   `Shape::GetCenterOfMass()`, ...) are the same kind of static temporary: they are not
 *   allocations and must not be destroyed.
 * - Sub-settings added to a compound (`CompoundShapeSettings::AddShape`) are ref-counted by
 *   the compound. Destroying the compound settings frees them, so callers must not destroy
 *   sub-settings themselves.
 * ========================================================================== */

/**
 * Turn `ShapeSettings` into a `Shape`, taking ownership of the settings.
 *
 * `Create()` returns a reference to a static `ShapeResult` whose reference on the new shape is
 * dropped the next time anything calls `Create()`, so we take our own reference here. The
 * returned shape is owned by the caller: pass it to something that takes a reference (a
 * `BodyCreationSettings`, a compound, ...) and then `releaseShape()` it, or `releaseShape()` it
 * when the shape is no longer needed.
 *
 * @param shapeSettings the settings to realise
 * @param destroySettings destroy the settings once the shape exists (default true)
 */
export const createShapeFromSettings = (
    shapeSettings: Jolt.ShapeSettings,
    destroySettings = true
): Jolt.Shape => {
    const jolt = Raw.module;
    // NOTE: not an allocation, and never destroy it - it is a static temporary.
    const result = shapeSettings.Create();
    if (result.HasError()) {
        // copy the message out before Clear() frees it
        const message = result.GetError().c_str();
        result.Clear();
        if (destroySettings) jolt.destroy(shapeSettings);
        throw new Error(`Jolt could not create the shape: ${message}`);
    }
    const shape = result.Get();
    // own a reference before the settings (and the static result) let go of theirs
    shape.AddRef();
    // release the static temporary's reference so it doesn't keep this shape alive by accident
    result.Clear();
    if (destroySettings) jolt.destroy(shapeSettings);
    return shape;
};

/**
 * Drop a reference taken by `createShapeFromSettings`. Jolt shapes are ref-counted: this frees
 * the shape only once nothing else (a body, a compound, ...) is holding it.
 */
export const releaseShape = (shape?: Jolt.Shape | null) => {
    if (shape) shape.Release();
};

export const getShapeSettingsFromObject = (
    object: Object3D,
    // why do I need this here?
    shapeType?: AutoShape
) => {
    const jolt = Raw.module;
    // TODO: Add types here
    const shapes: any = [];

    object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            // adding ignore to meshes skips the shape generator
            if (child.geometry) {
                // TODO: Until we understand the offsets we are going to get both here
                const shapeSettingsAndOffset = getShapeSettingsFromGeometry(
                    child.geometry,
                    shapeType
                );

                if (shapeSettingsAndOffset) {
                    // the three vectors are kept as-is; the jolt Vec3/Quat are only created
                    // once, below, because AddShape copies them anyway.
                    const shape = {
                        shapeSettings: shapeSettingsAndOffset.shapeSettings,
                        offset: shapeSettingsAndOffset.offset,
                        position: child.position,
                        quaternion: child.quaternion
                    };

                    shapes.push(shape);
                }
            }
        }
    });

    // BAIL IF EMPTY
    // if (shapes.length === 0) return undefined;
    //console.log('shapes', shapes);
    // if theres only one, return it
    if (shapes.length === 1) return shapes[0].shapeSettings;
    const compoundShapeSettings = new jolt.StaticCompoundShapeSettings();

    // one scratch position/rotation for the whole loop: AddShape copies both
    const position = new jolt.Vec3(0, 0, 0);
    const quaternion = new jolt.Quat(0, 0, 0, 1);
    // Note: offset also available
    for (const { shapeSettings, position: inPosition, quaternion: inQuaternion } of shapes) {
        position.Set(inPosition.x, inPosition.y, inPosition.z);
        quaternion.Set(inQuaternion.x, inQuaternion.y, inQuaternion.z, inQuaternion.w);
        // the compound takes a reference on the sub-settings; destroying the compound frees them
        compoundShapeSettings.AddShape(position, quaternion, shapeSettings, 0);
    }
    jolt.destroy(position);
    jolt.destroy(quaternion);

    return compoundShapeSettings;
};
// TODO: move this type later
type PossibleGeometry =
    | BufferGeometry
    | BoxGeometry
    | SphereGeometry
    | CapsuleGeometry
    | CylinderGeometry;
// check the instanceOf value against known three geometries
const getShapeTypeFromGeometry = (geometry: PossibleGeometry): AutoShape => {
    //hack the switch statement to check the instanceOf value
    switch (true) {
        case geometry instanceof BoxGeometry:
            return 'box';
        case geometry instanceof SphereGeometry:
            return 'sphere';
        case geometry instanceof CapsuleGeometry:
            return 'capsule';
        case geometry instanceof CylinderGeometry:
            return 'cylinder';
        // if unknown do a convex hull
        case geometry instanceof BufferGeometry:
            return 'convex';
        default:
            // bail out with sphere
            return 'convex';
    }
};

/**
 * Fill a `ConvexHullShapeSettings`' point list from a flat xyz array.
 * One scratch `Vec3` is reused for every point because `push_back` copies the value.
 */
const pushHullPoints = (points: ArrayLike<number>, hull: Jolt.ConvexHullShapeSettings) => {
    const jolt = Raw.module;
    const hullPoints = hull.mPoints;
    hullPoints.reserve(points.length / 3);
    const point = new jolt.Vec3(0, 0, 0);
    for (let i = 0; i < points.length; i += 3) {
        point.Set(points[i], points[i + 1], points[i + 2]);
        hullPoints.push_back(point);
    }
    jolt.destroy(point);
};

/**
 * Build `MeshShapeSettings` from flat vertex/index data.
 * One scratch `Float3` and one scratch `IndexedTriangle` are reused for the whole mesh, and the
 * vertex/triangle/material lists are destroyed as soon as the settings have copied them.
 * The material list is left empty on purpose - Jolt then uses its default physics material, and
 * a `PhysicsMaterial` pushed into the list cannot be freed by hand (the list owns a reference).
 */
const createMeshShapeSettings = (
    getVertex: (index: number, out: Jolt.Float3) => void,
    vertexCount: number,
    getTriangle: (index: number, out: Jolt.IndexedTriangle) => void,
    triangleCount: number
): Jolt.MeshShapeSettings => {
    const jolt = Raw.module;

    const verts = new jolt.VertexList();
    verts.reserve(vertexCount);
    const vertex = new jolt.Float3(0, 0, 0);
    for (let i = 0; i < vertexCount; i++) {
        getVertex(i, vertex);
        // push_back copies, so the same scratch Float3 serves every vertex
        verts.push_back(vertex);
    }
    jolt.destroy(vertex);

    const tris = new jolt.IndexedTriangleList();
    tris.reserve(triangleCount);
    const triangle = new jolt.IndexedTriangle(0, 0, 0, 0);
    for (let i = 0; i < triangleCount; i++) {
        getTriangle(i, triangle);
        tris.push_back(triangle);
    }
    jolt.destroy(triangle);

    const mats = new jolt.PhysicsMaterialList();
    const shapeSettings = new jolt.MeshShapeSettings(verts, tris, mats);
    // the settings copied all three lists
    jolt.destroy(verts);
    jolt.destroy(tris);
    jolt.destroy(mats);

    return shapeSettings;
};

// We use shape settings because it lets us reuse this fn in compound shape generation
export const getShapeSettingsFromGeometry = (
    geometry: PossibleGeometry,
    shapeType?: AutoShape
):
    | {
          shapeSettings: Jolt.ShapeSettings | undefined;
          offset: Vector3 | undefined;
      }
    | undefined => {
    const jolt = Raw.module;
    let shapeSettings, offset;

    // if the user passes the shape use that, if not, try to infer it from the geometry
    if (!shapeType) shapeType = getShapeTypeFromGeometry(geometry);
    switch (shapeType) {
        case 'box': {
            geometry.computeBoundingBox();
            const { boundingBox } = geometry;
            let size;
            // if the geometry is a box, use it's parameters not the bounding box
            if (geometry instanceof BoxGeometry) {
                const { width, height, depth } = geometry.parameters;
                size = new Vector3(width, height, depth);
            } else size = boundingBox!.getSize(new Vector3());

            const shapeSize = new jolt.Vec3(size.x / 2, size.y / 2, size.z / 2);
            shapeSettings = new jolt.BoxShapeSettings(shapeSize);
            // jolt sucks at memory management
            jolt.destroy(shapeSize);

            offset = boundingBox!.getCenter(new Vector3());
            break;
        }

        case 'sphere': {
            geometry.computeBoundingSphere();
            const { boundingSphere } = geometry;
            const radius = boundingSphere!.radius;

            shapeSettings = new jolt.SphereShapeSettings(radius);
            offset = boundingSphere!.center;
            break;
        }
        case 'capsule': {
            // values set by parameters
            // three renamed CapsuleGeometry.parameters.length to .height in r168 (same value:
            // the height of the middle section, excluding the caps)
            const { radius, height } = (geometry as CapsuleGeometry).parameters;
            shapeSettings = new jolt.CapsuleShapeSettings(height / 2, radius);
            offset = new Vector3(0, height / 2, 0);
            break;
        }

        case 'cylinder': {
            // Jolt Cylinder doesn't take a top and bottom radius, so we'll just use the top radius
            const { radiusTop, height } = (geometry as CylinderGeometry).parameters;

            shapeSettings = new jolt.CylinderShapeSettings(height / 2, radiusTop, 0.5);
            offset = new Vector3(0, height / 2, 0);
            break;
        }
        // ConvexHull from points
        // this won't be determined from geometry automatically, but the user can pass it
        case 'convex': {
            // generate a new geometry to hold the simplified geo
            const simplifiedGeo = geometry.clone();
            // not sure this is needed.
            //TODO: Check and cleanup if we need normals. if not merge from root geo
            simplifiedGeo.computeVertexNormals();
            // merge points
            const mergedPoints = BufferGeometryUtils.mergeVertices(simplifiedGeo);
            const points = mergedPoints.getAttribute('position').array;

            // create the hull and add the points
            const hull = new jolt.ConvexHullShapeSettings();
            pushHullPoints(points, hull);
            shapeSettings = hull;

            // the two throwaway three geometries are ours, drop them
            mergedPoints.dispose();
            simplifiedGeo.dispose();
            break;
        }
        // trimesh as default if nothing else passed
        // using the buffer directly? which is better, array or direct?
        // base pulled from: https://github.com/sajal353/r3f-jolt/blob/main/src/Jolt/useTrimesh.ts
        default: {
            const vertices = geometry.getAttribute('position');
            // a non-indexed geometry is just triangle soup: vertex i*3 + n
            const indices = geometry.index?.array;
            const triangleCount = indices ? indices.length / 3 : vertices.count / 3;

            shapeSettings = createMeshShapeSettings(
                (i, out) => {
                    out.x = vertices.getX(i);
                    out.y = vertices.getY(i);
                    out.z = vertices.getZ(i);
                },
                vertices.count,
                (i, out) => {
                    const o = i * 3;
                    out.set_mIdx(0, indices ? indices[o] : o);
                    out.set_mIdx(1, indices ? indices[o + 1] : o + 1);
                    out.set_mIdx(2, indices ? indices[o + 2] : o + 2);
                    out.set_mMaterialIndex(0);
                },
                triangleCount
            );
        }
    }

    return { shapeSettings, offset };
};

// create a shape manually
export const generateShapeSettings = (
    shapeType: AutoShape | 'staticCompound' | 'mutableCompound',
    options?: any,
    inSettings?: Jolt.ShapeSettings
): Jolt.ShapeSettings => {
    const jolt = Raw.module;
    let shapeSettings = inSettings;
    // console.log("Generating shape shapeType", shapeType);

    // Switch based on shapeType to set the shapeSettings
    switch (shapeType) {
        // Compound shapes ---------------------------------
        /*case "staticCompound": {
			const shapes = options.shapes || [];
			shapeSettings = generateCompoundShapeSettings(shapes, false);
			break;
		}
		*/
        // Basic types -------------------------------------
        case 'sphere': {
            const radius = options.radius || 1;
            shapeSettings = new jolt.SphereShapeSettings(radius);
            break;
        }
        case 'capsule': {
            const radius = options.radius || 1;
            const height = options.height || 1;
            shapeSettings = new jolt.CapsuleShapeSettings(height / 2, radius);
            break;
        }
        case 'taperedCapsule': {
            const radius = options.radius || 1;
            const height = options.height || 1;
            const topRadius = options.topRadius || 0.5;
            shapeSettings = new jolt.TaperedCapsuleShapeSettings(height / 2, radius, topRadius);
            break;
        }
        case 'cylinder': {
            const radius = options.radius || 1;
            const height = options.height || 1;
            shapeSettings = new jolt.CylinderShapeSettings(height / 2, radius, 0.5);
            break;
        }

        case 'convex': {
            // if we passed a geometry pass to getShapeSettingsFromGeometry
            if (options.geometry) {
                const settings = getShapeSettingsFromGeometry(options.geometry, 'convex');
                shapeSettings = settings!.shapeSettings;
                break;
            }
            const points: Vector3[] = options.points || [];
            const hull = new jolt.ConvexHullShapeSettings();
            // flatten so the shared helper can reuse a single scratch Vec3
            const flat = new Float32Array(points.length * 3);
            points.forEach((point, index) => {
                flat[index * 3] = point.x;
                flat[index * 3 + 1] = point.y;
                flat[index * 3 + 2] = point.z;
            });
            pushHullPoints(flat, hull);
            shapeSettings = hull;
            break;
        }
        // this one is heavy
        case 'trimesh': {
            if (options.geometry) {
                const settings = getShapeSettingsFromGeometry(options.geometry, 'trimesh');
                shapeSettings = settings!.shapeSettings;
                break;
            }
            const vertices: Vector3[] = options.vertices || [];
            const indices: number[][] = options.indices || [];

            shapeSettings = createMeshShapeSettings(
                (i, out) => {
                    const point = vertices[i];
                    out.x = point.x;
                    out.y = point.y;
                    out.z = point.z;
                },
                vertices.length,
                (i, out) => {
                    const tri = indices[i];
                    out.set_mIdx(0, tri[0]);
                    out.set_mIdx(1, tri[1]);
                    out.set_mIdx(2, tri[2]);
                    out.set_mMaterialIndex(0);
                },
                indices.length
            );
            break;
        }

        // default to box
        default: {
            const size = options.size ? vec3.three(options.size) : new THREE.Vector3(1, 1, 1);
            const halfExtent = new jolt.Vec3(size.x / 2, size.y / 2, size.z / 2);
            shapeSettings = new jolt.BoxShapeSettings(halfExtent);
            // BoxShapeSettings copied the half extent
            jolt.destroy(halfExtent);
            break;
        }
    }
    return shapeSettings!;
};

export type CompoundShapeData = {
    shapeSettings: Jolt.ShapeSettings;
    position: anyVec3;
    quaternion: THREE.Quaternion;
    shape?: Jolt.Shape;
};
/**
 * Build a compound from already-created sub-settings.
 * The compound takes a reference on every sub-setting, so the caller must NOT destroy them:
 * destroying the returned compound settings frees the whole tree.
 */
export const generateCompoundShapeSettings = (shapes: CompoundShapeData[], dynamic = false) => {
    const jolt = Raw.module;
    const compoundShapeSettings = dynamic
        ? //@ts-ignore for now as it is loaded at runtime. Type will be added soon.
          new jolt.MutableCompoundShapeSettings()
        : new jolt.StaticCompoundShapeSettings();
    shapes.forEach(({ shapeSettings, position: inPosition, quaternion: inQuaternion }) => {
        const position = vec3.jolt(inPosition);
        const quaternion = quat.jolt(inQuaternion);
        compoundShapeSettings.AddShape(position, quaternion, shapeSettings, 0);
        //destroy the memory
        jolt.destroy(position);
        jolt.destroy(quaternion);
    });
    return compoundShapeSettings;
};

// take a threejs plane that is a heightfield and generate a Jolt heightfield shape
// this is a WIP
export const generateHeightfieldShapeFromThree = (heightfieldPlane: THREE.Mesh) => {
    //TODO: resolve what these props do
    //const mapScale = 0.35;
    const BLOCK_SIZE = 2;

    const jolt = Raw.module;
    const geometry = heightfieldPlane.geometry as THREE.PlaneGeometry;
    const vertices = geometry.attributes.position.array as Float32Array;
    const vertexCount = vertices.length / 3;
    const size = Math.sqrt(vertexCount);
    const planeWidth = geometry.parameters.width;
    const scale = planeWidth / size;
    //const positionVal = -size * scale * 0.5;

    // create the heightfield
    const shapeSettings = new jolt.HeightFieldShapeSettings();
    // mOffset/mScale are members of the settings, not allocations - Set() them in place.
    shapeSettings.mOffset.Set(0, 0, 0);
    shapeSettings.mScale.Set(scale, 1, scale);
    shapeSettings.mSampleCount = size;
    shapeSettings.mBlockSize = BLOCK_SIZE;
    // mHeightSamples is an ArrayFloat owned by the settings: resize() allocates inside it and
    // destroying the settings frees it. There is no _malloc here to _free.
    shapeSettings.mHeightSamples.resize(vertexCount);

    const heightSamples = new Float32Array(
        jolt.HEAPF32.buffer,
        jolt.getPointer(shapeSettings.mHeightSamples.data()),
        vertexCount
    ); // Convert the height samples into a Float32Array
    for (let i = 0; i < vertexCount; i++) {
        heightSamples[i] = vertices[i * 3 + 1];
        // TODO: NOTE, this implementation does not allow holes in the map, which Jolt supports
        //heightSamples[i] = Jolt.HeightFieldShapeConstantValues.prototype.cNoCollisionValue; // Invisible pixels make holes
    }
    return shapeSettings;
};

// Take a complex Jolt shape and generate a ThreeJS geometry.
// Taken from the Jolt JS examples. This used to exist twice, byte for byte, as
// `createMeshForShape` here and `createMeshFromShape` in utils/meshTools.ts; both names still
// resolve to this one implementation.
// Note on memory: `AABox::sBiggest()`, `Quat::sIdentity()` and `Shape::GetCenterOfMass()` return
// pointers to static temporaries inside the binder, not allocations - destroying them would free
// memory Jolt still owns. Only `scale` and `triContext` are ours to free.
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

/** @deprecated use `createMeshFromShape` - kept because it is part of the public API. */
export const createMeshForShape = createMeshFromShape;
