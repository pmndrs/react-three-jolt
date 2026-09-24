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
import type { BodySystem } from './body-system';
import {
    ContactEventQueue,
    EventKind,
    FLUSH_ORDER,
    KIND_EVENT,
    PayloadPool,
    type PooledBasic,
    type PooledEnter,
    SoftBodyContactAccumulator,
    type SoftPeerAccum
} from './contact-events';
import { Emitter, type Unsubscribe } from './emitter';
import {
    type CollisionTarget,
    EventBit,
    SOFT_BODY_EVENT_BITS,
    type SoftBodyEventMap,
    type SoftBodyValidatePayload,
    type WorldEventMap
} from './events';

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

// Scratch for the contact listener (issue #245): the soft body's own COM pose, read once per
// `OnSoftBodyContactAdded` call, and one point reused per vertex to bring `GetLocalContactPoint`/
// `GetContactNormal` (both in the soft body's local frame) into world space before they are
// written into the event queue. Module level so nothing is allocated per contact.
const _softPose = new THREE.Vector3();
const _softRotation = new THREE.Quaternion();
const _softPoint = new THREE.Vector3();
const _softNormal = new THREE.Vector3();

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

    /**
     * This soft body's events (issue #245). Same primitive and naming as `BodyState.events` - see
     * `SoftBodyEventMap` for the payload shapes and `SoftBodySystem`'s `SoftBodyContactListenerJS`
     * wiring for how they get filled in.
     */
    readonly events = new Emitter<SoftBodyEventMap>(SOFT_BODY_EVENT_BITS);
    private static readonly NOOP_UNSUBSCRIBE: Unsubscribe = () => {};

    /** What this body is listening for, as a bitfield - read inside the Jolt callback to decide
     * whether a step's vertex contacts are worth walking at all. */
    get eventMask(): number {
        return this.events.mask;
    }

    /** Subscribe to one of this body's events. Returns the unsubscribe. */
    on<K extends keyof SoftBodyEventMap>(type: K, fn: SoftBodyEventMap[K]): Unsubscribe {
        if (this.disposed) return SoftBodyState.NOOP_UNSUBSCRIBE;
        return this.events.on(type, fn);
    }
    /** Fires once when this soft body starts touching another body. */
    onCollisionEnter(fn: SoftBodyEventMap['collisionEnter']): Unsubscribe {
        return this.on('collisionEnter', fn);
    }
    /** Fires every step the contact is maintained. */
    onCollisionPersist(fn: SoftBodyEventMap['collisionPersist']): Unsubscribe {
        return this.on('collisionPersist', fn);
    }
    /** Fires once when this soft body stops touching another body. */
    onCollisionExit(fn: SoftBodyEventMap['collisionExit']): Unsubscribe {
        return this.on('collisionExit', fn);
    }
    onSensorEnter(fn: SoftBodyEventMap['sensorEnter']): Unsubscribe {
        return this.on('sensorEnter', fn);
    }
    onSensorExit(fn: SoftBodyEventMap['sensorExit']): Unsubscribe {
        return this.on('sensorExit', fn);
    }
    /** Synchronous, inside the step. Return `false` to reject the contact. See docs/events.md. */
    onContactValidate(fn: SoftBodyEventMap['contactValidate']): Unsubscribe {
        return this.on('contactValidate', fn);
    }

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
        this.events.clear();
    }
}

/** Holds and steps every soft body in a world - the soft-body counterpart of `BodySystem`. */
export class SoftBodySystem {
    readonly bodies = new Map<number, SoftBodyState>();
    private readonly bodyInterface: Jolt.BodyInterface;
    private readonly joltPhysicsSystem: Jolt.PhysicsSystem;

