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
import { getValidatedHeightfieldSampleCount } from '../heightfield/generators';
import { type SurfaceMaterial, SurfaceMaterialTable } from '../heightfield/materials';
import { Raw } from '../raw';
import { type anyQuat, type anyVec3, devWarn, joltScratch, quat, vec3 } from '../utils';

export class ShapeSystem {
    /**
     * The Jolt physics system this shape system belongs to.
     *
     * Public because nothing inside the class reads it - it was `private` and unread, as was a
     * `bodyInterface` alongside it that hid behind a `@ts-expect-error` for exactly that reason
     * (issue #11). The body interface is gone (`GetBodyInterface()` is a cheap lookup whenever
     * one is actually wanted); this one stays as the handle callers reach the world through.
     */
    readonly joltPhysicsSystem: Jolt.PhysicsSystem;
    constructor(joltPhysicsSystem: Jolt.PhysicsSystem) {
        this.joltPhysicsSystem = joltPhysicsSystem;
    }
    // I'm not sure which functions to expose to the runtime
    //getShapeSettingsFromObject = (object: Object3D, shapeType?: AutoShape) => getShapeSettingsFromObject(object, shapeType);
    //getShapeSettingsFromGeometry = (geometry: BufferGeometry, shapeType?: AutoShape) => getShapeSettingsFromGeometry(geometry, shapeType);
}

/* ============================================================================
 * The shape pipeline (issue #107)
 *
 *   three.js object/geometry --describeShape()--> ShapeDescriptor --generateShape()--> Jolt.Shape
 *                                  (plain data)                       (owned, refcount 1)
 *
 * `ShapeDescriptor` is a plain, serialisable description of a shape: a type tag, its size
 * parameters, an optional local position/rotation (used when it is a child of a compound) and,
 * for compounds/decorators, its children. Nothing in it is a WASM object, so it can be compared,
 * hashed (`descriptorKey`), kept in React state, sent over the wire or written to disk.
 *
 * Everything that used to build shapes by hand - `getShapeSettingsFromGeometry`,
 * `getShapeSettingsFromObject` and `generateShapeSettings` - is now a thin wrapper over
 * `describeShape` + `createShapeSettings`, so there is exactly one place that knows how a
 * three.js geometry maps onto a Jolt shape and exactly one place that allocates.
 *
 * A `mutableCompound` descriptor (issue #108) is the one shape that can be changed after it
 * exists: `addSubShape` / `removeSubShape` / `modifySubShape` edit it in place. Everything else
 * is immutable once built - "changing" it means describing it again and generating a new shape.
 * ========================================================================== */

/**
 * Every descriptor tag the pipeline understands (implemented or reserved), and everything
 * `<Shape type>` / `<RigidBody shape>` / `<Physics defaultShape>` accept (issue #211).
 *
 * `AutoShape` and `ShapeType` used to be two separate unions - `AutoShape` had `'compound'` but
 * lacked the decorator/compound tags (`staticCompound`/`mutableCompound`/`scaled`/
 * `offsetCenterOfMass`), while `ShapeType` had those four but not `'compound'`. A prop typed
 * `AutoShape` therefore rejected `type="mutableCompound"` even though `describeShapeFromOptions`
 * (which every one of those props eventually calls) has always understood it. They are now one
 * union: `'compound'` is kept as a documented alias of `'staticCompound'`, normalised by
 * {@link normaliseShapeType} before anything else looks at it.
 */
export type ShapeType =
    | 'box'
    | 'sphere'
    | 'capsule'
    | 'taperedCapsule'
    | 'cylinder'
    | 'taperedCylinder'
    | 'convex'
    | 'trimesh'
    | 'heightfield'
    | 'compound'
    | 'staticCompound'
    | 'mutableCompound'
    | 'scaled'
    | 'offsetCenterOfMass';

/**
 * @deprecated alias of {@link ShapeType} - the two unions were collapsed into one in issue #211.
 * Kept so existing imports of `AutoShape` (and props typed with it) keep compiling unchanged.
 */
export type AutoShape = ShapeType;

export type Vec3Tuple = [number, number, number];
/** Quaternion as `[x, y, z, w]` - the order three.js and Jolt both use. */
export type QuatTuple = [number, number, number, number];
/** Vertex/index payloads accept typed arrays; `describeShape` always emits plain arrays. */
export type NumberArray = number[] | ArrayLike<number>;

export interface ShapeDescriptorBase {
    /**
     * Local translation of this shape inside its parent compound. Ignored on a root descriptor:
     * a root shape is positioned by the body, not by the shape (wrapping a root shape in a
     * `RotatedTranslatedShape` would move its centre of mass, so that stays opt in).
     */
    position?: Vec3Tuple;
    /** Local rotation inside the parent compound, `[x, y, z, w]`. See `position`. */
    rotation?: QuatTuple;
    /**
     * Where the source geometry's centre sits relative to its origin (bounding box/sphere centre
     * for the box/sphere paths, half the height for capsules/cylinders). Informational: it is
     * what `getShapeSettingsFromGeometry().offset` has always returned and it is **not** applied
     * to the generated shape.
     */
    offset?: Vec3Tuple;
    /**
     * A 32 bit tag stamped onto the generated shape (and onto the compound's sub shape record).
     * A contact reports it back as `payload.targetSubShape.userData`, which is how a `<Shape>`
     * knows which contacts are its own - issue #13.
     */
    userData?: number;
    /**
     * A human readable label, carried on the descriptor only - it never reaches Jolt. Reachable
     * from a contact as `payload.targetSubShape.descriptor?.name`.
     */
    name?: string;
}

export interface BoxShapeDescriptor extends ShapeDescriptorBase {
    type: 'box';
    /** Full extents (three.js `BoxGeometry` semantics); halved for Jolt. */
    size: Vec3Tuple;
    convexRadius?: number;
}
export interface SphereShapeDescriptor extends ShapeDescriptorBase {
    type: 'sphere';
    radius: number;
}
export interface CapsuleShapeDescriptor extends ShapeDescriptorBase {
    type: 'capsule';
    radius: number;
    /** Height of the cylindrical section, excluding the caps (three.js semantics). */
    height: number;
}
export interface TaperedCapsuleShapeDescriptor extends ShapeDescriptorBase {
    type: 'taperedCapsule';
    /** Height of the cylindrical section, excluding the caps. */
    height: number;
    topRadius: number;
    bottomRadius: number;
}
export interface CylinderShapeDescriptor extends ShapeDescriptorBase {
    type: 'cylinder';
    radius: number;
    /** Full height. */
    height: number;
    convexRadius?: number;
}
export interface TaperedCylinderShapeDescriptor extends ShapeDescriptorBase {
    type: 'taperedCylinder';
    /** Full height. */
    height: number;
    topRadius: number;
    bottomRadius: number;
    convexRadius?: number;
}
export interface ConvexShapeDescriptor extends ShapeDescriptorBase {
    type: 'convex';
    /** Flat `[x, y, z, x, y, z, ...]` hull points. */
    points: NumberArray;
    /** `mMaxConvexRadius`; Jolt's own default is used when omitted. */
    convexRadius?: number;
}
export interface TrimeshShapeDescriptor extends ShapeDescriptorBase {
    type: 'trimesh';
    /** Flat `[x, y, z, ...]` vertices. */
    vertices: NumberArray;
    /** Flat triangle indices, three per triangle. */
    indices: NumberArray;
}
export interface HeightfieldShapeDescriptor extends ShapeDescriptorBase {
    type: 'heightfield';
    /** `sampleCount * sampleCount` height samples, row major. */
    heights: NumberArray;
    sampleCount: number;
    /** Distance between samples on x/z (and the height multiplier on y). */
    scale: Vec3Tuple;
    blockSize?: number;
    /**
     * Per-surface friction/restitution (issue #46). Built into the shape's
     * `PhysicsMaterialList`; pass a {@link SurfaceMaterialTable} (rather than a plain array) to
     * keep the pointer mapping the contact listener resolves friction through.
     */
    materials?: SurfaceMaterialTable | SurfaceMaterial[];
    /**
     * One material index per **quad**: `(sampleCount - 1)^2` entries, row major. Required when
     * more than one material is given; ignored otherwise.
     */
    materialIndices?: NumberArray;
}
export interface StaticCompoundShapeDescriptor extends ShapeDescriptorBase {
    type: 'staticCompound';
    children: ShapeDescriptor[];
}
/**
 * A compound whose children can be added, removed and moved at runtime (issue #108).
 * Build it like a `staticCompound`, then edit the resulting shape with `addSubShape`,
 * `removeSubShape` and `modifySubShape` (or `BodyState`'s methods of the same names, which also
 * tell the body its mass properties and bounds moved).
 */
