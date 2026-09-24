// Soft bodies (issue #243): SoftBodySystem builds a Jolt soft body from a three.js BufferGeometry
// (cloth, jelly, an inflated shape) and keeps the mesh's geometry in sync with the simulation
// every step - the soft-body equivalent of BodySystem + BodyState for rigid bodies.
//
// Jolt's soft body is a position-based-dynamics particle system: every vertex of the geometry
// becomes a `SoftBodySharedSettingsVertex`, triangles become `SoftBodySharedSettingsFace`s, and
// the edges of those triangles become `SoftBodySharedSettingsEdge` distance constraints. There is
// no separate "shape" the way a rigid body has one - the geometry *is* the shape.
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layer } from '../constants';
import { castObject, Raw } from '../raw';
import { devWarn, quat, vec3 } from '../utils';

/**
 * How `CreateConstraints` builds the extra constraints on top of the structural (triangle-edge)
 * ones this system adds itself:
 * - `'none'`: structural edges only.
 * - `'distance'` (default): adds shear edges (roughly, the face diagonals) so the surface resists
 *   shearing, not just stretching.
 * - `'dihedral'`: adds bend constraints between adjacent triangles, which resist folding - more
 *   expensive, and only worth it for something that should hold a curved rest shape (better cloth
 *   behavior than the distance-based bend `CreateConstraints` derives from edges alone).
 */
export type SoftBodyBendType = 'none' | 'distance' | 'dihedral';

/** Called once per (post-merge) vertex with its local rest position; return `true` to pin it. */
export type SoftBodyPinPredicate = (position: THREE.Vector3, index: number) => boolean;

/** Which vertices are pinned (infinite mass, `mInvMass = 0`): by index, or by a predicate. */
export type SoftBodyFixed = number[] | SoftBodyPinPredicate;

export interface SoftBodyOptions {
    /** World position the body is created at. Default `[0, 0, 0]`. */
    position?: THREE.Vector3 | [number, number, number];
    /** World rotation the body is created at. Default identity. */
    rotation?: THREE.Quaternion | [number, number, number, number];
    /** Jolt object layer. Default `Layer.MOVING`. */
    layer?: number;

    /**
     * Inflation pressure. `0` (the default) means none - the mesh behaves as an unpressurized
     * membrane. A closed mesh with a positive pressure resists collapsing (a balloon, a ball);
     * volume constraints (tetrahedra) are not built for v1, pressure is the only volume-preserving
     * force available.
     */
    pressure?: number;
    /** Compliance (inverse stiffness) of the structural edges and of `CreateConstraints`' own
     * shear edges. `0` is fully rigid (Jolt's default). Higher is stretchier. */
    compliance?: number;
    /** Shear compliance passed to `CreateConstraints`. Defaults to {@link compliance}. */
    shearCompliance?: number;
    /** Bend compliance passed to `CreateConstraints`. Default `0`. Only meaningful with
     * `bendType: 'dihedral'`. */
    bendCompliance?: number;
    /** See {@link SoftBodyBendType}. Default `'distance'`. */
    bendType?: SoftBodyBendType;

    /** PBD solver iterations per substep. Jolt's default is `2`; more is stiffer and costlier. */
    numIterations?: number;
    /** Multiplier on world gravity. Default `1`. */
    gravityFactor?: number;
    /** Velocity lost per second to drag. Jolt's default is `0.1` for soft bodies. */
    linearDamping?: number;
    /** Friction against other bodies. Jolt's default is `0.2`. */
    friction?: number;
    /** Bounciness against other bodies, `0`-`1`. Jolt's default is `0`. */
    restitution?: number;
    /** Collision radius around every vertex (so vertices don't need to fully overlap another
     * shape to collide with it). Jolt's default is `0.05`. */
    vertexRadius?: number;
    /**
     * Whether the body's origin re-centers on the simulated vertices every step (Jolt's default,
     * `true`). Needed for numerical precision on a body that travels far from where it was
     * created; with vertices then read as local to a moving origin - see {@link SoftBodyState}.
     */
    updatePosition?: boolean;

    /**
     * Total mass in kilograms, spread evenly across the **unpinned** vertices. Left out, every
     * unpinned vertex gets `mInvMass = 1` (Jolt's own default, i.e. 1kg each).
     */
    mass?: number;
    /** Vertices to pin (`mInvMass = 0`) - indices into the geometry *after* `mergeVertices`, or a
     * predicate over each vertex's local rest position. */
    fixed?: SoftBodyFixed;
}

const isFixed = (index: number, position: THREE.Vector3, fixed: SoftBodyFixed | undefined) => {
    if (!fixed) return false;
    if (typeof fixed === 'function') return fixed(position, index);
    return fixed.includes(index);
};