    //* Events (issue #245) ======================================
    /** The Jolt listener object, kept so it can be freed. See {@link destroy}. */
    contactListener?: Jolt.SoftBodyContactListenerJS;
    /** Records written inside `Step()`, dispatched by {@link flushEvents} after it. Reuses the
     * same buffer/pool primitives `BodySystem`'s rigid contact listener does. */
    readonly eventQueue = new ContactEventQueue();
    /** Reused event payloads - a pool of its own, independent of `BodySystem`'s. */
    readonly payloads = new PayloadPool();
    /** Derives enter/persist/exit for each (soft body, peer) pair from the per-vertex manifold -
     * see {@link SoftBodyContactAccumulator}. */
    private readonly accumulator = new SoftBodyContactAccumulator();
    /** The world level emitter, wired up by `PhysicsSystem` - the same instance `BodySystem` uses,
     * so a `<Physics onCollisionEnter>` sees soft body contacts too. */
    worldEvents?: Emitter<WorldEventMap>;
    /** Resolves a rigid `other` side of a soft body contact. Wired up by `PhysicsSystem`. */
    bodySystem?: BodySystem;
    /** Mirrors `PhysicsSystem.debug`: turns on payload poisoning after dispatch. */
    debug = false;
    /** Single reused payload for the synchronous, inside-the-step validate callback. */
    private readonly validatePayload: SoftBodyValidatePayload = {
        target: { body: undefined, object: undefined, handle: 0, subShapeId: -1, softBody: undefined },
        other: { body: undefined, object: undefined, handle: 0, subShapeId: -1 }
    };

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
        this.initializeContactListener();
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
        // Close open peer contacts BEFORE the body leaves the simulation and its handle is
        // freed for reuse - Jolt gives us no "removed" callback for soft body contacts, so this
        // is the only place a peer (and any world level listener) learns the contact ended.
        this.closeContactsFor(handle, state);
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

    /**
     * Free everything this system allocated on the Jolt heap that isn't a body, and drop all
     * event state. Idempotent.
     *
     * Call order matters, same as `BodySystem.destroy()`: the `SoftBodyContactListenerJS` must
     * outlive the `JoltInterface` it was registered on, so `PhysicsSystem.destroy()` calls
     * {@link removeAllBodies} first (while the interface is still live), then {@link clearEvents},
     * and only frees the listener here, after the interface itself is gone. Safe to call with
     * bodies still registered too (removes them itself) - idempotent either way.
     *
     * @param freeListeners false when this world was sharing somebody else's JoltInterface.
     */
    destroy(freeListeners = true): void {
        this.eventQueue.clear();
        this.removeAllBodies();
        if (!freeListeners) return;
        if (this.contactListener) {
            Raw.module.destroy(this.contactListener);
            this.contactListener = undefined;
        }
    }

    /** Drop queued events without dispatching them (the world is going away). */
    clearEvents(): void {
        this.eventQueue.clear();
    }

    // Contact Listener ===================================
    private initializeContactListener(): void {
        // Emscripten's JSImplementation glue does a `hasOwnProperty` check per call site, so
        // these have to be own properties of the instance (same requirement as BodySystem's
        // ContactListenerJS).
        const listener = new Raw.module.SoftBodyContactListenerJS();
        listener.OnSoftBodyContactValidate = (
            softBodyPtr: number,
            otherBodyPtr: number,
            _settingsPtr: number
        ) => this.onSoftBodyContactValidate(softBodyPtr, otherBodyPtr);
        listener.OnSoftBodyContactAdded = (softBodyPtr: number, manifoldPtr: number) =>
            this.onSoftBodyContactAdded(softBodyPtr, manifoldPtr);
        this.contactListener = listener;
        this.joltPhysicsSystem.SetSoftBodyContactListener(listener);
    }

    /** Ors together everything anyone is listening for. Drives the zero-cost path. */
    private get worldEventMask(): number {
        return this.worldEvents?.mask ?? 0;
    }