export interface MutableCompoundShapeDescriptor extends ShapeDescriptorBase {
    type: 'mutableCompound';
    children: ShapeDescriptor[];
}
export interface ScaledShapeDescriptor extends ShapeDescriptorBase {
    type: 'scaled';
    child: ShapeDescriptor;
    scale: Vec3Tuple;
}
/**
 * Moves the child's centre of mass without moving the child (issue #40): the classic "weeble"
 * trick, a body that always rights itself, and the way to stop a vehicle or a character tipping
 * over. The offset is in the child's local space.
 */
export interface OffsetCenterOfMassShapeDescriptor extends ShapeDescriptorBase {
    type: 'offsetCenterOfMass';
    child: ShapeDescriptor;
    /** How far to shift the centre of mass, in the child's local space. */
    centerOfMass: Vec3Tuple;
}

export type ShapeDescriptor =
    | BoxShapeDescriptor
    | SphereShapeDescriptor
    | CapsuleShapeDescriptor
    | TaperedCapsuleShapeDescriptor
    | CylinderShapeDescriptor
    | TaperedCylinderShapeDescriptor
    | ConvexShapeDescriptor
    | TrimeshShapeDescriptor
    | HeightfieldShapeDescriptor
    | StaticCompoundShapeDescriptor
    | MutableCompoundShapeDescriptor
    | ScaledShapeDescriptor
    | OffsetCenterOfMassShapeDescriptor;

/**
 * Loose, three.js flavoured options - what `<Shape>`'s props and the old `generateShapeSettings`
 * accept. `describeShapeFromOptions` normalises them into a `ShapeDescriptor`.
 */
export type ShapeOptions = {
    size?: anyVec3 | number;
    radius?: number;
    height?: number;
    topRadius?: number;
    bottomRadius?: number;
    convexRadius?: number;
    /** convex hull points / trimesh vertices, as three vectors, tuples or a flat array */
    points?: (THREE.Vector3 | Vec3Tuple)[] | NumberArray;
    vertices?: (THREE.Vector3 | Vec3Tuple)[] | NumberArray;
    verts?: (THREE.Vector3 | Vec3Tuple)[] | NumberArray;
    /** trimesh indices, either flat or one array per triangle */
    indices?: number[][] | NumberArray;
    indexes?: number[][] | NumberArray;
    geometry?: BufferGeometry;
    object?: Object3D;
    mesh?: THREE.Mesh;
    blockSize?: number;
    children?: ShapeDescriptor[];

    //* decorator shapes (issue #211: `describeShapeFromOptions` used to have no case for either
    //  tag, so `type="scaled"`/`type="offsetCenterOfMass"` silently fell through to a unit box) -
    /** the shape `'scaled'`/`'offsetCenterOfMass'` wrap. Required for either type. */
    child?: ShapeDescriptor;
    /**
     * `type: 'scaled'`'s per-axis scale. Named apart from `<Shape scale>` (`number[] | number`,
     * always wraps whatever shape it built, regardless of `type`) - this is the exact
     * `Vec3Tuple` a `ScaledShapeDescriptor` carries, and only means anything with `type="scaled"`.
     * @default [1, 1, 1]
     */
    decoratorScale?: Vec3Tuple;
    /** `'offsetCenterOfMass'`'s shift, in the child's local space. @default [0, 0, 0] */
    centerOfMass?: Vec3Tuple;

    //* heightfield, described from raw samples rather than a mesh (issue #155) ---
    /** `sampleCount * sampleCount` height samples, row major. */
    heights?: NumberArray;
    /** Samples per edge. Must be `blockSize * 2^n`. */
    sampleCount?: number;
    /**
     * Distance between samples on x/z and the height multiplier on y. Named apart from `scale`,
     * which wraps the finished shape in a `ScaledShape`.
     */
    heightScale?: anyVec3;
    /** Per-surface friction/restitution, see {@link HeightfieldShapeDescriptor.materials}. */
    materials?: SurfaceMaterialTable | SurfaceMaterial[];
    /** One material index per quad, see {@link HeightfieldShapeDescriptor.materialIndices}. */
    materialIndices?: NumberArray;
};

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
 * - Sub-settings added to a compound (`CompoundShapeSettings::AddShape`) or wrapped by a
 *   decorator (`ScaledShapeSettings`) are ref-counted by the parent. Destroying the parent
 *   settings frees them, so callers must not destroy sub-settings themselves.
 * - Shapes are `RefTarget`s, not `destroy()` targets: `new Raw.module.ScaledShape(...)` starts at
 *   zero references and deletes itself when the last reference goes away. Everything here hands
 *   back shapes with exactly one reference, released with `releaseShape`.
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

/* ============================================================================
 * Describing: three.js -> ShapeDescriptor
 * ========================================================================== */

// TODO: move this type later
type PossibleGeometry =
    | BufferGeometry
    | BoxGeometry
    | SphereGeometry
    | CapsuleGeometry
    | CylinderGeometry;

export type DescribeShapeOptions = {
    /** force a shape type instead of inferring one from the geometry */
    type?: ShapeType;
    /** convex radius for the box/cylinder paths (clamped to what Jolt accepts) */
    convexRadius?: number;
    /** heightfield block size */
    blockSize?: number;
    /**
     * Bake the *root* object's own scale into the shape as well (issue #40).
     *
     * Off by default: a root object's scale normally belongs to the body (`BodyState.scale`,
     * which wraps the shape in a `ScaledShape` that can be changed again later), not to the
     * shape, and baking it in would apply it twice. The scale of any mesh *below* the root is
     * always baked in, because a compound's children have no other way to carry one.
     */
    applyObjectScale?: boolean;
};

/**
 * `'compound'` is the historical name for a static compound (issue #211): every entry point that
 * takes a {@link ShapeType} runs it through here first, so `'compound'` and `'staticCompound'`
 * always produce identical descriptors. Exported so callers outside this file (a custom shape
 * pipeline, a test) can apply the same normalisation instead of re-implementing it.
 */
export const normaliseShapeType = (type?: ShapeType): ShapeType | undefined => {
    if (!type) return undefined;
    return type === 'compound' ? 'staticCompound' : type;
};

/**
 * three's `ConeGeometry` extends `CylinderGeometry` but keeps its own `{ radius, height }`
 * parameters (it calls `super(0, radius, ...)`), so reading `radiusTop`/`radiusBottom` blindly
 * gives `undefined` - and a NaN sized shape.
 */
const cylinderParameters = (geometry: CylinderGeometry) => {
    const parameters = geometry.parameters as CylinderGeometry['parameters'] & { radius?: number };
    const radiusTop = parameters.radiusTop ?? (parameters.radius !== undefined ? 0 : 1);
    const radiusBottom = parameters.radiusBottom ?? parameters.radius ?? 1;
    return { radiusTop, radiusBottom, height: parameters.height ?? 1 };
};

// check the instanceOf value against known three geometries
const getShapeTypeFromGeometry = (geometry: PossibleGeometry): ShapeType => {
    //hack the switch statement to check the instanceOf value
    switch (true) {
        case geometry instanceof BoxGeometry:
            return 'box';
        case geometry instanceof SphereGeometry:
            return 'sphere';
        case geometry instanceof CapsuleGeometry:
            return 'capsule';
        case geometry instanceof CylinderGeometry: {
            // a ConeGeometry (or any truncated cone) is a TaperedCylinder in Jolt; CylinderShape
            // only has one radius, which used to silently turn cones into cylinders.
            const { radiusTop, radiusBottom } = cylinderParameters(geometry as CylinderGeometry);
            return radiusTop === radiusBottom ? 'cylinder' : 'taperedCylinder';
        }
        // if unknown do a convex hull
        case geometry instanceof BufferGeometry:
            return 'convex';
        default:
            // bail out with a hull
            return 'convex';
    }
};

const toTuple = (vector: THREE.Vector3): Vec3Tuple => [vector.x, vector.y, vector.z];

/** Flatten hull/mesh points given as three vectors, tuples or an already flat array. */
const flattenPoints = (points: (THREE.Vector3 | Vec3Tuple)[] | NumberArray): number[] => {
    if (!points || points.length === 0) return [];
    const first = (points as unknown[])[0];
    if (typeof first === 'number') return Array.from(points as ArrayLike<number>);
    const flat: number[] = [];
    for (const point of points as (THREE.Vector3 | Vec3Tuple)[]) {
        if (Array.isArray(point)) flat.push(point[0], point[1], point[2]);
        else flat.push(point.x, point.y, point.z);
    }
    return flat;
};

