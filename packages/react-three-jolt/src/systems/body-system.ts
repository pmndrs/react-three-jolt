// This class holds the bodies and the management of them
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import {
    type InstancedMesh,
    //MathUtils,
    //    Matrix4,
    Object3D,
    // Quaternion,
    Vector3
} from 'three';
import { Layer } from '../constants';
import {
    applySurfaceMaterial,
    type SurfaceMaterial,
    SurfaceMaterialTable
} from '../heightField/materials';
import { castObject, Raw } from '../raw';
import { devWarn, quat, vec3, withJolt } from '../utils';
import { BodyState } from './body-state';
import type { ConstraintSystem } from './constraint-system';
import {
    ContactEventQueue,
    ContactPairTracker,
    EventKind,
    FLUSH_ORDER,
    KIND_EVENT,
    PayloadPool,
    type PooledBasic,
    type PooledEnter
} from './contact-events';
import type { Emitter } from './emitter';
import {
    type CollisionTarget,
    EventBit,
    type SubShapeRef,
    type ValidatePayload,
    type WorldEventMap
} from './events';
import type { PhysicsSystem } from './physics-system';
import {
    type AutoShape,
    checkDynamicMeshStrategy,
    convexHullFromShape,
    createMeshForShape,
    createShapeFromSettings,
    createShapeSettings,
    type DynamicMeshStrategy,
    describeObject,
    describeShape,
    descriptorForSubShape,
    type HeightfieldShapeDescriptor,
    makeDescriptorDynamicSafe,
    releaseShape,
    type ShapeDescriptor,
    ShapeSystem,
    subShapeIndexFromId,
    subShapeUserData
} from './shape-system';

// TYPES ========================================
export type BodyType = 'dynamic' | 'static' | 'kinematic' | 'rig';
/**
 * What a deferred body action carries, per action name. Deferring exists because a body cannot
 * be touched from inside a Jolt callback; these are drained at the top of the next substep.
 */
export type PendingActionMap = {
    mass: number;
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
    applyTorque: THREE.Vector3;
    applyForce: THREE.Vector3;
    addImpulse: THREE.Vector3;
};

/** One queued action, discriminated by `action` so `value` narrows with it. */
export type PendingAction = {
    [K in keyof PendingActionMap]: { action: K; handle: number; value: PendingActionMap[K] };
}[keyof PendingActionMap];

/** Extras `addHeightfield` accepts beyond the mesh itself (issues #45/#46). */
/**
 * Jolt `BodyCreationSettings` fields merged into every body a world creates.
 *
 * `BodyCreationSettings` is an emscripten class, so this is a partial *view* of it rather than
 * a `Partial<Jolt.BodyCreationSettings>`: only the fields actually set are present, and
 * `mergeBodyCreationSettings` copies them across by name.
 */
export type DefaultBodySettings = Partial<Record<keyof Jolt.BodyCreationSettings, unknown>>;

/** Extras `addHeightfield` accepts beyond the mesh itself (issues #45/#46). */
export interface HeightfieldBodyOptions {
    /** Friction of the whole field. Per-quad values come from `materials` instead. */
    friction?: number;
    /** Restitution (bounciness) of the whole field. */
    restitution?: number;
    /**
     * Surfaces this field is made of. With more than one, `materialIndices` says which quad is
     * which. Pass a {@link SurfaceMaterialTable} to reuse one across rebuilds.
     */
    materials?: SurfaceMaterial[] | SurfaceMaterialTable;
    /** One index per quad, `(sampleCount - 1)^2` entries, row major. */
    materialIndices?: ArrayLike<number>;
    /** Jolt's heightfield block size (default 2). */
    blockSize?: number;
}

// We call things "bodySettings" to clarify from shapes or other similar labels
export interface GenerateBodyOptions {
    bodyType?: 'dynamic' | 'static' | 'kinematic' | 'rig';
    bodySettings?: Jolt.BodyCreationSettings;
    motionType?: 'static' | 'kinematic' | 'dynamic';
    index?: number;
    shapeType?: AutoShape;
    activation?: 'activate' | 'deactivate';
    jitter?: THREE.Vector3;
    mass?: number;
    /** @deprecated only used by the old dynamic-trimesh mass fallback; the shape's own mass properties are used now (#112) */
    size?: THREE.Vector3;
    group?: number;
    subGroup?: number;
    shape?: Jolt.Shape;
    /**
     * The description `shape` was built from. Stored on the `BodyState` so a contact's
     * `SubShapeID` can be traced back to the descriptor child that produced it (issue #13).
     * The `describeObject` path fills this in by itself; pass it when you hand over a
     * ready made `shape`.
     */
    shapeDescriptor?: ShapeDescriptor;
    /**
     * What to do with a trimesh shape on a **dynamic** body (issue #112). Jolt cannot simulate
     * one: mesh vs mesh has no collision, so the body falls through the world and ends up with a
     * NaN position.
     *
     * - `'convex'` (default): warn and use a convex hull of the same points instead.
     * - `'error'`: throw, so the mistake is loud.
     * - `'decompose'`: reserved for a convex decomposition; currently throws with an explanation.
     */
    dynamicMeshStrategy?: DynamicMeshStrategy;
}

// ================================================
export class BodySystem {
    jolt = Raw.module;
    /**
     * Every registered body by handle. The type partitioned maps below stay, because the frame
     * loop iterates dynamic and kinematic bodies separately; this one makes `getBody` - which
     * the contact listener calls twice per contact - a single lookup instead of up to three.
     */
    readonly bodies = new Map<number, BodyState>();
    dynamicBodies = new Map<number, BodyState>();
    staticBodies = new Map<number, BodyState>();
    kinematicBodies = new Map<number, BodyState>();

    /**
     * Static bodies that were moved since the last frame (issue #61).
     *
     * The frame loop only walks bodies that can be awake, so a static body's three.js object
     * would otherwise keep the pose it was created with. `BodyState`'s position/rotation setters
     * drop the body in here and `PhysicsSystem.onUpdate` drains it once per frame - so this
     * costs nothing at all in a scene whose statics never move.
     */
    readonly movedStatics = new Set<BodyState>();

    /** Called by {@link BodyState}'s setters; see {@link movedStatics}. */
    markStaticMoved(state: BodyState) {
        this.movedStatics.add(state);
    }

    /**
     * Bodies with a standing `setKinematicTarget` (issue #194), re-aimed at the top of every
     * substep with that substep's real dt. Empty unless something uses the API.
     */
    private readonly kinematicTargets = new Set<BodyState>();
    /** @internal called by {@link BodyState.setKinematicTarget}. */
    trackKinematicTarget(state: BodyState) {
        this.kinematicTargets.add(state);
    }
    /** @internal called by {@link BodyState.clearKinematicTarget}. */
    untrackKinematicTarget(state: BodyState) {
        this.kinematicTargets.delete(state);
    }

    //* Events ======================================
    /** Jolt listener objects, kept so they can be freed. See {@link destroy}. */
    contactListener?: Jolt.ContactListenerJS;
    activationListener?: Jolt.BodyActivationListenerJS;
    /** Records written inside `Step()`, dispatched by {@link flushEvents} after it. */
    readonly eventQueue = new ContactEventQueue();
    /** Open sub-shape manifolds per body pair; enter/persist/exit are derived from it. */
    readonly contactPairs = new ContactPairTracker();
    /** Reused event payloads. */
    readonly payloads = new PayloadPool();
    /** The world level emitter, wired up by `PhysicsSystem`. */
    worldEvents?: Emitter<WorldEventMap>;
    /**
     * The `PhysicsSystem` that owns this body system, wired up by it at construction. Bodies read
     * the world's step timing through it (see `BodyState.moveKinematic`); it is optional because
     * a `BodySystem` can be built on a bare Jolt physics system in tests.
     */
    world?: PhysicsSystem;
    /** Mirrors `PhysicsSystem.debug`: turns on payload poisoning after dispatch. */
    debug = false;
    /**
     * Registered bodies Jolt currently has awake. Maintained by the activation listener rather
     * than by scanning, and the basis of `settled` / `activityChange` (#52).
     */
    activeBodyCount = 0;
    private lastReportedActive = -1;

