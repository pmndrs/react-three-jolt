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
import { Raw } from '../raw';
import { devWarn, quat, vec3, withJolt } from '../utils';
import { BodyState } from './body-state';
import type { ConstraintSystem } from './constraint-system';
import {
    ContactEventQueue,
    ContactPairTracker,
    EventKind,
    FLUSH_ORDER,
    KIND_EVENT,
    PayloadPool
} from './contact-events';
import type { Emitter } from './emitter';
import { type CollisionTarget, EventBit, type ValidatePayload, type WorldEventMap } from './events';
import {
    type AutoShape,
    checkDynamicMeshStrategy,
    convexHullFromShape,
    createMeshForShape,
    createShapeFromSettings,
    createShapeSettings,
    type DynamicMeshStrategy,
    describeObject,
    generateHeightfieldShapeFromThree,
    makeDescriptorDynamicSafe,
    releaseShape,
    ShapeSystem
} from './shape-system';

// TYPES ========================================
export type BodyType = 'dynamic' | 'static' | 'kinematic' | 'rig';
export type PendingAction = { action: string; handle: number; value: any };

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

    joltPhysicsSystem: Jolt.PhysicsSystem;
    bodyInterface: Jolt.BodyInterface;

    shapeSystem: ShapeSystem;

    // lets defaults be set at the physics system level
    defaultBodySettings: any = {};
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
     * `BodyInterface.SetCollisionGroup`. A sleeping body is woken so the new filtering is applied
     * on the next step rather than whenever something else happens to touch it.
     */
    setBodyCollisionGroup(bodyHandle: number, group?: number, subGroup?: number) {
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
        let settings = generateBodySettings(objectOrShape, options);
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
        this.bodies.delete(bodyHandle);
        this.dynamicBodies.delete(bodyHandle);
        this.staticBodies.delete(bodyHandle);
        this.kinematicBodies.delete(bodyHandle);
    }

    // There's probably a better pattern, but im making my own function for this
    public addHeightfield(planeMesh: THREE.Mesh): number {
        //const position = vec3.threeToJolt(planeMesh.position);
        // const quaternion = quat.threeToJolt(planeMesh.quaternion);
        const shapeSettings = generateHeightfieldShapeFromThree(planeMesh);
        //const position = new Raw.module.Vec3(0, -20, 0); // The image tends towards 'white', so offset it down closer to zero
        const quaternion = new Raw.module.Quat(0, 0, 0, 1);
        const size = shapeSettings.mSampleCount;
        //@ts-expect-error  yes it does exist
        const planeWidth = planeMesh.geometry.parameters.width;
        const scale = planeWidth / size;
        const offset = -size * scale * 0.5;
        const position = new Raw.module.RVec3(
            offset + planeMesh.position.x,
            planeMesh.position.y,
            planeMesh.position.z + offset
        );

        // this destroys the shapeSettings and hands back a shape we hold a reference on
        const shape = createShapeFromSettings(shapeSettings);
        const creationSettings = new Raw.module.BodyCreationSettings(
            shape,
            position,
            quaternion,
            Raw.module.EMotionType_Static,
            Layer.NON_MOVING
        );
        const body = this.bodyInterface.CreateBody(creationSettings);
        // cleanup before returning. The body holds its own reference to the shape and the
        // creation settings copied the transform, so all of this is ours to free.
        this.jolt.destroy(creationSettings);
        this.jolt.destroy(position);
        this.jolt.destroy(quaternion);
        releaseShape(shape);
        return this.addExistingBody(planeMesh, body, { bodyType: 'static' });
    }
    //* Body Modification ===================================
    // change the mass of a body
    setMass(bodyHandle: number, mass: number) {
        const body = this.getBody(bodyHandle);
        if (!body) return;
        changeMassInertia(body.body, mass);
    }

    //* Loop Functions ===================================
    createPendingAction(action: string, handle: number, value: any) {
        this.pendingActions.push({ action, handle, value });
    }
    handlePendingActions() {
        if (!this.pendingActions.length) return;
        // { action: string, handle: number, value: any }
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
    private initializeContactListeners() {
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
        // biome-ignore lint/suspicious/noExplicitAny: one builder for both payload shapes
    ): any {
        const queue = this.eventQueue;
        const handle1 = queue.handle1(index);
        const handle2 = queue.handle2(index);
        const withManifold = type === 'collisionEnter' || type === 'collisionPersist';
        // biome-ignore lint/suspicious/noExplicitAny: the two payload shapes share a builder
        const payload: any = withManifold
            ? this.payloads.acquireEnter()
            : this.payloads.acquireBasic();

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

        if (withManifold) {
            // Jolt's normal points from body 1 toward body 2; ours points from `other` toward
            // `target`, i.e. the direction `target` moves to separate.
            const sign = flipped ? 1 : -1;
            payload.normal.set(
                queue.normalX(index) * sign,
                queue.normalY(index) * sign,
                queue.normalZ(index) * sign
            );
            payload.penetration = queue.penetration(index);
            const points = queue.pointCount(index);
            payload.pointCount = points;
            this.payloads.sizePoints(payload, points);
            for (let i = 0; i < points; i++) queue.readPoint(index, i, payload.points[i]);
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
        this.pendingActions = [];
        // Our own allocations, not listeners installed on the JoltInterface: these are freed even
        // when the interface belongs to another world (issue #95).
        this.collisionGroups.forEach((collisionGroup) => Raw.module.destroy(collisionGroup));
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
    options?: Jolt.BodyCreationSettings
) {
    if (!options) return settings;
    // loop over the object keys and set the settings
    for (const key in options) {
        // @ts-expect-error
        settings[key] = options[key];
    }
    return settings;
}

export function generateBodySettings(
    object: Object3D | Jolt.Shape,
    options: GenerateBodyOptions = {}
): Jolt.BodyCreationSettings {
    const jolt = Raw.module;
    const isObject = object instanceof Object3D;
    // whether the shape below is one we created (and therefore have to release again)
    let ownsShape = isObject;

    // create position and quaternion from three to jolt
    let position: any = new THREE.Vector3();
    let quaternion: any = new THREE.Quaternion();
    if (isObject) {
        position.copy(object.position);
        quaternion.copy(object.quaternion);
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
        position.add(jitter);
        // jitter the rotation too
        quaternion.setFromEuler(
            new THREE.Euler(
                Math.random() * options.jitter.x,
                Math.random() * options.jitter.y,
                Math.random() * options.jitter.z
            )
        );
    }
    // reset the items to jolt types
    // BodyCreationSettings takes an RVec3 world space position in jolt-physics >=1.0
    position = vec3.rjolt(position);
    quaternion = quat.threeToJolt(quaternion);

    // type bases on bodyType (Dynamic by default)
    let layer, motionType;
    switch (options.bodyType) {
        case 'static':
            motionType = jolt.EMotionType_Static;
            layer = Layer.NON_MOVING;
            break;
        case 'kinematic':
            motionType = jolt.EMotionType_Kinematic;
            layer = Layer.MOVING;
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
    let convertedFromMesh = false;
    if (isObject) {
        // one place decides what this object is; when the body is dynamic, any trimesh in that
        // description becomes a convex hull before anything is allocated
        const described = describeObject(object, { type: options.shapeType });
        const descriptor = isDynamic
            ? makeDescriptorDynamicSafe(described, meshStrategy)
            : described;
        convertedFromMesh = descriptor !== described;
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
            convertedFromMesh = true;
        }
    }

    // create the settings
    const settings = mergeBodyCreationSettings(
        new jolt.BodyCreationSettings(shape, position, quaternion, motionType, layer),
        options.bodySettings
    );
    if (convertedFromMesh && options.mass !== undefined) {
        // #112: the shape is a real convex hull now, so its own mass properties are meaningful -
        // scale those to the requested mass instead of pretending the body is a solid box.
        // `GetMassProperties()` hands back a static temporary: read it, never destroy it.
        const massProperties = shape.GetMassProperties();
        settings.mOverrideMassProperties = jolt.EOverrideMassProperties_MassAndInertiaProvided;
        settings.mMassPropertiesOverride.mMass = massProperties.mMass;
        settings.mMassPropertiesOverride.mInertia = massProperties.mInertia;
        settings.mMassPropertiesOverride.ScaleToMass(options.mass);
    } else if (isDynamic && shape.GetSubType() === jolt.EShapeSubType_Mesh) {
        // belt and braces: a strategy that somehow left a mesh in place still needs *some* mass
        // and inertia, or the body has none at all
        settings.mOverrideMassProperties = jolt.EOverrideMassProperties_MassAndInertiaProvided;
        let size: any = options?.size || new THREE.Vector3(1, 1, 1);
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

// Change a bodies mass settings after already being created
// src:PhoenixIllusion @ https://github.com/jrouwe/JoltPhysics.js/discussions/112
function changeMassInertia(body: Jolt.Body, mass: number) {
    const motionProps = body.GetMotionProperties();
    const massProps = body.GetShape().GetMassProperties();
    massProps.ScaleToMass(mass); //<--- newly exposed function
    motionProps.SetMassProperties(Raw.module.EAllowedDOFs_All, massProps);
}
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

    let threeObject;

    let extent;
    switch (shape.GetSubType()) {
        case Raw.module.EShapeSubType_Box:
            shape = Raw.module.castObject(shape, Raw.module.BoxShape);
            //@ts-expect-error
            extent = vec3.three(shape.GetHalfExtent()).multiplyScalar(2);
            threeObject = new THREE.Mesh(
                new THREE.BoxGeometry(extent.x, extent.y, extent.z, 1, 1, 1),
                material
            );
            break;
        case Raw.module.EShapeSubType_Sphere:
            shape = Raw.module.castObject(shape, Raw.module.SphereShape);
            threeObject = new THREE.Mesh(
                //@ts-expect-error
                new THREE.SphereGeometry(shape.GetRadius(), 32, 32),
                material
            );
            break;
        case Raw.module.EShapeSubType_Capsule:
            shape = Raw.module.castObject(shape, Raw.module.CapsuleShape);
            threeObject = new THREE.Mesh(
                new THREE.CapsuleGeometry(
                    //@ts-expect-error
                    shape.GetRadius(),
                    //@ts-expect-error
                    2 * shape.GetHalfHeightOfCylinder(),
                    20,
                    10
                ),
                material
            );
            break;
        case Raw.module.EShapeSubType_Cylinder:
            shape = Raw.module.castObject(shape, Raw.module.CylinderShape);
            threeObject = new THREE.Mesh(
                new THREE.CylinderGeometry(
                    //@ts-expect-error
                    shape.GetRadius(),
                    //@ts-expect-error
                    shape.GetRadius(),
                    //@ts-expect-error
                    2 * shape.GetHalfHeight(),
                    20,
                    1
                ),
                material
            );
            break;
        default:
            threeObject = new THREE.Mesh(createMeshForShape(shape), material);
            break;
    }
    // todo: these may not be needed. When used to create a debug shape this is actually wrong
    threeObject.position.copy(vec3.three(body.GetPosition()));
    threeObject.quaternion.copy(quat.joltToThree(body.GetRotation()));

    return threeObject;
}