const BEND_TYPES: Record<
    SoftBodyBendType,
    (jolt: typeof Jolt) => Jolt.SoftBodySharedSettings_EBendType
> = {
    none: (jolt) => jolt.SoftBodySharedSettings_EBendType_None,
    distance: (jolt) => jolt.SoftBodySharedSettings_EBendType_Distance,
    dihedral: (jolt) => jolt.SoftBodySharedSettings_EBendType_Dihedral
};

/**
 * Deduplicate a mesh's triangle edges into a `Set`, keyed by a single number - safe for any
 * geometry with fewer than 2^26 vertices (the pair is packed `lo * vertexCount + hi`, so the key
 * space is `vertexCount^2`, well inside a JS number's 53 safe bits for anything this library will
 * ever see).
 */
const packEdgeKey = (a: number, b: number, vertexCount: number): number =>
    a < b ? a * vertexCount + b : b * vertexCount + a;

/**
 * `geometry` must be indexed and have no duplicate positions (shared vertices need to be *one*
 * Jolt vertex, or the edges/faces around a seam do not actually connect) - pass it through
 * `mergeVertices` first. {@link SoftBodySystem.addBody} does this for you.
 *
 * Builds vertices, faces and structural (triangle-edge) constraints from the geometry, then calls
 * `CreateConstraints` for the shear/bend constraints and `Optimize()`. The returned settings is
 * `AddRef()`'d once for the caller - matching `BodySystem`'s `GroupFilterTable` pattern - and must
 * be `Release()`'d exactly once when done (see {@link SoftBodyState.destroy}). Passing it straight
 * to `Release()` without that `AddRef()` is a use-after-free: `SoftBodyCreationSettings` and the
 * body Jolt creates from it each take their own reference, so by the time both are destroyed the
 * refcount has already reached zero on its own.
 */
export function buildSoftBodySharedSettings(
    geometry: THREE.BufferGeometry,
    options: SoftBodyOptions = {}
): { settings: Jolt.SoftBodySharedSettings; vertexCount: number } {
    const jolt = Raw.module;
    const posAttr = geometry.attributes.position as THREE.BufferAttribute | undefined;
    const index = geometry.index;
    if (!posAttr || !index)
        throw new Error(
            'r3/jolt: SoftBody geometry must be indexed with a position attribute - ' +
                'run it through mergeVertices first (SoftBodySystem.addBody does this for you).'
        );

    const vertexCount = posAttr.count;
    const settings = new jolt.SoftBodySharedSettings();
    // Ours: see this function's doc comment. Released in `SoftBodyState.destroy()`.
    settings.AddRef();

    //* Vertices -------------------------------------------
    let freeCount = 0;
    const pinned = new Uint8Array(vertexCount);
    const restPosition = new THREE.Vector3();
    for (let i = 0; i < vertexCount; i++) {
        restPosition.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        if (isFixed(i, restPosition, options.fixed)) pinned[i] = 1;
        else freeCount++;
    }
    const invMassPerVertex =
        options.mass !== undefined && options.mass > 0 && freeCount > 0
            ? freeCount / options.mass
            : 1;

    const scratchVertex = new jolt.SoftBodySharedSettingsVertex();
    const scratchFloat3 = new jolt.Float3(0, 0, 0);
    settings.mVertices.reserve(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        scratchFloat3.x = posAttr.getX(i);
        scratchFloat3.y = posAttr.getY(i);
        scratchFloat3.z = posAttr.getZ(i);
        // push_back copies the struct, so the same scratch vertex/Float3 serves every iteration
        // (same idiom as shape-system.ts's createMeshShapeSettings)
        scratchVertex.mPosition = scratchFloat3;
        scratchVertex.mInvMass = pinned[i] ? 0 : invMassPerVertex;
        settings.mVertices.push_back(scratchVertex);
    }
    jolt.destroy(scratchFloat3);
    jolt.destroy(scratchVertex);

    //* Faces, straight from the index ----------------------
    const triangleCount = Math.floor(index.count / 3);
    const scratchFace = new jolt.SoftBodySharedSettingsFace(0, 0, 0, 0);
    settings.mFaces.reserve(triangleCount);
    for (let i = 0; i < index.count; i += 3) {
        scratchFace.set_mVertex(0, index.getX(i));
        scratchFace.set_mVertex(1, index.getX(i + 1));
        scratchFace.set_mVertex(2, index.getX(i + 2));
        settings.AddFace(scratchFace);
    }
    jolt.destroy(scratchFace);

    //* Structural edges, deduplicated from the triangle edges ------------
    const compliance = options.compliance ?? 0;
    const edgeKeys = new Set<number>();
    const scratchEdge = new jolt.SoftBodySharedSettingsEdge(0, 0, 0);
    const addEdge = (a: number, b: number) => {
        const key = packEdgeKey(a, b, vertexCount);
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        scratchEdge.set_mVertex(0, a);
        scratchEdge.set_mVertex(1, b);
        scratchEdge.mCompliance = compliance;
        settings.mEdgeConstraints.push_back(scratchEdge);
    };
    for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
    }
    jolt.destroy(scratchEdge);

    //* Shear/bend constraints, plus rest lengths for every edge above -----
    // `CreateConstraints` computes `mRestLength` from the vertices' current positions for every
    // edge already in `mEdgeConstraints` (the structural ones just added included), so a separate
    // `CalculateEdgeLengths()` call is redundant - verified empirically, both give identical sim
    // results.
    const vertexAttributesArray = new jolt.ArraySoftBodySharedSettingsVertexAttributes();
    const attrs = new jolt.SoftBodySharedSettingsVertexAttributes();
    attrs.mCompliance = compliance;
    attrs.mShearCompliance = options.shearCompliance ?? compliance;
    attrs.mBendCompliance = options.bendCompliance ?? 0;
    vertexAttributesArray.push_back(attrs);
    jolt.destroy(attrs);

    const bendType = BEND_TYPES[options.bendType ?? 'distance'](jolt);
    // `.data()` hands CreateConstraints a pointer to the array's storage; length 1 broadcasts
    // this one entry to every vertex.
    settings.CreateConstraints(vertexAttributesArray.data(), 1, bendType);
    jolt.destroy(vertexAttributesArray);

    if ((options.bendType ?? 'distance') === 'dihedral')
        settings.CalculateBendConstraintConstants();

    settings.Optimize();

    return { settings, vertexCount };
}