    /** Bodies that can be awake at all: dynamic (including rigs) and kinematic. */
    get simulatedBodyCount(): number {
        return this.dynamicBodies.size + this.kinematicBodies.size;
    }
    /** True when nothing is awake. `settled` fires on the transition into this state. */
    get isSettled(): boolean {
        return this.activeBodyCount === 0;
    }
    /** Single reused payload for the synchronous, inside-the-step validate callback. */
    private readonly validatePayload: ValidatePayload = {
        target: { body: undefined, object: undefined, handle: 0, subShapeId: -1 },
        other: { body: undefined, object: undefined, handle: 0, subShapeId: -1 },
        baseOffset: new Vector3()
    };

    // pending actions to be called at the begining of a frame
    //todo: type these
    pendingActions: PendingAction[] = [];

    /**
     * How `createBody` hands the descriptor it described an Object3D as back to
     * `addExistingBody`, without allocating a result object per body. The handle is checked so a
     * caller that created a body by hand and then added a *different* one gets nothing.
     */
    private readonly describedShape: { descriptor?: ShapeDescriptor; handle: number } = {
        descriptor: undefined,
        handle: -1
    };

    joltPhysicsSystem: Jolt.PhysicsSystem;
    bodyInterface: Jolt.BodyInterface;

    shapeSystem: ShapeSystem;

    // lets defaults be set at the physics system level
    defaultBodySettings: DefaultBodySettings = {};
    // Shape used when a body doesn't ask for one. Undefined keeps the per-geometry autodetect
    // in getShapeTypeFromGeometry. Settable from `<Physics defaultShape="box">`.
    defaultShape?: AutoShape;

    //* Collision groups ==============================
    // Object layers (`Layer` in constants.ts) stay the *broad* filter: "is this a moving thing,
    // a static thing, a kinematic thing". Collision groups answer the *narrow* question - "should
    // these two specific objects collide with each other". Jolt only consults the group filter
    // when two bodies share a group id; within a group, a disabled sub group pair skips the
    // contact. Bodies with no collision group (the default) always collide.
    //
    // Each body owns its own `CollisionGroup` (created in createBody / on first use, destroyed in
    // removeBody). It used to be ONE shared instance handed to every body, so setting a group on
    // one body rewrote the settings every later body was created from (issue #95).
    private collisionGroups = new Map<number, Jolt.CollisionGroup>();
    private groupFilterTable?: Jolt.GroupFilterTable;
    // Sub group ids index a packed bit triangle inside GroupFilterTable. Jolt only bounds checks
    // that index with an assert, which is compiled out of the release wasm, so an id past the end
    // of the table scribbles over the heap - every id is range checked here instead (issue #95).
    // Raise this before the first grouped body if you need more; the table is built on demand.
    subGroupCount = 256;