    /**
     * Called once per (soft body, other body) whose bounding boxes overlap - *before* any vertex
     * contact is confirmed. Accepting doesn't mean anything actually touches this step; rejecting
     * skips this pair for the step entirely.
     */
    private onSoftBodyContactValidate(softBodyPtr: number, otherBodyPtr: number): number {
        const jolt = Raw.module;
        const accept = jolt.SoftBodyValidateResult_AcceptContact;
        const softBody = jolt.wrapPointer(softBodyPtr, jolt.Body);
        const softHandle = softBody.GetID().GetIndexAndSequenceNumber();
        const state = this.bodies.get(softHandle);
        // Unlike rigid `contactValidate`, this one is not wired to `worldEvents`: the payload
        // shape (`SoftBodyValidatePayload`) is deliberately not the same type as rigid's
        // `ValidatePayload` (no `baseOffset`), so it does not share the world emitter's bit.
        if (!state || !state.events.has('contactValidate')) return accept;

        const otherBody = jolt.wrapPointer(otherBodyPtr, jolt.Body);
        const otherHandle = otherBody.GetID().GetIndexAndSequenceNumber();

        const payload = this.validatePayload;
        fillSoftTarget(payload.target, softHandle, state);
        fillOtherTarget(payload.other, otherHandle, this.bodySystem, this);

        const accepted = state.events.emitVeto('contactValidate', payload);
        return accepted ? accept : jolt.SoftBodyValidateResult_RejectContact;
    }

    /**
     * Called once per soft body per step (not once per pair - see `SoftBodyContactAccumulator`'s
     * doc comment), with a manifold covering every vertex's contact against every other body it
     * touched this step.
     */
    private onSoftBodyContactAdded(softBodyPtr: number, manifoldPtr: number): void {
        const jolt = Raw.module;
        const softBody = jolt.wrapPointer(softBodyPtr, jolt.Body);
        const softHandle = softBody.GetID().GetIndexAndSequenceNumber();
        const state = this.bodies.get(softHandle);
        if (!state) return;

        const contactBits = EventBit.collisionEnter | EventBit.collisionPersist | EventBit.collisionExit;
        const sensorBits = EventBit.sensorEnter | EventBit.sensorExit;
        const mask = state.eventMask | this.worldEventMask;
        if ((mask & (contactBits | sensorBits)) === 0) return;

        const manifold = jolt.wrapPointer(manifoldPtr, jolt.SoftBodyManifold);
        this.accumulator.begin();

        if (mask & contactBits) {
            // The soft body's own pose, read once: `GetLocalContactPoint`/`GetContactNormal` are
            // both expressed in the soft body's local (COM-relative) frame - see docs/events.md
            // and this file's report for how that was verified against Jolt's source.
            vec3.joltToThree(softBody.GetPosition(), _softPose);
            quat.joltToThree(softBody.GetRotation(), _softRotation);

            const vertices = manifold.GetVertices();
            const vertexCount = vertices.size();
            const wantPoints = this.eventQueue.pointCapacity > 0;
            for (let i = 0; i < vertexCount; i++) {
                const vertex = vertices.at(i);
                if (!manifold.HasContact(vertex)) continue;
                const peerHandle = manifold.GetContactBodyID(vertex).GetIndexAndSequenceNumber();

                // `GetContactNormal` returns one static temporary: read it now, then rotate it
                // (direction only, no translation) into world space. Verified empirically
                // (real-WASM test) that Jolt's soft body normal points from the *soft body*
                // toward the other surface - opposite of rigid's `ValidatePayload`/
                // `CollisionEnterPayload.normal` convention ("from `other` toward `target`") -
                // so it is negated here to match that convention. See this issue's report.
                const rawNormal = manifold.GetContactNormal(vertex);
                _softNormal.set(-rawNormal.GetX(), -rawNormal.GetY(), -rawNormal.GetZ());
                _softNormal.applyQuaternion(_softRotation);

                if (wantPoints) {
                    // Another static temporary, read immediately - never held alongside the
                    // normal's.
                    const rawPoint = manifold.GetLocalContactPoint(vertex);
                    _softPoint.set(rawPoint.GetX(), rawPoint.GetY(), rawPoint.GetZ());
                    _softPoint.applyQuaternion(_softRotation).add(_softPose);
                    this.accumulator.touch(
                        peerHandle,
                        false,
                        _softNormal.x,
                        _softNormal.y,
                        _softNormal.z,
                        _softPoint.x,
                        _softPoint.y,
                        _softPoint.z
                    );
                } else {
                    this.accumulator.touch(peerHandle, false, _softNormal.x, _softNormal.y, _softNormal.z);
                }
            }
        }

        if (mask & sensorBits) {
            const numSensors = manifold.GetNumSensorContacts();
            for (let i = 0; i < numSensors; i++) {
                const peerHandle = manifold.GetSensorContactBodyID(i).GetIndexAndSequenceNumber();
                this.accumulator.touch(peerHandle, true);
            }
        }

        this.accumulator.end(softHandle, (peer, accum, isNew, sensor) => {
            this.queueSoftPeer(mask, softHandle, peer, accum, isNew, sensor);
        });
    }