/**
 * `geometry` run through `mergeVertices` so shared positions become one Jolt vertex - required
 * before {@link buildSoftBodySharedSettings}, since an un-merged geometry (every three.js
 * primitive that isn't already indexed, or one duplicated for flat shading) would otherwise give
 * a seam's vertices separate, unconnected Jolt vertices.
 *
 * Returns a **new** geometry; the caller (`SoftBodySystem.addBody`) swaps it onto the mesh so the
 * rendered vertex order matches the simulated one exactly - `SoftBodyState.syncGeometry` writes
 * simulated positions back into this same buffer by index.
 */
export function prepareSoftBodyGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    const merged = mergeVertices(geometry);
    if (!merged.index)
        // mergeVertices always indexes its result; this would only happen against a future three
        // version that changed that contract.
        devWarn(
            'r3/jolt: SoftBody - mergeVertices returned a non-indexed geometry; this is ' +
                'unexpected and the soft body will fail to build.'
        );
    return merged;
}

/** One live soft body: the Jolt body, the mesh whose geometry it drives, and its shared settings. */
export class SoftBodyState {
    readonly object: THREE.Mesh;
    readonly body: Jolt.Body;
    readonly handle: number;
    readonly vertexCount: number;
    /** Owns one reference, released in {@link destroy}. See {@link buildSoftBodySharedSettings}. */
    private sharedSettings: Jolt.SoftBodySharedSettings | undefined;
    private readonly bodyInterface: Jolt.BodyInterface;
    disposed = false;

    constructor(
        object: THREE.Mesh,
        body: Jolt.Body,
        sharedSettings: Jolt.SoftBodySharedSettings,
        bodyInterface: Jolt.BodyInterface,
        vertexCount: number
    ) {
        this.object = object;
        this.body = body;
        this.sharedSettings = sharedSettings;
        this.bodyInterface = bodyInterface;
        this.vertexCount = vertexCount;
        this.handle = body.GetID().GetIndexAndSequenceNumber();
    }

    /**
     * Read every simulated vertex back into the geometry's position attribute, recompute normals
     * and the bounding sphere, and sync the mesh's transform to the body's pose.
     *
     * `SoftBodyMotionProperties.GetVertex(i).mPosition` is safe to read every frame for every
     * vertex with no allocation and nothing to destroy - verified against jolt-physics 1.1.0 with
     * `JoltInterface.sGetFreeMemory()` unchanged across 500 frames of reads. Vertices are in the
     * body's **local** space (relative to an origin Jolt re-centers on the simulated shape when
     * `updatePosition` is true, the default) - the object's position/rotation are synced from the
     * body's pose exactly like `BodyState.readPose`, so world space comes from the two combined,
     * the same way a `<RigidBody>`'s object and its collision shape do.
     */
    syncGeometry(): void {
        if (this.disposed) return;
        const jolt = Raw.module;
        const geometry = this.object.geometry;
        const posAttr = geometry.attributes.position as THREE.BufferAttribute;
        const motionProperties = castObject(
            this.body.GetMotionProperties(),
            jolt.SoftBodyMotionProperties
        );
        for (let i = 0; i < this.vertexCount; i++) {
            const position = motionProperties.GetVertex(i).mPosition;
            posAttr.setXYZ(i, position.GetX(), position.GetY(), position.GetZ());
        }
        posAttr.needsUpdate = true;
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();

        // `GetPosition`/`GetRotation` return static by-value temporaries - read, never destroy.
        vec3.joltToThree(this.body.GetPosition(), this.object.position);
        quat.joltToThree(this.body.GetRotation(), this.object.quaternion);
    }