/** Flatten triangle indices given per triangle (`[[0,1,2], ...]`) or already flat. */
const flattenIndices = (indices: number[][] | NumberArray): number[] => {
    if (!indices || indices.length === 0) return [];
    const first = (indices as unknown[])[0];
    if (typeof first === 'number') return Array.from(indices as ArrayLike<number>);
    const flat: number[] = [];
    for (const triangle of indices as number[][]) flat.push(triangle[0], triangle[1], triangle[2]);
    return flat;
};

const describeTrimeshGeometry = (geometry: PossibleGeometry): TrimeshShapeDescriptor => {
    const positions = geometry.getAttribute('position');
    const vertices: number[] = new Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
        vertices[i * 3] = positions.getX(i);
        vertices[i * 3 + 1] = positions.getY(i);
        vertices[i * 3 + 2] = positions.getZ(i);
    }
    // a non-indexed geometry is just triangle soup: vertex i, i+1, i+2
    const source = geometry.index?.array;
    const indices: number[] = source
        ? Array.from(source)
        : Array.from({ length: positions.count }, (_, i) => i);
    return { type: 'trimesh', vertices, indices };
};

const describeConvexGeometry = (
    geometry: PossibleGeometry,
    convexRadius?: number
): ConvexShapeDescriptor => {
    // generate a new geometry to hold the simplified geo
    const simplifiedGeo = geometry.clone();
    // not sure this is needed.
    //TODO: Check and cleanup if we need normals. if not merge from root geo
    simplifiedGeo.computeVertexNormals();
    // merge points
    const mergedPoints = BufferGeometryUtils.mergeVertices(simplifiedGeo);
    const points = Array.from(mergedPoints.getAttribute('position').array as ArrayLike<number>);
    // the two throwaway three geometries are ours, drop them
    mergedPoints.dispose();
    simplifiedGeo.dispose();
    const descriptor: ConvexShapeDescriptor = { type: 'convex', points };
    if (convexRadius !== undefined) descriptor.convexRadius = convexRadius;
    return descriptor;
};

// A heightfield samples the y of a (flat, square) plane geometry's vertices.
const describeHeightfieldMesh = (mesh: THREE.Mesh, blockSize = 2): HeightfieldShapeDescriptor => {
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    const positions = geometry.attributes.position.array as ArrayLike<number>;
    const vertexCount = positions.length / 3;
    // throws a clear error if this isn't a grid Jolt can accept at all
    const sampleCount = getValidatedHeightfieldSampleCount(vertexCount, blockSize);
    const planeWidth = geometry.parameters.width;
    const planeDepth = geometry.parameters.height ?? planeWidth;
    // `sampleCount` samples span `sampleCount - 1` segments, so the distance *between* samples
    // is width / (sampleCount - 1). Dividing by sampleCount (what this used to do) stretched
    // the physics field by one extra sample's worth - a visible render/physics mismatch at the
    // edges of a coarse field, and the reason `addHeightfield` derives its corner offset from
    // the same numbers instead of guessing.
    const scaleX = planeWidth / (sampleCount - 1);
    const scaleZ = planeDepth / (sampleCount - 1);

    const heights: number[] = new Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) heights[i] = positions[i * 3 + 1];

    return {
        type: 'heightfield',
        heights,
        sampleCount,
        scale: [scaleX, 1, scaleZ],
        blockSize
    };
};

/**
 * Describe a single three.js geometry.
 *
 * The type is inferred from the geometry class (`BoxGeometry` -> box, `SphereGeometry` ->
 * sphere, ...) unless `options.type` forces one. Sizes come from the geometry's own parameters
 * where three.js has them and from its bounding volume otherwise.
 */
export const describeGeometry = (
    geometry: PossibleGeometry,
    options: DescribeShapeOptions = {}
): ShapeDescriptor => {
    const shapeType = normaliseShapeType(options.type) ?? getShapeTypeFromGeometry(geometry);

    switch (shapeType) {
        case 'box': {
            geometry.computeBoundingBox();
            const { boundingBox } = geometry;
            let size: Vector3;
            // if the geometry is a box, use it's parameters not the bounding box
            if (geometry instanceof BoxGeometry) {
                const { width, height, depth } = geometry.parameters;
                size = new Vector3(width, height, depth);
            } else size = boundingBox!.getSize(new Vector3());

            const descriptor: BoxShapeDescriptor = {
                type: 'box',
                size: toTuple(size),
                offset: toTuple(boundingBox!.getCenter(new Vector3()))
            };
            if (options.convexRadius !== undefined) descriptor.convexRadius = options.convexRadius;
            return descriptor;
        }
        case 'sphere': {
            geometry.computeBoundingSphere();
            const { boundingSphere } = geometry;
            return {
                type: 'sphere',
                radius: boundingSphere!.radius,
                // a copy: `boundingSphere.center` belongs to the geometry
                offset: toTuple(boundingSphere!.center)
            };
        }
        case 'capsule': {
            // three renamed CapsuleGeometry.parameters.length to .height in r168 (same value:
            // the height of the middle section, excluding the caps)
            const { radius, height } = (geometry as CapsuleGeometry).parameters;
            return { type: 'capsule', radius, height, offset: [0, height / 2, 0] };
        }
        case 'taperedCapsule': {
            const { radius, height } = (geometry as CapsuleGeometry).parameters;
            return {
                type: 'taperedCapsule',
                height,
                topRadius: radius,
                bottomRadius: radius,
                offset: [0, height / 2, 0]
            };
        }
        case 'cylinder': {
            // Jolt's CylinderShape has a single radius, so a tapered three cylinder keeps its
            // widest radius here - use `taperedCylinder` for the real thing.
            const { radiusTop, radiusBottom, height } = cylinderParameters(
                geometry as CylinderGeometry
            );
            const descriptor: CylinderShapeDescriptor = {
                type: 'cylinder',
                radius: Math.max(radiusTop, radiusBottom),
                height,
                offset: [0, height / 2, 0]
            };
            if (options.convexRadius !== undefined) descriptor.convexRadius = options.convexRadius;
            return descriptor;
        }
        case 'taperedCylinder': {
            const { radiusTop, radiusBottom, height } = cylinderParameters(
                geometry as CylinderGeometry
            );
            const descriptor: TaperedCylinderShapeDescriptor = {
                type: 'taperedCylinder',
                height,
                topRadius: radiusTop,
                bottomRadius: radiusBottom,
                offset: [0, height / 2, 0]
            };
            if (options.convexRadius !== undefined) descriptor.convexRadius = options.convexRadius;
            return descriptor;
        }
        case 'convex':
            return describeConvexGeometry(geometry, options.convexRadius);
        case 'trimesh':
            return describeTrimeshGeometry(geometry);
        case 'heightfield':
            return describeHeightfieldMesh(new THREE.Mesh(geometry), options.blockSize);
        default:
            // compounds and decorators have no single-geometry meaning; a mesh is the safe answer
            return describeTrimeshGeometry(geometry);
    }
};

/** A scale that is (near enough) 1 on every axis needs no `ScaledShape`. */
const isUnitScale = (scale: THREE.Vector3, epsilon = 1e-6) =>
    Math.abs(scale.x - 1) < epsilon &&
    Math.abs(scale.y - 1) < epsilon &&
    Math.abs(scale.z - 1) < epsilon;

/**
 * Wrap `descriptor` in a `scaled` descriptor when `scale` is not 1 (issue #40).
 * A `scaled` wrapper already holding the same child is rescaled rather than stacked.
 */
const withScale = (descriptor: ShapeDescriptor, scale: THREE.Vector3): ShapeDescriptor => {
    if (isUnitScale(scale)) return descriptor;
    return { type: 'scaled', child: descriptor, scale: toTuple(scale) };
};

/**
 * Describe a three.js object: every mesh below it (including the object itself) becomes one
 * child descriptor carrying that mesh's local position/rotation - and, when it is scaled, a
 * `scaled` wrapper around it (issue #40: a scaled mesh used to describe a shape at its unscaled
 * size, so the collider did not match what was on screen).
 *
 * The root object's own scale is left to the body unless `options.applyObjectScale` is set; see
 * `DescribeShapeOptions.applyObjectScale`.
 *
 * A single mesh is described directly rather than wrapped in a one-child compound.
 */