    /** Push one (soft body, peer) record from the accumulator's diff into {@link eventQueue}. */
    private queueSoftPeer(
        mask: number,
        softHandle: number,
        peerHandle: number,
        accum: SoftPeerAccum | undefined,
        isNew: boolean,
        sensor: boolean
    ): void {
        if (accum) {
            let kind: number;
            let bit: number;
            if (sensor) {
                if (!isNew) return; // sensors have no persist channel, same as rigid
                kind = EventKind.sensorEnter;
                bit = EventBit.sensorEnter;
            } else if (isNew) {
                kind = EventKind.collisionEnter;
                bit = EventBit.collisionEnter;
            } else {
                kind = EventKind.collisionPersist;
                bit = EventBit.collisionPersist;
            }
            if ((mask & bit) === 0) return;
            const index = this.eventQueue.push(
                kind,
                softHandle,
                peerHandle,
                -1,
                -1,
                accum.count,
                accum.normalX,
                accum.normalY,
                accum.normalZ,
                // Jolt's soft body manifold does not expose a per-vertex penetration depth the
                // way `ContactManifold` does; see this issue's report.
                0,
                accum.pointCount
            );
            for (let i = 0; i < accum.pointCount; i++) {
                const o = i * 3;
                this.eventQueue.setPoint(
                    index,
                    i,
                    accum.points[o],
                    accum.points[o + 1],
                    accum.points[o + 2]
                );
            }
        } else {
            const bit = sensor ? EventBit.sensorExit : EventBit.collisionExit;
            if ((mask & bit) === 0) return;
            this.eventQueue.push(
                sensor ? EventKind.sensorExit : EventKind.collisionExit,
                softHandle,
                peerHandle,
                -1,
                -1,
                0
            );
        }
    }

    /** See `removeBody`'s doc comment. */
    private closeContactsFor(handle: number, state: SoftBodyState): void {
        const previous = this.accumulator.forget(handle);
        if (!previous || previous.size === 0) return;
        const mask = state.eventMask | this.worldEventMask;
        for (const [peer, sensor] of previous) {
            const bit = sensor ? EventBit.sensorExit : EventBit.collisionExit;
            if ((mask & bit) === 0) continue;
            this.eventQueue.push(
                sensor ? EventKind.sensorExit : EventKind.collisionExit,
                handle,
                peer,
                -1,
                -1,
                0
            );
        }
    }

    // Dispatch ===========================================
    /**
     * Dispatch everything the step queued. Called from `PhysicsSystem.stepSimulation`, right
     * after `BodySystem.flushEvents()`, between `Step()` and `afterStep`.
     */
    flushEvents(): void {
        if (this.eventQueue.length === 0) return;
        this.payloads.debug = this.debug;
        this.payloads.reset();
        this.eventQueue.drain(FLUSH_ORDER, this.dispatchEvent);
    }