    // wired up by PhysicsSystem so removeBody can tear constraints down first
    constraintSystem?: ConstraintSystem;

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem) {
        // set the interfaces
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.bodyInterface = this.joltPhysicsSystem.GetBodyInterface();

        this.shapeSystem = new ShapeSystem(this.joltPhysicsSystem);

        // Activate the listeners
        this.initializeActivationListeners();
        this.initializeContactListeners();
    }

    //* Group Filtering ================================
    /**
     * The system wide filter every body's collision group points at. Built on the first grouped
     * body so ungrouped scenes never pay for it. Every pair is enabled to begin with; call
     * {@link disableCollision} to turn a specific one off.
     */
    get groupFilter(): Jolt.GroupFilterTable {
        if (!this.groupFilterTable) {
            const table = new Raw.module.GroupFilterTable(this.subGroupCount);
            // GroupFilter is ref counted and every CollisionGroup pointing at it holds a
            // reference. Take one of our own so the table survives the last grouped body being
            // removed instead of `delete this`-ing itself out from under the next one.
            table.AddRef();
            this.groupFilterTable = table;
        }
        return this.groupFilterTable;
    }

    private isValidSubGroup(subGroup: number, caller: string): boolean {
        if (!Number.isInteger(subGroup) || subGroup < 0 || subGroup >= this.subGroupCount) {
            devWarn(
                `${caller}: sub group ${subGroup} is out of range (0..${this.subGroupCount - 1}). ` +
                    'Raise bodySystem.subGroupCount before creating grouped bodies.'
            );
            return false;
        }
        return true;
    }

    /**
     * Turn collision between two sub groups on or off. Only applies to bodies that share the same
     * group id - this is the "these two specific objects shouldn't collide" filter, not the broad
     * category filter (that's the object layer, see `Layer` in constants.ts).
     */
    setGroupCollision(subGroupA: number, subGroupB: number, enabled: boolean) {
        if (!this.isValidSubGroup(subGroupA, 'setGroupCollision')) return;
        if (!this.isValidSubGroup(subGroupB, 'setGroupCollision')) return;
        if (subGroupA === subGroupB) {
            // Jolt stores only the lower triangle, so the (n, n) slot aliases a real pair's bit.
            // Give every body in a group its own sub group id rather than relying on this.
            devWarn('setGroupCollision: a sub group cannot be filtered against itself');
            return;
        }
        if (enabled) this.groupFilter.EnableCollision(subGroupA, subGroupB);
        else this.groupFilter.DisableCollision(subGroupA, subGroupB);
    }
    /** Stop two sub groups of the same group from colliding. */
    disableCollision(subGroupA: number, subGroupB: number) {
        this.setGroupCollision(subGroupA, subGroupB, false);
    }
    /** Let two sub groups of the same group collide again. */
    enableCollision(subGroupA: number, subGroupB: number) {
        this.setGroupCollision(subGroupA, subGroupB, true);
    }
    /** Whether two sub groups of the same group currently collide. */
    isCollisionEnabled(subGroupA: number, subGroupB: number): boolean {
        if (!this.isValidSubGroup(subGroupA, 'isCollisionEnabled')) return true;
        if (!this.isValidSubGroup(subGroupB, 'isCollisionEnabled')) return true;
        if (subGroupA === subGroupB) return true;
        return this.groupFilter.IsCollisionEnabled(subGroupA, subGroupB);
    }

    /** The CollisionGroup this system owns for a body, if it has one yet. */
    getCollisionGroup(bodyHandle: number): Jolt.CollisionGroup | undefined {
        return this.collisionGroups.get(bodyHandle);
    }

    // A fresh, caller-owned collision group already wired to the system filter.
    private makeCollisionGroup(group: number, subGroup: number): Jolt.CollisionGroup {
        const collisionGroup = new Raw.module.CollisionGroup();
        collisionGroup.SetGroupFilter(this.groupFilter);
        collisionGroup.SetGroupID(group);
        collisionGroup.SetSubGroupID(subGroup);
        return collisionGroup;
    }

    // Body handles are reused once a body is destroyed, so never leave a stale group behind.
    private destroyCollisionGroup(bodyHandle: number) {
        const existing = this.collisionGroups.get(bodyHandle);
        if (!existing) return;
        this.collisionGroups.delete(bodyHandle);
        Raw.module.destroy(existing);
    }

    /**
     * Change a body's collision group and/or sub group at runtime. Jolt's Body keeps its own copy
     * of the CollisionGroup, so ours is the source of truth and gets pushed across with
     * `BodyInterface.SetCollisionGroup`.
     *
     * @param activate (issue #167) when true (the default), a sleeping body is woken so the new
     * filtering is applied on the next step rather than whenever something else happens to touch
     * it - `BodyState.group`/`subGroup` default to this and take it from `activateOnChange`.
     * Pass `false` to change the group without disturbing a sleeping body.
     */
    setBodyCollisionGroup(bodyHandle: number, group?: number, subGroup?: number, activate = true) {
        const bodyState = this.getBody(bodyHandle);
        if (!bodyState) return;
        if (subGroup !== undefined && !this.isValidSubGroup(subGroup, 'setBodyCollisionGroup'))
            return;

        let collisionGroup = this.collisionGroups.get(bodyHandle);
        if (!collisionGroup) {
            collisionGroup = this.makeCollisionGroup(group ?? 0, subGroup ?? 0);
            this.collisionGroups.set(bodyHandle, collisionGroup);
        } else {
            if (group !== undefined) collisionGroup.SetGroupID(group);
            if (subGroup !== undefined) collisionGroup.SetSubGroupID(subGroup);
        }

        const bodyID = bodyState.body.GetID();
        this.bodyInterface.SetCollisionGroup(bodyID, collisionGroup);
        // static bodies are never active, and activating one asserts inside Jolt
        if (
            activate &&
            !bodyState.body.IsStatic() &&
            this.bodyInterface.IsAdded(bodyID) &&
            !bodyState.body.IsActive()
        )
            this.bodyInterface.ActivateBody(bodyID);
    }

    //* Body Management ================================
    // create a body from an object or shape
    createBody(objectOrShape: Object3D | Jolt.Shape, options: GenerateBodyOptions = {}): Jolt.Body {
        // fall back to the system wide default shape when the caller didn't pick one
        if (options.shapeType === undefined && this.defaultShape !== undefined)
            options = { ...options, shapeType: this.defaultShape };
        // #13: `generateBodySettings` is the only place that knows the descriptor an Object3D was
        // described as. It reports it here so `addExistingBody` can keep it on the BodyState.
        this.describedShape.descriptor = undefined;
        let settings = generateBodySettings(objectOrShape, options, this.describedShape);
        // if there are properties in the default, merge them with settings
        if (Object.keys(this.defaultBodySettings).length > 0)
            settings = mergeBodyCreationSettings(settings, this.defaultBodySettings);

        // Every grouped body gets its OWN CollisionGroup. Assigning it to the settings copies it
        // (as does CreateBody), so the instance we hold on to stays ours to mutate and destroy.
        let collisionGroup: Jolt.CollisionGroup | undefined;
        if (options.group !== undefined || options.subGroup !== undefined) {
            const subGroup = options.subGroup ?? 0;
            if (this.isValidSubGroup(subGroup, 'createBody'))
                collisionGroup = this.makeCollisionGroup(options.group ?? 0, subGroup);
            if (collisionGroup) settings.mCollisionGroup = collisionGroup;
        }

        const body = this.bodyInterface.CreateBody(settings);
        this.describedShape.handle = body.GetID().GetIndexAndSequenceNumber();
        // remove the settings
        this.jolt.destroy(settings);
        if (collisionGroup) {
            const handle = body.GetID().GetIndexAndSequenceNumber();
            // handles are recycled; free whatever a dead body left behind under this one
            this.destroyCollisionGroup(handle);
            this.collisionGroups.set(handle, collisionGroup);
        }
        return body;
    }
    // Create a new body and add it to the system
    addBody(object: Object3D, options?: GenerateBodyOptions) {
        //if we have a shape we need to pass that to the body creation, not the object
        const body = options?.shape
            ? this.createBody(options.shape, options)
            : this.createBody(object, options);
        return this.addExistingBody(object, body, options);
    }
    // add an EXISTING Jolt body to the system
    addExistingBody(
        object: Object3D | InstancedMesh,
        body: Jolt.Body,
        options?: GenerateBodyOptions
    ): number {
        const state = new BodyState(object, body, this.joltPhysicsSystem, this, options?.index);
        // generate the handle
        const handle = body.GetID().GetIndexAndSequenceNumber();
        // #13: what this body's shape was described as, either handed to us with the shape or
        // recorded by the `createBody` call just above
        state.shapeDescriptor =
            options?.shapeDescriptor ??
            (this.describedShape.handle === handle ? this.describedShape.descriptor : undefined);
        // Stamp the handle into Jolt's user data so the activation listener - whose second
        // argument is `inBodyUserData` - resolves a body with no wrapPointer and no lookup.
        // Jolt >=0.39 narrowed user data to 32 bit unsigned, which is exactly what
        // GetIndexAndSequenceNumber() is; sequence numbers start at 1, so a valid handle is
        // never 0 and 0 reliably means "a body this system did not create".
        body.SetUserData(handle);
        // console.log('adding body', handle, options, state, object, body);
        // add to the correct map
        this.bodies.set(handle, state);
        if (options?.bodyType === 'static') this.staticBodies.set(handle, state);
        else if (options?.bodyType === 'kinematic') this.kinematicBodies.set(handle, state);
        else this.dynamicBodies.set(handle, state);

        // allow to add the body but not activate it
        let activationState = Raw.module.EActivation_Activate;
        if (options?.activation) {
            switch (options.activation) {
                case 'activate':
                    activationState = Raw.module.EActivation_Activate;
                    break;
                case 'deactivate':
                    activationState = Raw.module.EActivation_DontActivate;
                    break;
            }
        }

        // VERY IMPORTANT! ADD TO THE ACTUAL SIMULATION
        this.bodyInterface.AddBody(body.GetID(), activationState);
        // Registry event (#158), after the body is fully live so a listener may read its shape
        // and pose. Costs nothing when nothing is listening.
        this.worldEvents?.emit('bodyAdded', state);
        return handle;
    }
    getBody(handle: number) {
        return this.bodies.get(handle);
    }
    removeBody(bodyHandle: number, ignoreThree = false) {
        //console.log('Trying to remove body', bodyHandle);
        // get the body so we can process it
        const bodyState = this.getBody(bodyHandle);
        if (!bodyState) return;
        // Registry event (#158). Emitted before anything is torn down - every early return below
        // still leaves the body out of the maps, so a listener that mirrors the world has to hear
        // about it exactly once, here.
        this.worldEvents?.emit('bodyRemoved', bodyState);
        // The collision group is ours, not the body's (Jolt copied it), so free it up front -
        // every early return below would otherwise leak it and hand the recycled handle a stale
        // one. (issue #95)
        this.destroyCollisionGroup(bodyHandle);
        // check if the body exists in the simulation
        // first check the simulation is still here (might be removed after physics is removed)
        if (!this.joltPhysicsSystem) return;
        if (!this.bodyInterface) return;
        // Close open contacts and drop this body's listeners BEFORE it leaves the simulation:
        // handles are recycled, so leftover pair state would be attributed to a different body,
        // and `RemoveBody` deactivates the body synchronously - which would otherwise deliver a
        // phantom `sleep` to a handler that is on its way out.
        bodyState.dispose();
        const bodyID = bodyState.body.GetID();
        const body = this.joltPhysicsSystem.GetBodyLockInterfaceNoLock().TryGetBody(bodyID);
        if (!body) {
            devWarn('body getter failed during delete', bodyHandle);
            this.forget(bodyHandle);
            return;
        }

        if (!this.bodyInterface.IsAdded(bodyID)) {
            // console.log('body already removed');
            this.forget(bodyHandle);
            return;
        }

        // Constraints hold raw pointers to both of their bodies and jolt dereferences them
        // while detaching, so every constraint touching this body has to go first or the
        // next step reads freed memory. (issue #82)
        this.constraintSystem?.removeConstraintsForBody(bodyHandle);

        // remove the body from the simulation
        this.bodyInterface.RemoveBody(bodyID);
        // destroy it
        this.bodyInterface.DestroyBody(bodyID);
        // remove it from threeJS by removing it from it's parent
        // only if its not an instanced mesh or explicitly told to ignore.
        if (!bodyState.isInstance || ignoreThree) bodyState.object.parent?.remove(bodyState.object);
        // remove it from the maps

        this.forget(bodyHandle);
        // console.log('Removed body', bodyHandle);
    }

    /**
     * Remove and destroy every registered body, whether it was made by `addBody` or handed in
     * through `addExistingBody`. Used by `PhysicsSystem.destroy()` (issue #162): the
     * JoltInterface's destructor would free the bodies anyway, but going through `removeBody`
     * is what closes open contact pairs, frees each body's `CollisionGroup` and drops the
     * constraints attached to it - none of which the interface knows about.
     *
     * @returns how many bodies were removed
     */
    removeAllBodies(): number {
        let removed = 0;
        // snapshot: removeBody mutates every map it iterates, and a contact `exit` dispatched
        // from `dispose()` may add more pending actions
        for (const handle of [...this.bodies.keys()]) {
            if (!this.bodies.has(handle)) continue;
            this.removeBody(handle);
            removed++;
        }
        this.pendingActions = [];
        return removed;
    }

    /** Drop a handle from every map. Jolt recycles handles, so nothing may be left behind. */
    private forget(bodyHandle: number) {
        const state = this.bodies.get(bodyHandle);
        if (state) {
            this.movedStatics.delete(state);
            this.kinematicTargets.delete(state);
        }
        this.bodies.delete(bodyHandle);
        this.dynamicBodies.delete(bodyHandle);
        this.staticBodies.delete(bodyHandle);
        this.kinematicBodies.delete(bodyHandle);
    }

    /**
     * Add a (flat, square) plane mesh as a static heightfield body.
     *
     * The heights come from the mesh's vertices, so whatever put them there - a heightmap image,
     * `generateHeightfield`, your own callback - render and physics see the same numbers.
     *
     * `friction`/`restitution` apply to the whole body (issue #46); `materials` +
     * `materialIndices` give individual quads their own, resolved synchronously inside the
     * contact listener (see `heightField/materials.ts`).
     */
    public addHeightfield(planeMesh: THREE.Mesh, options: HeightfieldBodyOptions = {}): number {
        const { friction, restitution, materials, materialIndices, blockSize } = options;
        const descriptor = describeShape(planeMesh, {
            type: 'heightfield',
            blockSize
        }) as HeightfieldShapeDescriptor;

        // one table per body: it owns the jolt-material -> {friction, restitution} mapping the
        // contact listener resolves through, and it is disposed with the body
        const table =
            materials instanceof SurfaceMaterialTable
                ? materials
                : materials && materials.length
                  ? new SurfaceMaterialTable(materials)
                  : undefined;
        if (table) {
            descriptor.materials = table;
            if (materialIndices) descriptor.materialIndices = materialIndices;
        }

        const quaternion = new Raw.module.Quat(0, 0, 0, 1);
        // Jolt's heightfield grows from its origin in +x/+z, so shift it back by half the field
        // to line the shape up with the (centred) plane geometry. The extent is one sample less
        // than the sample count: `sampleCount` samples span `sampleCount - 1` quads.
        const { sampleCount, scale } = descriptor;
        const offsetX = -(sampleCount - 1) * scale[0] * 0.5;
        const offsetZ = -(sampleCount - 1) * scale[2] * 0.5;
        const position = new Raw.module.RVec3(
            offsetX + planeMesh.position.x,
            planeMesh.position.y,
            planeMesh.position.z + offsetZ
        );

        // this destroys the shapeSettings and hands back a shape we hold a reference on
        const shape = createShapeFromSettings(createShapeSettings(descriptor));
        const creationSettings = new Raw.module.BodyCreationSettings(
            shape,
            position,
            quaternion,
            Raw.module.EMotionType_Static,
            Layer.NON_MOVING
        );
        if (friction !== undefined) creationSettings.mFriction = friction;
        if (restitution !== undefined) creationSettings.mRestitution = restitution;
        const body = this.bodyInterface.CreateBody(creationSettings);
        // cleanup before returning. The body holds its own reference to the shape and the
        // creation settings copied the transform, so all of this is ours to free.
        this.jolt.destroy(creationSettings);
        this.jolt.destroy(position);
        this.jolt.destroy(quaternion);
        releaseShape(shape);

        const handle = this.addExistingBody(planeMesh, body, { bodyType: 'static' });
        // `table.mapped` is only true once the shape actually built the material list
        if (table?.mapped) this.getBody(handle)?.setSurfaceMaterials(table);
        return handle;
    }
    //* Body Modification ===================================
    // change the mass of a body
    setMass(bodyHandle: number, mass: number) {
        const body = this.getBody(bodyHandle);
        if (!body) return;
        // one implementation, on BodyState: it scales the motion properties rather than pushing
        // a fresh MassProperties through `SetMassProperties`, which also reset the body's
        // allowed degrees of freedom to "all" (issue #201)
        body.mass = mass;
    }

    //* Loop Functions ===================================
    createPendingAction<K extends keyof PendingActionMap>(
        action: K,
        handle: number,
        value: PendingActionMap[K]
    ) {
        // TS cannot see that `action` and `value` came from the same map entry once they are
        // separate variables, so the union is reassembled here rather than at six call sites.
        this.pendingActions.push({ action, handle, value } as PendingAction);
    }
    /**
     * Run at the top of every substep, before `Step()`.
     *
     * @param deltaTime the substep's own length in seconds, used to re-aim every standing
     * kinematic target (issue #194) so `MoveKinematic` derives a velocity that lands the body on
     * its target within this step, however many substeps the frame runs.
     */
    handlePendingActions(deltaTime = 0) {
        if (deltaTime > 0 && this.kinematicTargets.size)
            for (const state of this.kinematicTargets) state.applyKinematicTarget(deltaTime);
        if (!this.pendingActions.length) return;
        // lets try this first utilizing setters
        this.pendingActions.forEach((action) => {
            const body = this.getBody(action.handle);
            if (!body) return;

            switch (action.action) {
                case 'mass':
                    body.mass = action.value;
                    break;
                case 'position':
                    body.position = action.value;
                    break;
                case 'rotation':
                    body.rotation = action.value;
                    break;
                case 'applyTorque':
                    body.applyTorque(action.value);
                    break;
                case 'applyForce':
                    body.applyForce(action.value);
                    break;
                case 'addImpulse':
                    body.addImpulse(action.value);
                    break;
            }
        });
        // clear the actions
        this.pendingActions = [];
    }

    // Activation Listeners ================================
    /**
     * Wake and sleep. `inBodyUserData` is the handle stamped onto every body this system
     * creates, so the pair resolves with no `wrapPointer` and no map walk - a body someone
     * else created has user data 0 and simply resolves to `undefined`.
     */
    private initializeActivationListeners() {
        // Emscripten's JSImplementation glue does a `hasOwnProperty` check per call site, so
        // these have to be own properties of the instance - a subclass with prototype methods
        // would throw from inside the WASM callback.
        const listener = new Raw.module.BodyActivationListenerJS();
        // (the binding declares these as raw pointer numbers, which is what they are here)
        listener.OnBodyActivated = (_bodyId: number, userData: number) =>
            this.queueActivation(userData, EventKind.wake);
        listener.OnBodyDeactivated = (_bodyId: number, userData: number) =>
            this.queueActivation(userData, EventKind.sleep);
        // Owned, so it can be freed - after the JoltInterface, which holds a raw pointer to it.
        this.activationListener = listener;
        this.joltPhysicsSystem.SetBodyActivationListener(listener);
    }

    private queueActivation(userData: number, kind: number): void {
        const state = userData ? this.bodies.get(userData) : undefined;
        // The count is maintained here, unconditionally and synchronously: it is a single
        // integer, safe to touch inside the step, and it is what `settled` is edge triggered
        // off instead of scanning every body each frame. Bodies this system did not create are
        // not counted, so `activeBodyCount <= simulatedBodyCount` holds.
        if (state) {
            if (kind === EventKind.wake) this.activeBodyCount++;
            else if (this.activeBodyCount > 0) this.activeBodyCount--;
        }
        // A body is activated by `AddBody` before any listener could have subscribed, and
        // deactivated by `RemoveBody` after `dispose()` cleared its emitter. Gating on the mask
        // keeps both of those out of the queue instead of delivering a phantom wake on mount.
        const mask = (state?.eventMask ?? 0) | this.worldEventMask;
        const bit = kind === EventKind.wake ? EventBit.wake : EventBit.sleep;
        if ((mask & bit) === 0) return;
        this.eventQueue.push(kind, userData, 0, -1, -1, 0);
    }

    /**
     * Report `activityChange`, and `settled` when the last awake body goes to sleep (#52).
     * Edge triggered off {@link activeBodyCount}, so this costs one comparison per step.
     */
    private reportActivity(): void {
        const active = this.activeBodyCount;
        if (active === this.lastReportedActive) return;
        const previous = this.lastReportedActive;
        this.lastReportedActive = active;
        const world = this.worldEvents;
        if (!world) return;
        world.emit('activityChange', active, this.simulatedBodyCount);
        // `previous > 0` so a world that was never active does not announce itself settled
        if (active === 0 && previous > 0) world.emit('settled');
    }

    // Contact Listeners ===================================
    /**
     * Two tiers. Inside the Jolt callback only the things that have to be synchronous happen:
     * the `ValidateResult` return, `ContactSettings` writes (conveyors), and the sub-shape pair
     * refcount. Everything user facing is written to `eventQueue` and dispatched from
     * `flushEvents()` once `Step()` has returned.
     */
    /**
     * Turn one side's raw `SubShapeID` into the `<Shape>` (or descriptor child) that produced it
     * - issue #13. Handed to the payload pool, which calls it only when a handler actually reads
     * `payload.targetSubShape` / `.otherSubShape`, so an unused sub shape costs nothing.
     *
     * A body whose shape has no children reports Jolt's empty id; `subShapeIndexFromId` looks at
     * the shape rather than the id to tell that apart from "child 1 of a two child compound",
     * whose id happens to be the same word.
     */
    private resolveSubShape = (target: CollisionTarget, out: SubShapeRef): void => {
        const state = target.body;
        // an unregistered or already destroyed body: `id` is all the caller gets
        if (!state || state.disposed) return;
        const shape = state.body.GetShape();
        if (!shape) return;
        out.index = subShapeIndexFromId(shape, target.subShapeId);
        out.userData = subShapeUserData(shape, target.subShapeId);
        out.descriptor = descriptorForSubShape(state.shapeDescriptor, out.index);
    };

    private initializeContactListeners() {
        this.payloads.subShapeResolver = this.resolveSubShape;
        const listener = new Raw.module.ContactListenerJS();
        listener.OnContactValidate = (
            body1: number,
            body2: number,
            baseOffset: number,
            _collisionResult: number
        ) => this.onContactValidate(body1, body2, baseOffset);
        listener.OnContactAdded = (
            body1: number,
            body2: number,
            manifold: number,
            settings: number
        ) => this.onContact(body1, body2, manifold, settings, true);
        listener.OnContactPersisted = (
            body1: number,
            body2: number,
            manifold: number,
            settings: number
        ) => this.onContact(body1, body2, manifold, settings, false);
        listener.OnContactRemoved = (subShapePair: number) => this.onContactRemoved(subShapePair);

        this.contactListener = listener;
        this.joltPhysicsSystem.SetContactListener(listener);
    }

    /** Ors together everything anyone is listening for, per pair. Drives the zero-cost path. */
    private get worldEventMask(): number {
        return this.worldEvents?.mask ?? 0;
    }

    private onContactValidate(body1Ptr: number, body2Ptr: number, baseOffsetPtr: number): number {
        const jolt = Raw.module;
        const accept = jolt.ValidateResult_AcceptAllContactsForThisBodyPair;
        const body1 = jolt.wrapPointer(body1Ptr, jolt.Body);
        const body2 = jolt.wrapPointer(body2Ptr, jolt.Body);
        const handle1 = body1.GetID().GetIndexAndSequenceNumber();
        const handle2 = body2.GetID().GetIndexAndSequenceNumber();
        const state1 = this.bodies.get(handle1);
        const state2 = this.bodies.get(handle2);
        const mask = (state1?.eventMask ?? 0) | (state2?.eventMask ?? 0) | this.worldEventMask;
        if ((mask & EventBit.contactValidate) === 0) return accept;

        const payload = this.validatePayload;
        const offset = jolt.wrapPointer(baseOffsetPtr, jolt.RVec3);
        payload.baseOffset.set(offset.GetX(), offset.GetY(), offset.GetZ());

        let accepted = true;
        if (state1?.events.has('contactValidate')) {
            fillTarget(payload.target, handle1, state1);
            fillTarget(payload.other, handle2, state2);
            accepted = state1.events.emitVeto('contactValidate', payload) && accepted;
        }
        if (state2?.events.has('contactValidate')) {
            fillTarget(payload.target, handle2, state2);
            fillTarget(payload.other, handle1, state1);
            accepted = state2.events.emitVeto('contactValidate', payload) && accepted;
        }
        if (this.worldEvents?.has('contactValidate')) {
            fillTarget(payload.target, handle1, state1);
            fillTarget(payload.other, handle2, state2);
            accepted = this.worldEvents.emitVeto('contactValidate', payload) && accepted;
        }
        return accepted ? accept : jolt.ValidateResult_RejectContact;
    }

    private onContact(
        body1Ptr: number,
        body2Ptr: number,
        manifoldPtr: number,
        settingsPtr: number,
        added: boolean
    ): void {
        const jolt = Raw.module;
        const body1 = jolt.wrapPointer(body1Ptr, jolt.Body);
        const body2 = jolt.wrapPointer(body2Ptr, jolt.Body);
        const handle1 = body1.GetID().GetIndexAndSequenceNumber();
        const handle2 = body2.GetID().GetIndexAndSequenceNumber();
        const state1 = this.bodies.get(handle1);
        const state2 = this.bodies.get(handle2);
        const mask = (state1?.eventMask ?? 0) | (state2?.eventMask ?? 0) | this.worldEventMask;

        let sensor = false;
        let count: number;
        let sub1 = -1;
        let sub2 = -1;
        let manifold: Jolt.ContactManifold | undefined;

        if (added) {
            // The sub-shape ids live on the manifold, and the refcount is maintained whether or
            // not anyone is listening: `isContacting()` is public API in its own right.
            manifold = jolt.wrapPointer(manifoldPtr, jolt.ContactManifold);
            sub1 = manifold.get_mSubShapeID1().GetValue();
            sub2 = manifold.get_mSubShapeID2().GetValue();
            sensor = body1.IsSensor() || body2.IsSensor();
            const pair = this.contactPairs.add(handle1, handle2, sub1, sub2, sensor);
            count = pair.count;
            sensor = pair.sensor;
            setContactCount(state1, handle2, count);
            setContactCount(state2, handle1, count);
        } else {
            count = this.contactPairs.count(handle1, handle2);
            sensor = this.contactPairs.isSensorPair(handle1, handle2);
        }

        // Tier A: a heightfield's per-quad friction (issue #46). Jolt's own materials carry no
        // friction, so the material under this contact is resolved here and written into the
        // live `ContactSettings` - the only place it can be changed.
        if (mask & EventBit.surfaceMaterial) {
            if (!manifold) manifold = jolt.wrapPointer(manifoldPtr, jolt.ContactManifold);
            if (sub1 < 0) {
                sub1 = manifold.get_mSubShapeID1().GetValue();
                sub2 = manifold.get_mSubShapeID2().GetValue();
            }
            const settings = jolt.wrapPointer(settingsPtr, jolt.ContactSettings);
            applyMaterialContact(state1, body1, sub1, body2, settings);
            applyMaterialContact(state2, body2, sub2, body1, settings);
        }

        // Tier A: the conveyor / bounce pad surface velocity writes have to happen here,
        // synchronously, because `ContactSettings` is only live inside this call.
        if (mask & EventBit.motionSource) {
            const source = state1?.isMotionSource
                ? state1
                : state2?.isMotionSource
                  ? state2
                  : undefined;
            if (source) {
                const settings = jolt.wrapPointer(settingsPtr, jolt.ContactSettings);
                source.handleMotionContact(handle1, handle2, settings);
            }
        }

        // Tier B: queue for dispatch after the step.
        const enter = added && count === 1;
        let kind: number;
        let bit: number;
        if (sensor) {
            if (!enter) return; // sensors have no persist channel
            kind = EventKind.sensorEnter;
            bit = EventBit.sensorEnter;
        } else if (enter) {
            kind = EventKind.collisionEnter;
            bit = EventBit.collisionEnter;
        } else {
            kind = EventKind.collisionPersist;
            bit = EventBit.collisionPersist;
        }
        if ((mask & bit) === 0) return;

        if (!manifold) manifold = jolt.wrapPointer(manifoldPtr, jolt.ContactManifold);
        if (!added) {
            sub1 = manifold.get_mSubShapeID1().GetValue();
            sub2 = manifold.get_mSubShapeID2().GetValue();
        }
        this.queueManifold(kind, handle1, handle2, sub1, sub2, count, manifold, sensor);
    }

    /** Snapshot the manifold's scalars. Nothing Jolt owns outlives this function. */
    private queueManifold(
        kind: number,
        handle1: number,
        handle2: number,
        sub1: number,
        sub2: number,
        count: number,
        manifold: Jolt.ContactManifold,
        sensor: boolean
    ): void {
        const normal = manifold.get_mWorldSpaceNormal();
        const capacity = sensor ? 0 : this.eventQueue.pointCapacity;
        const available = capacity > 0 ? manifold.get_mRelativeContactPointsOn1().size() : 0;
        const points = available < capacity ? available : capacity;
        const index = this.eventQueue.push(
            kind,
            handle1,
            handle2,
            sub1,
            sub2,
            count,
            normal.GetX(),
            normal.GetY(),
            normal.GetZ(),
            manifold.get_mPenetrationDepth(),
            points
        );
        for (let i = 0; i < points; i++) {
            // returns one static temporary per call: read it now, never destroy it
            const point = manifold.GetWorldSpaceContactPointOn1(i);
            this.eventQueue.setPoint(index, i, point.GetX(), point.GetY(), point.GetZ());
        }
    }

    private onContactRemoved(subShapePairPtr: number): void {
        const jolt = Raw.module;
        const pair = jolt.wrapPointer(subShapePairPtr, jolt.SubShapeIDPair);
        const handle1 = pair.GetBody1ID().GetIndexAndSequenceNumber();
        const handle2 = pair.GetBody2ID().GetIndexAndSequenceNumber();
        const sub1 = pair.GetSubShapeID1().GetValue();
        const sub2 = pair.GetSubShapeID2().GetValue();

        const result = this.contactPairs.remove(handle1, handle2, sub1, sub2);
        // Already gone: the body was destroyed and `dispose()` closed the pair itself.
        if (!result.existed) return;

        const state1 = this.bodies.get(handle1);
        const state2 = this.bodies.get(handle2);
        setContactCount(state1, handle2, result.count);
        setContactCount(state2, handle1, result.count);
        // only the *last* sub-shape manifold closing is an exit
        if (result.count > 0) return;

        const mask = (state1?.eventMask ?? 0) | (state2?.eventMask ?? 0) | this.worldEventMask;
        const bit = result.sensor ? EventBit.sensorExit : EventBit.collisionExit;
        if ((mask & bit) === 0) return;
        this.eventQueue.push(
            result.sensor ? EventKind.sensorExit : EventKind.collisionExit,
            handle1,
            handle2,
            sub1,
            sub2,
            0
        );
    }

    /**
     * Close every open pair on a body that is about to be destroyed: peers get their exit, and
     * nothing stale is left keyed on a handle Jolt will recycle.
     */
    closeContactsFor(handle: number, peers: Iterable<number>): void {
        for (const peer of peers) {
            const entry = this.contactPairs.removePair(handle, peer);
            if (!entry) continue;
            const peerState = this.bodies.get(peer);
            peerState?.contacts.delete(handle);
            const mask = (peerState?.eventMask ?? 0) | this.worldEventMask;
            const bit = entry.sensor ? EventBit.sensorExit : EventBit.collisionExit;
            if ((mask & bit) === 0) continue;
            this.eventQueue.push(
                entry.sensor ? EventKind.sensorExit : EventKind.collisionExit,
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
     * Dispatch everything the step queued. Called from `PhysicsSystem.stepSimulation` between
     * `Step()` and `afterStep`, so handlers may freely add, move and remove bodies.
     */
    flushEvents(): void {
        if (this.eventQueue.length > 0) {
            this.payloads.debug = this.debug;
            this.payloads.reset();
            this.eventQueue.drain(FLUSH_ORDER, this.dispatchEvent);
        }
        // after the sleep/wake events, so a handler that counts them agrees with the totals
        this.reportActivity();
    }

    /** Drop queued events without dispatching them (the world is going away). */
    clearEvents(): void {
        this.eventQueue.clear();
    }

    private dispatchEvent = (kind: number, index: number): void => {
        if (kind === EventKind.sleep || kind === EventKind.wake) {
            this.dispatchActivation(kind, index);
            return;
        }
        this.dispatchContact(kind, index);
    };

    private dispatchActivation(kind: number, index: number): void {
        const type = kind === EventKind.wake ? 'wake' : 'sleep';
        const handle = this.eventQueue.handle1(index);
        const state = this.bodies.get(handle);
        const payload = this.payloads.acquireActivation();
        payload.handle = handle;
        payload.body = state;
        this.worldEvents?.emit(type, payload);
        state?.events.emit(type, payload);
        this.payloads.poison(payload);
    }

    private dispatchContact(kind: number, index: number): void {
        const type = KIND_EVENT[kind] as
            | 'collisionEnter'
            | 'collisionPersist'
            | 'collisionExit'
            | 'sensorEnter'
            | 'sensorExit';
        const queue = this.eventQueue;
        const handle1 = queue.handle1(index);
        const handle2 = queue.handle2(index);
        const state1 = this.bodies.get(handle1);
        const state2 = this.bodies.get(handle2);
        const world = this.worldEvents;

        // World level fires once per pair, with the lower handle as `target`, so a world wide
        // counter is right without dividing by two.
        if (world?.has(type)) {
            const targetIsSecond = handle2 < handle1;
            const payload = this.buildPayload(type, index, targetIsSecond, state1, state2);
            world.emit(type, payload);
            this.payloads.poison(payload);
        }
        // Then per body: body 1, then body 2, each with its own target/other/flipped.
        if (state1?.events.has(type)) {
            const payload = this.buildPayload(type, index, false, state1, state2);
            state1.events.emit(type, payload);
            this.payloads.poison(payload);
        }
        if (state2?.events.has(type)) {
            const payload = this.buildPayload(type, index, true, state1, state2);
            state2.events.emit(type, payload);
            this.payloads.poison(payload);
        }
    }

    /**
     * @param flipped true when the handler's body is Jolt's body 2.
     */
    private buildPayload(
        type: string,
        index: number,
        flipped: boolean,
        state1: BodyState | undefined,
        state2: BodyState | undefined
    ): PooledEnter | PooledBasic {
        const queue = this.eventQueue;
        const handle1 = queue.handle1(index);
        const handle2 = queue.handle2(index);
        const withManifold = type === 'collisionEnter' || type === 'collisionPersist';
        // `enter` is the same object as `payload` when there is a manifold; keeping the narrower
        // reference is what lets the manifold block below be written without a cast, since TS
        // cannot correlate `withManifold` with which branch of the union was taken.
        const enter = withManifold ? this.payloads.acquireEnter() : undefined;
        const payload: PooledEnter | PooledBasic = enter ?? this.payloads.acquireBasic();

        fillTarget(
            payload.target,
            flipped ? handle2 : handle1,
            flipped ? state2 : state1,
            flipped ? queue.sub2(index) : queue.sub1(index)
        );
        fillTarget(
            payload.other,
            flipped ? handle1 : handle2,
            flipped ? state1 : state2,
            flipped ? queue.sub1(index) : queue.sub2(index)
        );
        payload.flipped = flipped;
        payload.contactCount = queue.contactCount(index);

        if (enter) {
            // Jolt's normal points from body 1 toward body 2; ours points from `other` toward
            // `target`, i.e. the direction `target` moves to separate.
            const sign = flipped ? 1 : -1;
            enter.normal.set(
                queue.normalX(index) * sign,
                queue.normalY(index) * sign,
                queue.normalZ(index) * sign
            );
            enter.penetration = queue.penetration(index);
            const points = queue.pointCount(index);
            enter.pointCount = points;
            this.payloads.sizePoints(enter, points);
            for (let i = 0; i < points; i++) queue.readPoint(index, i, enter.points[i]);
        }
        return payload;
    }

    // Lifecycle ==========================================
    /**
     * Free everything this system allocated on the Jolt heap that isn't a body, and drop all
     * event state.
     *
     * Call order matters: `PhysicsSystem.destroy()` frees the JoltInterface *first*, because
     * Jolt's PhysicsSystem holds raw pointers to these listeners and freeing an installed
     * listener is a use after free on the next step. The bodies being gone by then is also what
     * makes the group filter safe to release: it is ref counted, so dropping our reference frees
     * it only once no body is still holding a copy of a group that points at it (issue #95).
     *
     * Idempotent - React tears `<Physics>` down more than once.
     *
     * @param freeListeners false when this world was sharing somebody else's JoltInterface, in
     * which case that interface is still live and still pointing at these listeners.
     */
    destroy(freeListeners = true): void {
        this.eventQueue.clear();
        this.contactPairs.clear();
        this.activeBodyCount = 0;
        this.lastReportedActive = -1;
        for (const state of this.bodies.values()) state.events.clear();
        this.bodies.clear();
        this.dynamicBodies.clear();
        this.staticBodies.clear();
        this.kinematicBodies.clear();
        this.movedStatics.clear();
        this.kinematicTargets.clear();
        this.pendingActions = [];
        // Our own allocations, not listeners installed on the JoltInterface: these are freed even
        // when the interface belongs to another world (issue #95).
        this.collisionGroups.forEach((collisionGroup) => {
            Raw.module.destroy(collisionGroup);
        });
        this.collisionGroups.clear();
        if (this.groupFilterTable) {
            this.groupFilterTable.Release();
            this.groupFilterTable = undefined;
        }
        if (!freeListeners) return;
        if (this.contactListener) {
            Raw.module.destroy(this.contactListener);
            this.contactListener = undefined;
        }
        if (this.activationListener) {
            Raw.module.destroy(this.activationListener);
            this.activationListener = undefined;
        }
    }
}

/** Mirror the pair's open sub-shape count onto a body's `contacts` map (drives `isContacting`). */
function setContactCount(state: BodyState | undefined, peer: number, count: number): void {
    if (!state) return;
    if (count > 0) state.contacts.set(peer, count);
    else state.contacts.delete(peer);
}

/**
 * Resolve the surface material under one side of a contact and write it into `ContactSettings`.
 *
 * A no-op for every body that has no material table, which is all of them except heightfields
 * built with `materials` - and the `EventBit.surfaceMaterial` gate means this is not even
 * reached otherwise.
 */
function applyMaterialContact(
    state: BodyState | undefined,
    body: Jolt.Body,
    subShapeId: number,
    otherBody: Jolt.Body,
    settings: Jolt.ContactSettings
): void {
    const table = state?.surfaceMaterials;
    if (!table) return;
    const material = table.resolve(body.GetShape(), subShapeId);
    if (material) applySurfaceMaterial(material, otherBody, settings);
}

/** Fill one side of a payload in place. An unregistered Jolt body leaves body/object blank. */
function fillTarget(
    target: CollisionTarget,
    handle: number,
    state: BodyState | undefined,
    subShapeId = -1
): void {
    target.handle = handle;
    target.body = state;
    target.object = state?.object;
    target.index = state?.index;
    target.subShapeId = subShapeId;
}

// Jolt Utilities =================================
// merge jolt Settings with optional object
export function mergeBodyCreationSettings(
    settings: Jolt.BodyCreationSettings,
    options?: Jolt.BodyCreationSettings | DefaultBodySettings
) {
    if (!options) return settings;
    // embind: BodyCreationSettings' properties are emscripten accessors, so a key-by-key copy
    // is the only way to merge two of them - and no index signature exists to type that with.
    // The pair of casts is the whole unsafety, made once and explicitly, instead of the blanket
    // suppression this used to carry.
    const target = settings as unknown as Record<string, unknown>;
    const source = options as unknown as Record<string, unknown>;
    // loop over the object keys and set the settings
    for (const key in source) {
        target[key] = source[key];
    }
    return settings;
}

export function generateBodySettings(
    object: Object3D | Jolt.Shape,
    options: GenerateBodyOptions = {},
    /** Out parameter: receives the descriptor an `Object3D` was described as (issue #13). */
    describedShape?: { descriptor?: ShapeDescriptor }
): Jolt.BodyCreationSettings {
    const jolt = Raw.module;
    const isObject = object instanceof Object3D;
    // whether the shape below is one we created (and therefore have to release again)
    let ownsShape = isObject;

    // create position and quaternion from three to jolt
    const threePosition = new THREE.Vector3();
    const threeQuaternion = new THREE.Quaternion();
    if (isObject) {
        threePosition.copy(object.position);
        threeQuaternion.copy(object.quaternion);
    }
    // Jitter fixes a problem where rapidly created bodies jam each other
    // also allows nice effects like fountains when creating bodies
    if (options.jitter) {
        // jitter is a vector3 with a max distance
        // generate a new vector3 with a random value between 0 and the jitter value for each axis
        const jitter = new THREE.Vector3(
            Math.random() * options.jitter.x,
            Math.random() * options.jitter.y,
            Math.random() * options.jitter.z
        );
        threePosition.add(jitter);
        // jitter the rotation too
        threeQuaternion.setFromEuler(
            new THREE.Euler(
                Math.random() * options.jitter.x,
                Math.random() * options.jitter.y,
                Math.random() * options.jitter.z
            )
        );
    }
    // reset the items to jolt types
    // BodyCreationSettings takes an RVec3 world space position in jolt-physics >=1.0
    const position = vec3.rjolt(threePosition);
    const quaternion = quat.threeToJolt(threeQuaternion);

    // type bases on bodyType (Dynamic by default)
    let layer: number;
    let motionType: Jolt.EMotionType;
    switch (options.bodyType) {
        case 'static':
            motionType = jolt.EMotionType_Static;
            layer = Layer.NON_MOVING;
            break;
        case 'kinematic':
            motionType = jolt.EMotionType_Kinematic;
            layer = Layer.KINEMATIC;
            break;
        case 'rig':
            motionType = jolt.EMotionType_Dynamic;
            layer = Layer.RIG;
            //rigs need to have no gravity
            // TODO fix these type warnings
            /*
            if (!options?.mGravityFactor) {
                if (!options?.bodySettings) options.bodySettings = {};
                options!.bodySettings.mGravityFactor = 0;
            }*/
            break;

        default:
            motionType = jolt.EMotionType_Dynamic;
            layer = Layer.MOVING;
    }
    // if the user specefied a motionType we need to override the last switch
    if (options?.motionType) {
        switch (options.motionType) {
            case 'static':
                motionType = jolt.EMotionType_Static;
                break;
            case 'kinematic':
                motionType = jolt.EMotionType_Kinematic;
                layer = Layer.KINEMATIC;
                break;
            default:
                motionType = jolt.EMotionType_Dynamic;
                layer = Layer.MOVING;
        }
    }
    const isDynamic = motionType === jolt.EMotionType_Dynamic;
    // #112: jolt cannot simulate a dynamic body with a MeshShape - mesh vs mesh has no collision,
    // so the body falls through the world and its position goes NaN. Convert the mesh away here,
    // while we still know the motion type. https://jrouwe.github.io/JoltPhysics/#dynamic-mesh-shapes
    const meshStrategy = options.dynamicMeshStrategy ?? 'convex';
    let shape: Jolt.Shape;
    if (isObject) {
        // one place decides what this object is; when the body is dynamic, any trimesh in that
        // description becomes a convex hull before anything is allocated
        const described = describeObject(object, { type: options.shapeType });
        const descriptor = isDynamic
            ? makeDescriptorDynamicSafe(described, meshStrategy)
            : described;
        if (describedShape) describedShape.descriptor = descriptor;
        // takes ownership of the settings (and of any sub-settings they reference) and gives us
        // a shape we hold one reference on - released below, once the BodyCreationSettings has
        // taken its own.
        shape = createShapeFromSettings(createShapeSettings(descriptor));
    } else {
        shape = object as Jolt.Shape;
        // a caller who handed us a ready made shape (a <Shape> child, say) gets the same
        // treatment, from the shape's own triangles
        if (isDynamic && shape.GetSubType() === jolt.EShapeSubType_Mesh) {
            // same policy (and the same messages) as the descriptor path above
            checkDynamicMeshStrategy(meshStrategy);
            shape = convexHullFromShape(shape);
            ownsShape = true;
        }
    }

    // create the settings
    const baseSettings = new jolt.BodyCreationSettings(
        shape,
        position,
        quaternion,
        motionType,
        layer
    );
    // Issue #210: Jolt only runs narrowphase on a pair when at least one side is Dynamic, so by
    // default a kinematic body (Layer.KINEMATIC) never generates contacts against a static body
    // or another kinematic one, no matter what the object layer pair filter allows - a moving
    // platform would silently pass through a wall or another platform. This flag opts it in;
    // `options.bodySettings` below can still override it explicitly.
    if (motionType === jolt.EMotionType_Kinematic)
        baseSettings.mCollideKinematicVsNonDynamic = true;
    const settings = mergeBodyCreationSettings(baseSettings, options.bodySettings);
    // `GetMassProperties()` hands back a static temporary: read it, never destroy it.
    const shapeMass = isDynamic ? shape.GetMassProperties().mMass : 0;
    if (isDynamic && options.mass !== undefined && shapeMass > 0) {
        // #201 (and #112, which is the convex hull case of the same thing): the shape's own mass
        // properties describe its distribution correctly, so scale those to the requested mass
        // rather than pretending the body is a solid box - or, as before this, ignoring
        // `options.mass` altogether on everything but a converted trimesh.
        const massProperties = shape.GetMassProperties();
        settings.mOverrideMassProperties = jolt.EOverrideMassProperties_MassAndInertiaProvided;
        settings.mMassPropertiesOverride.mMass = massProperties.mMass;
        settings.mMassPropertiesOverride.mInertia = massProperties.mInertia;
        settings.mMassPropertiesOverride.ScaleToMass(options.mass);
    } else if (isDynamic && shape.GetSubType() === jolt.EShapeSubType_Mesh) {
        // belt and braces: a strategy that somehow left a mesh in place still needs *some* mass
        // and inertia, or the body has none at all
        settings.mOverrideMassProperties = jolt.EOverrideMassProperties_MassAndInertiaProvided;
        let size: THREE.Vector3 = options?.size || new THREE.Vector3(1, 1, 1);
        const mass = options?.mass || 200;
        if (isObject) size = new THREE.Box3().setFromObject(object).getSize(new Vector3());
        // `vec3.jolt` always allocates a vector we own; `SetMassAndInertiaOfSolidBox` copies it,
        // so scope it rather than leaking one Vec3 per dynamic trimesh body.
        withJolt(size, (v) =>
            settings.mMassPropertiesOverride.SetMassAndInertiaOfSolidBox(v, mass)
        );
    }
    // destroy the position and quaternion
    jolt.destroy(position);
    jolt.destroy(quaternion);
    // the settings hold their own reference to a shape we created here
    if (ownsShape) releaseShape(shape);

    return settings;
}

// TODO: my base generators require three objects. perhaps abastract out or make better names

// Changing a body's mass after creation lives on `BodyState.mass` now (issue #201). What used to
// be here rebuilt a MassProperties from the *shape* and pushed it through
// `SetMassProperties(EAllowedDOFs_All, ...)`, which threw away any locked degrees of freedom and
// ignored a mass override the body had been created with.
// src:PhoenixIllusion @ https://github.com/jrouwe/JoltPhysics.js/discussions/112
/* og
export function changeMassInertia(body: Jolt.Body, mass: number) {
    const motionProps = body.GetMotionProperties();
    const massProps = body.GetShape().GetMassProperties();
    const inertia = massProps.mInertia;
    let mass_scale = massProps.mMass;
    if (mass_scale > 0) {
        mass_scale = mass / massProps.mMass;
    } else {
        mass_scale = mass;
    }
    inertia.SetAxisX(inertia.GetAxisX().Mul(mass_scale));
    inertia.SetAxisY(inertia.GetAxisY().Mul(mass_scale));
    inertia.SetAxisZ(inertia.GetAxisZ().Mul(mass_scale));
    massProps.mMass = mass;
    massProps.mInertia = inertia;
    motionProps.SetMassProperties(Raw.module.EAllowedDOFs_All, massProps);
}
*/

// When debugging we need to create a three debug object
// initially pulled from Jolt Demo,
export function getThreeObjectForBody(body: Jolt.Body, color = '#E07A5F') {
    let shape = body.GetShape();
    // lets see if we can get the material color by the shape
    // TODO this isn't in Jolt.js yet.

    //const physicsMaterial: Jolt.PhysicsMaterial = shape.GetMaterial();
    //const pmColor = physicsMaterial.GetDebugColor();
    const material = new THREE.MeshPhongMaterial({
        color: color,
        wireframe: true
    });

    let threeObject: THREE.Mesh;

    // Each branch downcasts into its own local instead of writing the subclass back over
    // `shape` (which stays typed as the base `Jolt.Shape`, which is what made every accessor
    // below need a suppression). `castObject` re-wraps the same pointer, so these are views -
    // nothing to free, and `shape` itself still refers to the same object afterwards.
    let extent: THREE.Vector3;
    switch (shape.GetSubType()) {
        case Raw.module.EShapeSubType_Box: {
            const box = castObject(shape, Raw.module.BoxShape);
            extent = vec3.three(box.GetHalfExtent()).multiplyScalar(2);
            threeObject = new THREE.Mesh(
                new THREE.BoxGeometry(extent.x, extent.y, extent.z, 1, 1, 1),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Sphere: {
            const sphere = castObject(shape, Raw.module.SphereShape);
            threeObject = new THREE.Mesh(
                new THREE.SphereGeometry(sphere.GetRadius(), 32, 32),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Capsule: {
            const capsule = castObject(shape, Raw.module.CapsuleShape);
            threeObject = new THREE.Mesh(
                new THREE.CapsuleGeometry(
                    capsule.GetRadius(),
                    2 * capsule.GetHalfHeightOfCylinder(),
                    20,
                    10
                ),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Cylinder: {
            const cylinder = castObject(shape, Raw.module.CylinderShape);
            threeObject = new THREE.Mesh(
                new THREE.CylinderGeometry(
                    cylinder.GetRadius(),
                    cylinder.GetRadius(),
                    2 * cylinder.GetHalfHeight(),
                    20,
                    1
                ),
                material
            );
            break;
        }
        default:
            threeObject = new THREE.Mesh(createMeshForShape(shape), material);
            break;
    }
    // todo: these may not be needed. When used to create a debug shape this is actually wrong
    threeObject.position.copy(vec3.three(body.GetPosition()));
    threeObject.quaternion.copy(quat.joltToThree(body.GetRotation()));

    return threeObject;
}