export const describeObject = (
    object: Object3D,
    options: DescribeShapeOptions = {}
): ShapeDescriptor => {
    const children: ShapeDescriptor[] = [];
    object.traverse((child) => {
        // adding ignore to meshes skips the shape generator
        if (!(child instanceof THREE.Mesh) || !child.geometry) return;
        // a nested mesh's scale can only travel with the shape; the root's belongs to the body
        const scaled =
            child === object && !options.applyObjectScale
                ? describeGeometry(child.geometry, options)
                : withScale(describeGeometry(child.geometry, options), child.scale);
        scaled.position = toTuple(child.position);
        scaled.rotation = [
            child.quaternion.x,
            child.quaternion.y,
            child.quaternion.z,
            child.quaternion.w
        ];
        children.push(scaled);
    });

    // if theres only one, return it - its transform belongs to the body, not to the shape
    const described: ShapeDescriptor =
        children.length === 1 ? children[0] : { type: 'staticCompound', children };
    // a scaled group scales everything under it; a root *mesh* already had its scale applied above
    if (!options.applyObjectScale || object instanceof THREE.Mesh) return described;
    return withScale(described, object.scale);
};

/**
 * The one entry point: describe a three.js object or geometry as a `ShapeDescriptor`.
 *
 * ```ts
 * const descriptor = describeShape(mesh);                 // infer from the geometry
 * const descriptor = describeShape(mesh, { type: 'convex' });
 * const shape = generateShape(descriptor);                // owned, refcount 1
 * ```
 */
export function describeShape(
    source: Object3D | PossibleGeometry,
    options: DescribeShapeOptions = {}
): ShapeDescriptor {
    if (source instanceof BufferGeometry) return describeGeometry(source, options);
    if (normaliseShapeType(options.type) === 'heightfield' && source instanceof THREE.Mesh)
        return describeHeightfieldMesh(source, options.blockSize);
    return describeObject(source, options);
}

/**
 * Normalise the loose `{ radius, height, size, points, geometry, ... }` options that `<Shape>`
 * and the old `generateShapeSettings` take into a `ShapeDescriptor`.
 */
export function describeShapeFromOptions(
    type: ShapeType = 'box',
    options: ShapeOptions = {}
): ShapeDescriptor {
    const shapeType = normaliseShapeType(type) as ShapeType;
    // anything holding a geometry (or an object) is described by the three.js path
    if (options.geometry && shapeType !== 'heightfield')
        return describeGeometry(options.geometry, {
            type: shapeType,
            convexRadius: options.convexRadius
        });
    if (options.object) return describeObject(options.object, { type: shapeType });

    switch (shapeType) {
        case 'sphere':
            return { type: 'sphere', radius: options.radius ?? 1 };
        case 'capsule':
            return { type: 'capsule', radius: options.radius ?? 1, height: options.height ?? 1 };
        case 'taperedCapsule':
            return {
                type: 'taperedCapsule',
                height: options.height ?? 1,
                // historical option names: `radius` is the bottom radius, `topRadius` the top one
                topRadius: options.topRadius ?? 0.5,
                bottomRadius: options.bottomRadius ?? options.radius ?? 1
            };
        case 'cylinder':
            return {
                type: 'cylinder',
                radius: options.radius ?? 1,
                height: options.height ?? 1,
                convexRadius: options.convexRadius ?? 0.5
            };
        case 'taperedCylinder':
            return {
                type: 'taperedCylinder',
                height: options.height ?? 1,
                topRadius: options.topRadius ?? 0.5,
                bottomRadius: options.bottomRadius ?? options.radius ?? 1,
                convexRadius: options.convexRadius
            };
        case 'convex': {
            const descriptor: ConvexShapeDescriptor = {
                type: 'convex',
                points: flattenPoints(options.points ?? options.vertices ?? options.verts ?? [])
            };
            if (options.convexRadius !== undefined) descriptor.convexRadius = options.convexRadius;
            return descriptor;
        }
        case 'trimesh':
            return {
                type: 'trimesh',
                vertices: flattenPoints(options.vertices ?? options.verts ?? options.points ?? []),
                indices: flattenIndices(options.indices ?? options.indexes ?? [])
            };
        case 'heightfield': {
            // #155: <HeightfieldCollider args={[samples, sampleCount, scale]}> hands over the
            // samples directly; the mesh path below is what <Shape mesh={...}> has always done.
            if (options.heights) {
                const blockSize = options.blockSize ?? 2;
                const sampleCount =
                    options.sampleCount ??
                    getValidatedHeightfieldSampleCount(options.heights.length, blockSize);
                const descriptor: HeightfieldShapeDescriptor = {
                    type: 'heightfield',
                    heights: options.heights,
                    sampleCount,
                    scale: toTuple(vec3.three(options.heightScale ?? [1, 1, 1])),
                    blockSize
                };
                if (options.materials) descriptor.materials = options.materials;
                if (options.materialIndices) descriptor.materialIndices = options.materialIndices;
                return descriptor;
            }
            const mesh =
                options.mesh ?? (options.geometry ? new THREE.Mesh(options.geometry) : undefined);
            if (!mesh)
                throw new Error(
                    'react-three-jolt: a heightfield needs `heights` (with `sampleCount`), or a ' +
                        '`mesh`/`geometry` to sample'
                );
            return describeHeightfieldMesh(mesh, options.blockSize);
        }
        case 'staticCompound':
        case 'mutableCompound':
            return { type: shapeType, children: options.children ?? [] };
        case 'scaled': {
            if (!options.child)
                throw new Error(
                    "react-three-jolt: a 'scaled' shape needs `child` - the ShapeDescriptor it scales"
                );
            return {
                type: 'scaled',
                child: options.child,
                scale: options.decoratorScale ?? [1, 1, 1]
            };
        }
        case 'offsetCenterOfMass': {
            if (!options.child)
                throw new Error(
                    "react-three-jolt: an 'offsetCenterOfMass' shape needs `child` - the " +
                        'ShapeDescriptor whose centre of mass it moves'
                );
            return {
                type: 'offsetCenterOfMass',
                child: options.child,
                centerOfMass: options.centerOfMass ?? [0, 0, 0]
            };
        }
        default: {
            // a bare number means a cube of that size; anything vector shaped is x/y/z
            const size =
                typeof options.size === 'number'
                    ? new Vector3(options.size, options.size, options.size)
                    : vec3.three(options.size ?? [1, 1, 1]);
            const descriptor: BoxShapeDescriptor = { type: 'box', size: toTuple(size) };
            if (options.convexRadius !== undefined) descriptor.convexRadius = options.convexRadius;
            return descriptor;
        }
    }
}

/* ============================================================================
 * Descriptor keys - a stable identity for React deps and caches
 * ========================================================================== */

// FNV-1a over the raw bytes of every number, so 1 and 1.0000001 hash differently. Long vertex
// arrays are hashed rather than stringified: a 2k triangle mesh would otherwise turn into a
// megabyte of JSON on every render.
const hashScratch = new Float64Array(1);
const hashBytes = new Uint8Array(hashScratch.buffer);
const hashNumbers = (values: ArrayLike<number>): string => {
    let hash = 2166136261;
    for (let i = 0; i < values.length; i++) {
        hashScratch[0] = values[i];
        for (let b = 0; b < 8; b++) {
            hash ^= hashBytes[b];
            hash = Math.imul(hash, 16777619);
        }
    }
    return `${values.length}#${(hash >>> 0).toString(36)}`;
};

const HASH_THRESHOLD = 32;