    private dispatchEvent = (kind: number, index: number): void => {
        const type = KIND_EVENT[kind] as
            | 'collisionEnter'
            | 'collisionPersist'
            | 'collisionExit'
            | 'sensorEnter'
            | 'sensorExit';
        const queue = this.eventQueue;
        const softHandle = queue.handle1(index);
        const peerHandle = queue.handle2(index);
        const state = this.bodies.get(softHandle);
        const world = this.worldEvents;

        if (world?.has(type)) {
            const payload = this.buildPayload(type, index, state, softHandle, peerHandle);
            world.emit(type, payload);
            this.payloads.poison(payload);
        }
        if (state?.events.has(type)) {
            const payload = this.buildPayload(type, index, state, softHandle, peerHandle);
            state.events.emit(type, payload);
            this.payloads.poison(payload);
        }
    };

    private buildPayload(
        type: string,
        index: number,
        state: SoftBodyState | undefined,
        softHandle: number,
        peerHandle: number
    ): PooledEnter | PooledBasic {
        const queue = this.eventQueue;
        const withManifold = type === 'collisionEnter' || type === 'collisionPersist';
        const enter = withManifold ? this.payloads.acquireEnter() : undefined;
        const payload: PooledEnter | PooledBasic = enter ?? this.payloads.acquireBasic();

        if (state) fillSoftTarget(payload.target, softHandle, state);
        else {
            // The soft body was already removed by the time this dispatched (its own removal
            // queued the exit) - world level listeners still get the handle.
            payload.target.handle = softHandle;
            payload.target.body = undefined;
            payload.target.object = undefined;
            payload.target.subShapeId = -1;
            payload.target.index = undefined;
            payload.target.softBody = undefined;
        }
        fillOtherTarget(payload.other, peerHandle, this.bodySystem, this);
        // A soft body is always the side the callback fired on - there is no "body 2" the way a
        // rigid pair has one, so this side is never the flipped one.
        payload.flipped = false;
        payload.contactCount = queue.contactCount(index);

        if (enter) {
            enter.normal.set(queue.normalX(index), queue.normalY(index), queue.normalZ(index));
            enter.penetration = queue.penetration(index);
            const points = queue.pointCount(index);
            enter.pointCount = points;
            this.payloads.sizePoints(enter, points);
            for (let i = 0; i < points; i++) queue.readPoint(index, i, enter.points[i]);
        }
        return payload;
    }
}

// Hoisted so `syncAll`'s `forEach` does not allocate a fresh closure every frame.
const syncOne = (state: SoftBodyState): void => state.syncGeometry();

/** Fill the soft body's own side of a contact payload. */
function fillSoftTarget(target: CollisionTarget, handle: number, state: SoftBodyState): void {
    target.handle = handle;
    target.body = undefined;
    target.object = state.object;
    target.subShapeId = -1;
    target.index = undefined;
    target.softBody = state;
}

/**
 * Fill the `other` side of a soft body contact: a rigid body registered with `bodySystem`, another
 * soft body registered with `softBodySystem`, or - like an unregistered rigid body in the rigid
 * contact pipeline - neither, in which case `body`/`object`/`softBody` are all left blank and only
 * `handle` is valid.
 */
function fillOtherTarget(
    target: CollisionTarget,
    handle: number,
    bodySystem: BodySystem | undefined,
    softBodySystem: SoftBodySystem
): void {
    const rigid = bodySystem?.getBody(handle);
    const soft = rigid ? undefined : softBodySystem.bodies.get(handle);
    target.handle = handle;
    target.body = rigid;
    target.object = rigid?.object ?? soft?.object;
    target.subShapeId = -1;
    target.index = rigid?.index;
    target.softBody = soft;
}