    /**
     * Remove and destroy the Jolt body, and release this state's reference on the shared
     * settings. Idempotent - safe to call more than once (React StrictMode, an explicit call plus
     * unmount).
     */
    destroy(): void {
        if (this.disposed) return;
        this.disposed = true;
        const bodyID = this.body.GetID();
        if (this.bodyInterface.IsAdded(bodyID)) this.bodyInterface.RemoveBody(bodyID);
        this.bodyInterface.DestroyBody(bodyID);
        this.sharedSettings?.Release();
        this.sharedSettings = undefined;
    }
}

/** Holds and steps every soft body in a world - the soft-body counterpart of `BodySystem`. */
export class SoftBodySystem {
    readonly bodies = new Map<number, SoftBodyState>();
    private readonly bodyInterface: Jolt.BodyInterface;

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem) {
        this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
    }

    /**
     * Build a soft body from `mesh.geometry` and add it to the simulation.
     *
     * The geometry is replaced on `mesh` with a merged (indexed, deduplicated) copy first - see
     * {@link prepareSoftBodyGeometry} - so the rendered vertex order matches the simulated one
     * exactly. The original geometry passed in is left untouched (and, if nothing else
     * references it, is the caller's to dispose).
     */
    addBody(mesh: THREE.Mesh, options: SoftBodyOptions = {}): number {
        const jolt = Raw.module;
        const geometry = prepareSoftBodyGeometry(mesh.geometry);
        mesh.geometry = geometry;

        const { settings, vertexCount } = buildSoftBodySharedSettings(geometry, options);

        const position = vec3.rjolt(options.position ?? mesh.position);
        const rotation = quat.jolt(options.rotation ?? mesh.quaternion);
        const creationSettings = new jolt.SoftBodyCreationSettings(
            settings,
            position,
            rotation,
            options.layer ?? Layer.MOVING
        );
        jolt.destroy(position);
        jolt.destroy(rotation);

        if (options.pressure !== undefined) creationSettings.mPressure = options.pressure;
        if (options.numIterations !== undefined)
            creationSettings.mNumIterations = options.numIterations;
        if (options.gravityFactor !== undefined)
            creationSettings.mGravityFactor = options.gravityFactor;
        if (options.linearDamping !== undefined)
            creationSettings.mLinearDamping = options.linearDamping;
        if (options.friction !== undefined) creationSettings.mFriction = options.friction;
        if (options.restitution !== undefined) creationSettings.mRestitution = options.restitution;
        if (options.vertexRadius !== undefined)
            creationSettings.mVertexRadius = options.vertexRadius;
        if (options.updatePosition !== undefined)
            creationSettings.mUpdatePosition = options.updatePosition;

        const body = this.bodyInterface.CreateSoftBody(creationSettings);
        // The settings object copied the position/rotation and took its own reference on the
        // shared settings; this is a plain (non-ref-counted) struct, ours to free now.
        jolt.destroy(creationSettings);

        this.bodyInterface.AddBody(body.GetID(), jolt.EActivation_Activate);

        const state = new SoftBodyState(mesh, body, settings, this.bodyInterface, vertexCount);
        this.bodies.set(state.handle, state);
        // Match the mesh's rendered geometry to the simulation's rest pose immediately, so the
        // first rendered frame (before the next physics step) isn't the pre-merge geometry.
        state.syncGeometry();
        return state.handle;
    }

    getBody(handle: number): SoftBodyState | undefined {
        return this.bodies.get(handle);
    }

    removeBody(handle: number): void {
        const state = this.bodies.get(handle);
        if (!state) return;
        state.destroy();
        this.bodies.delete(handle);
    }

    removeAllBodies(): number {
        let removed = 0;
        for (const handle of [...this.bodies.keys()]) {
            if (!this.bodies.has(handle)) continue;
            this.removeBody(handle);
            removed++;
        }
        return removed;
    }

    /** Called once per rendered frame (not per substep) by `PhysicsSystem.onUpdate`. */
    syncAll(): void {
        this.bodies.forEach(syncOne);
    }

    /** Remove and destroy every soft body. Idempotent. */
    destroy(): void {
        this.removeAllBodies();
    }
}

// Hoisted so `syncAll`'s `forEach` does not allocate a fresh closure every frame.
const syncOne = (state: SoftBodyState): void => state.syncGeometry();