const stableStringify = (value: unknown): string => {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (ArrayBuffer.isView(value)) return `"${hashNumbers(value as unknown as ArrayLike<number>)}"`;
    if (Array.isArray(value)) {
        if (value.length > HASH_THRESHOLD && typeof value[0] === 'number')
            return `"${hashNumbers(value as number[])}"`;
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(',');
    return `{${body}}`;
};

/**
 * A stable string identity for any plain value: key order does not matter and long number arrays
 * are hashed rather than serialised. Meant for React effect dependencies and caches.
 *
 * Only pass plain data - a three.js object or a WASM handle will be walked field by field.
 */
export const stableKey = (value: unknown): string => stableStringify(value);

/**
 * A stable string identity for a descriptor: the same description always produces the same key,
 * whatever order its keys were written in. Long vertex/index arrays are hashed so the key stays
 * small for meshes. Meant for React effect dependencies and shape caches.
 */
export const descriptorKey = (descriptor: ShapeDescriptor): string => stableStringify(descriptor);

/* ============================================================================
 * Generating: ShapeDescriptor -> Jolt
 * ========================================================================== */

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
    vertices: ArrayLike<number>,
    indices: ArrayLike<number>
): Jolt.MeshShapeSettings => {
    const jolt = Raw.module;
    const vertexCount = Math.floor(vertices.length / 3);
    const triangleCount = Math.floor(indices.length / 3);

    const verts = new jolt.VertexList();
    verts.reserve(vertexCount);
    const vertex = new jolt.Float3(0, 0, 0);
    for (let i = 0; i < vertexCount; i++) {
        vertex.x = vertices[i * 3];
        vertex.y = vertices[i * 3 + 1];
        vertex.z = vertices[i * 3 + 2];
        // push_back copies, so the same scratch Float3 serves every vertex
        verts.push_back(vertex);
    }
    jolt.destroy(vertex);

    const tris = new jolt.IndexedTriangleList();
    tris.reserve(triangleCount);
    const triangle = new jolt.IndexedTriangle(0, 0, 0, 0);
    for (let i = 0; i < triangleCount; i++) {
        triangle.set_mIdx(0, indices[i * 3]);
        triangle.set_mIdx(1, indices[i * 3 + 1]);
        triangle.set_mIdx(2, indices[i * 3 + 2]);
        triangle.set_mMaterialIndex(0);
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

/**
 * Attach a heightfield's materials (issue #46).
 *
 * `mMaterialIndices` is one `uint8` per quad - `(sampleCount - 1)^2`, row major - and Jolt only
 * looks at it when there is more than one material. The `PhysicsMaterialList` is copied into the
 * settings (and again into the shape), so the list is ours to destroy while the materials inside
 * it are ref-counted by the shape; see `heightfield/materials.ts` for the verified ref counts.
 */
const applyHeightfieldMaterials = (
    shapeSettings: Jolt.HeightFieldShapeSettings,
    descriptor: HeightfieldShapeDescriptor
): void => {
    const { materials, materialIndices, sampleCount } = descriptor;
    if (!materials) return;
    const table =
        materials instanceof SurfaceMaterialTable ? materials : new SurfaceMaterialTable(materials);
    if (table.size === 0) return;

    const jolt = Raw.module;
    if (table.size > 1) {
        const quads = (sampleCount - 1) * (sampleCount - 1);
        if (!materialIndices || materialIndices.length !== quads)
            throw new Error(
                `Heightfield: ${table.size} materials need one material index per quad ` +
                    `(${quads} for ${sampleCount} samples per edge), got ` +
                    `${materialIndices?.length ?? 0}.`
            );
        // an ArrayUint8 owned by the settings: resize allocates inside it, destroying the
        // settings frees it
        shapeSettings.mMaterialIndices.resize(quads);
        const target = new Uint8Array(
            jolt.HEAPU8.buffer,
            jolt.getPointer(shapeSettings.mMaterialIndices.data()),
            quads
        );
        for (let i = 0; i < quads; i++) {
            const index = materialIndices[i];
            if (!(index >= 0) || index >= table.size)
                throw new Error(
                    `Heightfield: material index ${index} at quad ${i} is outside the ` +
                        `${table.size} materials given.`
                );
            target[i] = index;
        }
    }

    const list = table.createList();
    try {
        // assignment copies the vector (and takes a reference on every material in it)
        shapeSettings.mMaterials = list;
    } finally {
        jolt.destroy(list);
    }
};

const createHeightfieldShapeSettings = (
    descriptor: HeightfieldShapeDescriptor
): Jolt.HeightFieldShapeSettings => {
    const jolt = Raw.module;
    const { heights, sampleCount, scale, blockSize = 2 } = descriptor;
    const sampleTotal = sampleCount * sampleCount;

    // create the heightfield
    const shapeSettings = new jolt.HeightFieldShapeSettings();
    // mOffset/mScale are members of the settings, not allocations - Set() them in place.
    const offset = descriptor.offset ?? [0, 0, 0];
    shapeSettings.mOffset.Set(offset[0], offset[1], offset[2]);
    shapeSettings.mScale.Set(scale[0], scale[1], scale[2]);
    shapeSettings.mSampleCount = sampleCount;
    shapeSettings.mBlockSize = blockSize;
    // mHeightSamples is an ArrayFloat owned by the settings: resize() allocates inside it and
    // destroying the settings frees it. There is no _malloc here to _free.
    shapeSettings.mHeightSamples.resize(sampleTotal);

    const heightSamples = new Float32Array(
        jolt.HEAPF32.buffer,
        jolt.getPointer(shapeSettings.mHeightSamples.data()),
        sampleTotal
    ); // Convert the height samples into a Float32Array
    for (let i = 0; i < sampleTotal; i++) {
        heightSamples[i] = heights[i];
        // TODO: NOTE, this implementation does not allow holes in the map, which Jolt supports
        //heightSamples[i] = Jolt.HeightFieldShapeConstantValues.prototype.cNoCollisionValue; // Invisible pixels make holes
    }
    try {
        applyHeightfieldMaterials(shapeSettings, descriptor);
    } catch (error) {
        // nothing has taken ownership of the settings yet, so they are ours to free
        jolt.destroy(shapeSettings);
        throw error;
    }
    return shapeSettings;
};

/** Jolt rejects a convex radius larger than the shape it is meant to round off. */
const clampConvexRadius = (requested: number | undefined, ...limits: number[]) =>
    Math.max(0, Math.min(requested ?? 0.05, ...limits));

/** Build a compound's settings from child descriptors. */
const createCompoundShapeSettings = (
    children: ShapeDescriptor[],
    dynamic: boolean
): Jolt.CompoundShapeSettings => {
    const jolt = Raw.module;
    const compound = dynamic
        ? new jolt.MutableCompoundShapeSettings()
        : new jolt.StaticCompoundShapeSettings();
    // one scratch position/rotation for the whole loop: AddShape copies both
    const position = new jolt.Vec3(0, 0, 0);
    const rotation = new jolt.Quat(0, 0, 0, 1);
    try {
        for (const child of children) {
            const [x, y, z] = child.position ?? [0, 0, 0];
            const [qx, qy, qz, qw] = child.rotation ?? [0, 0, 0, 1];
            position.Set(x, y, z);
            rotation.Set(qx, qy, qz, qw);
            // the compound takes a reference on the sub-settings; destroying the compound frees
            // them, so a child is built only once nothing after it can throw
            const childSettings = createShapeSettings(child);
            compound.AddShape(position, rotation, childSettings, child.userData ?? 0);
        }
    } catch (error) {
        // whatever was added already is released by the compound's destructor
        jolt.destroy(compound);
        throw error;
    } finally {
        jolt.destroy(position);
        jolt.destroy(rotation);
    }
    return compound;
};

/**
 * Build the `ShapeSettings` for a descriptor. The caller owns the result: hand it to
 * `createShapeFromSettings` (which destroys it) or destroy it.
 *
 * The children of a compound and the inner shape of a decorator are ref-counted by their parent:
 * destroying the returned settings frees the whole tree, and nothing inside it may be destroyed
 * by hand.
 *
 * Every descriptor's `userData` is stamped onto the shape itself (issue #13). That matters
 * because `CompoundShape::GetSubShapeUserData` recurses into the child a `SubShapeID` points at
 * and returns the **child shape's** user data - not the `mUserData` the compound stores per
 * sub shape record - so the shape is the only place a contact can read it back from. Both are
 * written: the record keeps `AddShape`'s copy for anyone walking the compound by index.
 */
export function createShapeSettings(descriptor: ShapeDescriptor): Jolt.ShapeSettings {
    const settings = buildShapeSettings(descriptor);
    if (descriptor.userData !== undefined) settings.mUserData = descriptor.userData;
    return settings;
}

function buildShapeSettings(descriptor: ShapeDescriptor): Jolt.ShapeSettings {
    const jolt = Raw.module;
    switch (descriptor.type) {
        case 'box': {
            const [x, y, z] = descriptor.size;
            const halfExtent = new jolt.Vec3(x / 2, y / 2, z / 2);
            const convexRadius = clampConvexRadius(
                descriptor.convexRadius,
                Math.abs(x) / 2,
                Math.abs(y) / 2,
                Math.abs(z) / 2
            );
            const settings = new jolt.BoxShapeSettings(halfExtent, convexRadius);
            // BoxShapeSettings copied the half extent
            jolt.destroy(halfExtent);
            return settings;
        }
        case 'sphere':
            return new jolt.SphereShapeSettings(descriptor.radius);
        case 'capsule':
            return new jolt.CapsuleShapeSettings(descriptor.height / 2, descriptor.radius);
        case 'taperedCapsule':
            return new jolt.TaperedCapsuleShapeSettings(
                descriptor.height / 2,
                descriptor.topRadius,
                descriptor.bottomRadius
            );
        case 'cylinder':
            return new jolt.CylinderShapeSettings(
                descriptor.height / 2,
                descriptor.radius,
                clampConvexRadius(
                    descriptor.convexRadius,
                    Math.abs(descriptor.radius),
                    Math.abs(descriptor.height) / 2
                )
            );
        case 'taperedCylinder':
            return new jolt.TaperedCylinderShapeSettings(
                descriptor.height / 2,
                descriptor.topRadius,
                descriptor.bottomRadius,
                clampConvexRadius(
                    descriptor.convexRadius,
                    Math.abs(descriptor.topRadius),
                    Math.abs(descriptor.bottomRadius),
                    Math.abs(descriptor.height) / 2
                )
            );
        case 'convex': {
            const hull = new jolt.ConvexHullShapeSettings();
            pushHullPoints(descriptor.points as ArrayLike<number>, hull);
            if (descriptor.convexRadius !== undefined)
                hull.mMaxConvexRadius = descriptor.convexRadius;
            return hull;
        }
        case 'trimesh':
            return createMeshShapeSettings(
                descriptor.vertices as ArrayLike<number>,
                descriptor.indices as ArrayLike<number>
            );
        case 'heightfield':
            return createHeightfieldShapeSettings(descriptor);
        case 'staticCompound':
            return createCompoundShapeSettings(descriptor.children, false);
        case 'mutableCompound':
            return createCompoundShapeSettings(descriptor.children, true);
        case 'scaled': {
            // ScaledShapeSettings takes a reference on the inner settings: destroying the scaled
            // settings frees them, so the inner ones are never destroyed here.
            const inner = createShapeSettings(descriptor.child);
            const scale = vec3.jolt(descriptor.scale);
            try {
                return new jolt.ScaledShapeSettings(inner, scale);
            } catch (error) {
                jolt.destroy(inner);
                throw error;
            } finally {
                jolt.destroy(scale);
            }
        }
        case 'offsetCenterOfMass': {
            // like ScaledShapeSettings, this takes a reference on the inner settings: destroying
            // the decorator frees them, so they are never destroyed here.
            const inner = createShapeSettings(descriptor.child);
            const offset = vec3.jolt(descriptor.centerOfMass);
            try {
                // note the argument order: OffsetCenterOfMassShapeSettings(offset, shape)
                return new jolt.OffsetCenterOfMassShapeSettings(offset, inner);
            } catch (error) {
                jolt.destroy(inner);
                throw error;
            } finally {
                jolt.destroy(offset);
            }
        }
        default:
            throw new Error(
                `react-three-jolt: unknown shape descriptor type '${
                    (descriptor as ShapeDescriptor).type
                }'`
            );
    }
}

/**
 * Descriptor -> `Jolt.Shape`. The returned shape is owned by the caller with a reference count
 * of exactly 1: hand it to something that takes its own reference (a body, a compound) and then
 * `releaseShape()` it, or `releaseShape()` it when you are done.
 */
export function generateShape(descriptor: ShapeDescriptor): Jolt.Shape {
    return createShapeFromSettings(createShapeSettings(descriptor));
}

/* ============================================================================
 * Dynamic mesh shapes (issue #112)
 *
 * Jolt does not support a dynamic body with a `MeshShape`. A mesh is a one sided triangle soup
 * with no inside, so mesh-vs-mesh does not collide at all and mesh-vs-convex only works from the
 * outside; a dynamic mesh body has no usable mass properties, sinks through everything and ends
 * up with a NaN position - which is exactly what issue #112 reported.
 * See https://jrouwe.github.io/JoltPhysics/#dynamic-mesh-shapes
 *
 * So a `trimesh` on a dynamic body is converted to something Jolt can simulate. The default is a
 * convex hull of the same points, which is right for most props; `'error'` refuses instead, and
 * `'decompose'` (a convex decomposition into several hulls) is reserved.
 * ========================================================================== */

/** What to do with a `trimesh` descriptor on a dynamic body. See `makeDescriptorDynamicSafe`. */
export type DynamicMeshStrategy = 'convex' | 'decompose' | 'error';

/** True when `descriptor` is, or contains, a `trimesh`. */
export const containsMeshShape = (descriptor: ShapeDescriptor): boolean => {
    switch (descriptor.type) {
        case 'trimesh':
            return true;
        case 'staticCompound':
        case 'mutableCompound':
            return descriptor.children.some(containsMeshShape);
        case 'scaled':
        case 'offsetCenterOfMass':
            return containsMeshShape(descriptor.child);
        default:
            return false;
    }
};

/**
 * Apply the #112 policy to one trimesh: throw for `'error'`/`'decompose'`, warn for `'convex'`.
 * Exported so callers that already hold a `MeshShape` (rather than a descriptor) give the same
 * answers as the descriptor path.
 */
export const checkDynamicMeshStrategy = (strategy: DynamicMeshStrategy = 'convex'): void => {
    if (strategy === 'error')
        throw new Error(
            'react-three-jolt: jolt cannot simulate a dynamic body with a trimesh shape (mesh vs ' +
                'mesh does not collide and the body falls through the world). Use a static body, ' +
                "or `dynamicMeshStrategy: 'convex'`."
        );
    if (strategy === 'decompose')
        throw new Error(
            "react-three-jolt: `dynamicMeshStrategy: 'decompose'` (convex decomposition) is " +
                'reserved and not implemented yet. Use a compound of `convex` shapes you ' +
                "decomposed yourself, or `'convex'` for a single hull."
        );
    devWarn(
        'react-three-jolt: a dynamic body cannot use a trimesh shape - jolt has no collision for ' +
            'mesh vs mesh and the body would fall through the world. Using a convex hull of the ' +
            'same points instead (issue #112); make the body static, or pass ' +
            "`dynamicMeshStrategy: 'error'`, to opt out."
    );
};

/**
 * Replace every `trimesh` in a descriptor with something a dynamic body can use (issue #112).
 * Returns the descriptor unchanged when there is no mesh in it.
 *
 * @param strategy `'convex'` (default) takes the convex hull of the mesh's own vertices,
 * `'error'` throws, `'decompose'` is reserved for a future convex decomposition.
 */
export function makeDescriptorDynamicSafe(
    descriptor: ShapeDescriptor,
    strategy: DynamicMeshStrategy = 'convex'
): ShapeDescriptor {
    switch (descriptor.type) {
        case 'trimesh': {
            checkDynamicMeshStrategy(strategy);
            const { type: _type, vertices, indices: _indices, ...rest } = descriptor;
            return { ...rest, type: 'convex', points: vertices };
        }
        case 'staticCompound':
        case 'mutableCompound': {
            if (!containsMeshShape(descriptor)) return descriptor;
            return {
                ...descriptor,
                children: descriptor.children.map((child) =>
                    makeDescriptorDynamicSafe(child, strategy)
                )
            };
        }
        case 'scaled':
        case 'offsetCenterOfMass': {
            if (!containsMeshShape(descriptor)) return descriptor;
            return { ...descriptor, child: makeDescriptorDynamicSafe(descriptor.child, strategy) };
        }
        default:
            return descriptor;
    }
}

/**
 * Build a convex hull around an existing shape, for the case where the caller handed us a
 * `MeshShape` rather than a descriptor (issue #112).
 *
 * The triangles come back in the shape's own local space (a `MeshShape`'s centre of mass is the
 * origin), so the hull sits exactly where the mesh did. The returned shape is owned by the caller
 * with one reference, like `generateShape`; the input shape is not touched.
 */
export function convexHullFromShape(shape: Jolt.Shape): Jolt.Shape {
    const geometry = createMeshFromShape(shape);
    try {
        return generateShape(describeConvexGeometry(geometry));
    } finally {
        geometry.dispose();
    }
}

/* ============================================================================
 * Mutable compounds - editing a compound at runtime (issue #108)
 *
 * A `{ type: 'mutableCompound' }` descriptor builds a `MutableCompoundShape`: the same thing as
 * a static compound, except its children can be added, removed and moved after the shape exists.
 * Everything below edits such a shape in place; nothing here rebuilds it.
 *
 * Ownership: `MutableCompoundShape::AddShape` takes its own reference on the child shape and
 * `RemoveShape` releases it. `addSubShape` therefore drops the reference `generateShape` handed
 * it as soon as the compound has one, and `removeSubShape` must NOT destroy or release anything -
 * the compound owns its children and frees them itself.
 *
 * A body holding the compound caches its bounds and mass properties, so after any of these the
 * body must be told: that is `BodyState.addSubShape` / `removeSubShape` / `modifySubShape`, which
 * wrap these and call `BodyInterface::NotifyShapeChanged`.
 * ========================================================================== */

/** Where a sub shape sits inside its parent compound. Both parts are optional in a modify. */
export type SubShapeTransform = {
    position?: anyVec3;
    rotation?: anyQuat;
};

/** True when `shape` is a compound whose children can be edited at runtime. */
export const isMutableCompoundShape = (shape?: Jolt.Shape | null): boolean =>
    !!shape && shape.GetSubType() === Raw.module.EShapeSubType_MutableCompound;

/**
 * Narrow a shape to a `MutableCompoundShape`. Throws (rather than handing back a bad cast) when
 * the shape is a static compound or anything else: `castObject` does not check.
 */
export const asMutableCompoundShape = (shape?: Jolt.Shape | null): Jolt.MutableCompoundShape => {
    if (!isMutableCompoundShape(shape))
        throw new Error(
            'react-three-jolt: this shape is not a MutableCompoundShape, so its children cannot ' +
                "be edited at runtime. Build it from a `{ type: 'mutableCompound' }` descriptor " +
                '(or a `<Shape dynamic>`) instead of a static compound.'
        );
    return Raw.module.castObject(shape as Jolt.Shape, Raw.module.MutableCompoundShape);
};

/**
 * A shape's centre of mass as plain numbers.
 *
 * `GetCenterOfMass()` hands back a pointer to a static temporary that the next by-value call
 * overwrites, and `NotifyShapeChanged` needs the value from *before* the edit, so it has to be
 * copied out rather than held.
 */
export const readCenterOfMass = (shape: Jolt.Shape): Vec3Tuple => {
    const center = shape.GetCenterOfMass();
    return [center.GetX(), center.GetY(), center.GetZ()];
};

/** How many children a compound (mutable or static) currently has. */
export const subShapeCount = (shape: Jolt.Shape): number =>
    Raw.module.castObject(shape, Raw.module.CompoundShape).GetNumSubShapes();

/**
 * Read a sub shape's placement back out in the same space `addSubShape` takes it.
 *
 * Jolt stores the position relative to the *compound's* centre of mass and shifted by the child's
 * own (`SubShape::SetTransform` does `positionCOM = position - compoundCOM + rotation * childCOM`),
 * so this undoes both to give back the local position the caller passed in.
 */
export const getSubShapeTransform = (
    compound: Jolt.Shape,
    index: number
): { position: Vec3Tuple; rotation: QuatTuple } => {
    const mutable = asMutableCompoundShape(compound);
    const subShape = mutable.GetSubShape(index);
    // every one of these getters returns the same kind of static temporary: read it immediately
    const positionCOM = subShape.GetPositionCOM();
    const local = new Vector3(positionCOM.GetX(), positionCOM.GetY(), positionCOM.GetZ());
    const subRotation = subShape.GetRotation();
    const rotation: QuatTuple = [
        subRotation.GetX(),
        subRotation.GetY(),
        subRotation.GetZ(),
        subRotation.GetW()
    ];
    const childCenter = subShape.mShape.GetCenterOfMass();
    const child = new Vector3(childCenter.GetX(), childCenter.GetY(), childCenter.GetZ());
    const compoundCenter = mutable.GetCenterOfMass();

    local
        .add(new Vector3(compoundCenter.GetX(), compoundCenter.GetY(), compoundCenter.GetZ()))
        .sub(child.applyQuaternion(new THREE.Quaternion(...rotation)));
    return { position: toTuple(local), rotation };
};

/**
 * Add a child to a mutable compound and return its index.
 *
 * The child is built from `descriptor` (its `position`/`rotation` are its placement inside the
 * compound, exactly as in a static compound) and is owned by the compound afterwards.
 */
export function addSubShape(
    compound: Jolt.Shape,
    descriptor: ShapeDescriptor,
    index?: number
): number {
    const jolt = Raw.module;
    const mutable = asMutableCompoundShape(compound);
    // one reference, ours, handed over to the compound below
    const child = generateShape(descriptor);
    const position = vec3.jolt(descriptor.position ?? [0, 0, 0]);
    const rotation = quat.jolt(descriptor.rotation ?? [0, 0, 0, 1]);
    let added: number;
    try {
        // AddShape copies the transform and takes its own reference on the shape
        added =
            index === undefined
                ? mutable.AddShape(position, rotation, child, descriptor.userData ?? 0)
                : mutable.AddShape(position, rotation, child, descriptor.userData ?? 0, index);
    } finally {
        jolt.destroy(position);
        jolt.destroy(rotation);
        // the compound holds the child now (or, if AddShape threw, nothing does and this frees it)
        releaseShape(child);
    }
    mutable.AdjustCenterOfMass();
    return added;
}

/**
 * Drop the child at `index`. The remaining children keep their order, so every index above
 * `index` shifts down by one.
 *
 * The compound releases the child itself: do not `releaseShape`/`destroy` it here.
 */
export function removeSubShape(compound: Jolt.Shape, index: number): void {
    const mutable = asMutableCompoundShape(compound);
    mutable.RemoveShape(index);
    mutable.AdjustCenterOfMass();
}

/** Move and/or turn the child at `index`. Anything left out of `transform` is kept as it is. */
export function modifySubShape(
    compound: Jolt.Shape,
    index: number,
    transform: SubShapeTransform
): void {
    const jolt = Raw.module;
    const mutable = asMutableCompoundShape(compound);
    const current = getSubShapeTransform(mutable, index);
    const position = vec3.jolt(transform.position ?? current.position);
    const rotation = quat.jolt(transform.rotation ?? current.rotation);
    try {
        mutable.ModifyShape(index, position, rotation);
    } finally {
        jolt.destroy(position);
        jolt.destroy(rotation);
    }
    mutable.AdjustCenterOfMass();
}

/* ============================================================================
 * Sub shape identity (issue #13)
 *
 * A contact manifold names the two shapes that touched with a `SubShapeID`: a bit path from the
 * root shape down to the leaf that was actually hit, packed into one 32 bit word from the low
 * end, with every unused high bit set to 1. Jolt's "empty" id - what a shape with no children
 * reports - is therefore `0xFFFFFFFF`, which reads as `-1` out of the `Int32Array` the event
 * queue stores it in.
 *
 * Two things can be recovered from it:
 *
 *  - **user data**: `Shape::GetSubShapeUserData` walks the path and returns the leaf shape's
 *    `mUserData`, which `createShapeSettings` stamps from the descriptor. This works at any
 *    nesting depth and is what `<Shape>`'s scoped event props match on.
 *  - **index**: which child of the *top level* compound the path starts at.
 *    `CompoundShape::GetSubShapeIndexFromID` is not in the JS binding, so `subShapeIndexFromId`
 *    redoes its arithmetic: pop `ceil(log2(numSubShapes))` bits off the low end.
 *
 * Note the consequence of the padding: for a two child compound, child 1's id is `0xFFFFFFFF` -
 * the same word as the empty id. The two are only distinguishable by looking at the shape, which
 * is why the index is resolved against the body's root shape rather than from the id alone.
 * ========================================================================== */

// One shared `SubShapeID`, same contract (and the same module-swap guard) as `joltScratch`:
// `GetSubShapeUserData` copies what it reads, so nothing keeps a pointer to it.
let subShapeIdModule: unknown = null;
let subShapeIdScratch: Jolt.SubShapeID | null = null;
const scratchSubShapeId = (value: number): Jolt.SubShapeID => {
    if (subShapeIdModule !== Raw.module) {
        subShapeIdModule = Raw.module;
        subShapeIdScratch = null;
    }
    if (!subShapeIdScratch) subShapeIdScratch = new Raw.module.SubShapeID();
    subShapeIdScratch.SetValue(value);
    return subShapeIdScratch;
};

/** Jolt's "no sub shape" id, as it comes out of the event queue. */
export const EMPTY_SUB_SHAPE_ID = -1;

/**
 * Strip the decorators (`ScaledShape`, `OffsetCenterOfMassShape`, `RotatedTranslatedShape`) that
 * wrap a shape without contributing bits to a `SubShapeID`, so the compound underneath - if
 * there is one - can be found. The loop is bounded because a cycle is impossible but a very
 * deeply decorated shape is not worth walking forever.
 */
const undecorateShape = (shape: Jolt.Shape): Jolt.Shape => {
    const jolt = Raw.module;
    let current = shape;
    for (let depth = 0; depth < 8; depth++) {
        const subType = current.GetSubType();
        if (
            subType !== jolt.EShapeSubType_Scaled &&
            subType !== jolt.EShapeSubType_OffsetCenterOfMass &&
            subType !== jolt.EShapeSubType_RotatedTranslated
        )
            return current;
        current = jolt.castObject(current, jolt.DecoratedShape).GetInnerShape();
    }
    return current;
};

/** True when `shape` (decorators stripped) is a compound, i.e. when it has sub shapes at all. */
export const hasSubShapes = (shape: Jolt.Shape): boolean => {
    const jolt = Raw.module;
    const subType = undecorateShape(shape).GetSubType();
    return (
        subType === jolt.EShapeSubType_StaticCompound ||
        subType === jolt.EShapeSubType_MutableCompound
    );
};

/**
 * Which child of `shape`'s top level compound a `SubShapeID` points at, or `-1` when the shape
 * has no children (so the whole shape is the contact).
 */
export const subShapeIndexFromId = (shape: Jolt.Shape, subShapeId: number): number => {
    const jolt = Raw.module;
    const root = undecorateShape(shape);
    const subType = root.GetSubType();
    if (
        subType !== jolt.EShapeSubType_StaticCompound &&
        subType !== jolt.EShapeSubType_MutableCompound
    )
        return -1;
    const count = jolt.castObject(root, jolt.CompoundShape).GetNumSubShapes();
    if (count <= 0) return -1;
    // `GetSubShapeIDBits()` is `32 - CountLeadingZeros(size - 1)`: just enough bits to hold the
    // largest index. A one child compound uses none of them, so its only child is index 0.
    const bits = count === 1 ? 0 : 32 - Math.clz32(count - 1);
    const index = bits === 0 ? 0 : subShapeId & ((1 << bits) - 1);
    return index < count ? index : -1;
};

/**
 * The user data of the leaf shape a `SubShapeID` points at - `0` when nothing stamped one.
 * Resolved against the shape at any nesting depth, not just the top level.
 */
export const subShapeUserData = (shape: Jolt.Shape, subShapeId: number): number =>
    shape.GetSubShapeUserData(scratchSubShapeId(subShapeId)) >>> 0;

/**
 * The descriptor a top level sub shape index was built from, when the body kept the description
 * it was built from (`BodyState.shapeDescriptor`). `index === -1` means the shape has no
 * children, so the whole descriptor is the answer.
 */
export const descriptorForSubShape = (
    descriptor: ShapeDescriptor | undefined,
    index: number
): ShapeDescriptor | undefined => {
    if (!descriptor) return undefined;
    let current: ShapeDescriptor = descriptor;
    for (let depth = 0; depth < 8; depth++) {
        if (current.type !== 'scaled' && current.type !== 'offsetCenterOfMass') break;
        current = current.child;
    }
    if (current.type !== 'staticCompound' && current.type !== 'mutableCompound')
        return index < 0 ? current : undefined;
    return index < 0 ? undefined : current.children[index];
};

/* ============================================================================
 * Scaling (issue #40)
 * ========================================================================== */

/**
 * The scale `shape` will actually accept, as close to `scale` as Jolt allows.
 *
 * Jolt only supports non-uniform scale on shapes whose geometry can take it: a sphere, a capsule
 * or a tapered capsule has one radius, so squashing it would produce a shape that no longer
 * matches what is drawn. Rather than let that through silently, this falls back to a uniform
 * scale built from the largest component (sign kept, so a mirrored scale stays mirrored) and
 * `devWarn`s; if even that is refused, Jolt's own `MakeScaleValid` decides.
 *
 * Allocation free: reads through the shared scratch vector, returns plain three.js data.
 */
export const validScaleFor = (shape: Jolt.Shape, scale: anyVec3 | number): THREE.Vector3 => {
    const requested =
        typeof scale === 'number' ? new Vector3(scale, scale, scale) : vec3.three(scale);
    if (shape.IsValidScale(joltScratch.vec3(requested))) return requested;

    // the component furthest from zero, with its sign: a mirrored scale stays mirrored
    const largest = [requested.x, requested.y, requested.z].reduce((a, b) =>
        Math.abs(b) > Math.abs(a) ? b : a
    );
    const uniform = new Vector3(largest, largest, largest);
    devWarn(
        `react-three-jolt: this shape cannot be scaled non-uniformly by (${requested.x}, ` +
            `${requested.y}, ${requested.z}) - a sphere, capsule or tapered capsule has a single ` +
            `radius. Falling back to a uniform scale of ${largest}.`
    );
    if (shape.IsValidScale(joltScratch.vec3(uniform))) return uniform;

    // last resort: let jolt pick the nearest legal scale (a static temporary - read, never free)
    const made = shape.MakeScaleValid(joltScratch.vec3(requested));
    return new Vector3(made.GetX(), made.GetY(), made.GetZ());
};

/**
 * Wrap an existing shape in a `ScaledShape` (issue #40's building block).
 *
 * Ownership: `ScaledShape` holds a `RefConst<Shape>` on `shape`, so it AddRef()s it - the caller
 * keeps its own reference and releases it independently. The returned shape is owned by the
 * caller with a reference count of 1, exactly like `generateShape`, and is freed with
 * `releaseShape` (never `destroy`: it is ref-counted and deletes itself at zero).
 */
export function scaleShape(shape: Jolt.Shape, scale: anyVec3): Jolt.Shape {
    const jolt = Raw.module;
    const joltScale = vec3.jolt(scale);
    if (!shape.IsValidScale(joltScale))
        devWarn(
            'react-three-jolt: this scale is not valid for this shape (a sphere or capsule cannot ' +
                'be scaled non-uniformly, a mesh cannot be mirrored); jolt will do what it can.'
        );
    // `new` starts a RefTarget at zero references; AddRef makes this one ours
    const scaled = jolt.castObject(new jolt.ScaledShape(shape, joltScale), jolt.ScaledShape);
    scaled.AddRef();
    jolt.destroy(joltScale);
    return scaled;
}

/* ============================================================================
 * Compatibility wrappers
 *
 * The three historical entry points describe + build through the pipeline above. They keep their
 * old signatures and return types so body-system, <Shape>, the character controller, the
 * vehicles and the examples keep working unchanged.
 * ========================================================================== */

/** @deprecated prefer `describeShape` + `generateShape`. */
export const getShapeSettingsFromGeometry = (
    geometry: PossibleGeometry,
    shapeType?: AutoShape
):
    | {
          shapeSettings: Jolt.ShapeSettings | undefined;
          offset: Vector3 | undefined;
      }
    | undefined => {
    const descriptor = describeGeometry(geometry, { type: shapeType });
    return {
        shapeSettings: createShapeSettings(descriptor),
        offset: descriptor.offset ? new Vector3(...descriptor.offset) : undefined
    };
};

/** @deprecated prefer `describeShape` + `generateShape`. */
export const getShapeSettingsFromObject = (
    object: Object3D,
    // why do I need this here?
    shapeType?: AutoShape
): Jolt.ShapeSettings => createShapeSettings(describeObject(object, { type: shapeType }));

/** @deprecated prefer `describeShapeFromOptions` + `generateShape`. */
export const generateShapeSettings = (
    shapeType: AutoShape | ShapeType = 'box',
    options: ShapeOptions = {},
    // kept for signature compatibility: the settings have always been rebuilt from scratch
    _inSettings?: Jolt.ShapeSettings
): Jolt.ShapeSettings => createShapeSettings(describeShapeFromOptions(shapeType, options));

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
 *
 * Prefer the descriptor pipeline (`{ type: 'staticCompound', children: [...] }`); this exists
 * for callers that already hold `ShapeSettings`.
 */
export const generateCompoundShapeSettings = (shapes: CompoundShapeData[], dynamic = false) => {
    const jolt = Raw.module;
    const compoundShapeSettings = dynamic
        ? new jolt.MutableCompoundShapeSettings()
        : new jolt.StaticCompoundShapeSettings();
    // one scratch position/rotation for the whole loop: AddShape copies both
    const position = new jolt.Vec3(0, 0, 0);
    const rotation = new jolt.Quat(0, 0, 0, 1);
    shapes.forEach(({ shapeSettings, position: inPosition, quaternion: inQuaternion }) => {
        const { x, y, z } = vec3.three(inPosition);
        position.Set(x, y, z);
        rotation.Set(inQuaternion.x, inQuaternion.y, inQuaternion.z, inQuaternion.w);
        compoundShapeSettings.AddShape(position, rotation, shapeSettings, 0);
    });
    jolt.destroy(position);
    jolt.destroy(rotation);
    return compoundShapeSettings;
};

// take a threejs plane that is a heightfield and generate a Jolt heightfield shape
// this is a WIP
/** @deprecated prefer `describeShape(mesh, { type: 'heightfield' })` + `generateShape`. */
export const generateHeightfieldShapeFromThree = (
    heightfieldPlane: THREE.Mesh
): Jolt.HeightFieldShapeSettings =>
    createHeightfieldShapeSettings(describeHeightfieldMesh(heightfieldPlane));

// Take a complex Jolt shape and generate a ThreeJS geometry.
// Taken from the Jolt JS examples. This used to exist twice, byte for byte, as
// `createMeshForShape` here and `createMeshFromShape` in utils/mesh-tools.ts; both names still
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
