// This class holds the bodies and the management of them
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import {
    InstancedMesh,
    //MathUtils,
    Matrix4,
    Object3D,
    Quaternion,
    Vector3
} from 'three';
import type { SurfaceMaterialTable } from '../heightField/materials';
import { Raw } from '../raw';

import { anyVec3, devWarn, joltScratch, quat, vec3 } from '../utils';
import { type BodySystem, getThreeObjectForBody } from './body-system';
import { Emitter, type Unsubscribe } from './emitter';
import { BODY_EVENT_BITS, type BodyEventMap, EventBit } from './events';
import {
    addSubShape,
    asMutableCompoundShape,
    isMutableCompoundShape,
    modifySubShape,
    readCenterOfMass,
    releaseShape,
    removeSubShape,
    type ShapeDescriptor,
    type SubShapeTransform,
    scaleShape,
    type Vec3Tuple,
    validScaleFor
} from './shape-system';

// Initital body object copied from r3/rapier's state object
export class BodyState {
    meshType: 'instancedMesh' | 'mesh';
    body: Jolt.Body;
    BodyID: Jolt.BodyID;
    object: Object3D | THREE.InstancedMesh;
    debugMesh?: Object3D;
    invertedWorldMatrix: Matrix4;
    handle: number;
    index?: number;
    activeScale = new THREE.Vector3(1, 1, 1);
    isDebugging = false;

    // obstruction and collision
    allowObstruction = true; // temporarily block obstruction
    obstructionType: 'any' | 'temporal' = 'any';
    obstructionTimelimit = 5000;
    allowCollision = false;

    // for conveyor systems willl be replaced with impulse source
    isConveyor = false;
    conveyorVector?: THREE.Vector3;
    isTeleporter = false;
    teleporterVector?: THREE.Vector3;

    //* motionSource Props ===================================
    //todo: should these be on their own class?
    isMotionSource = false;
    motionActive = false;
    useRotation = true;
    motionLinearVector?: THREE.Vector3;
    motionAngularVector?: THREE.Vector3;
    motionType: 'linear' | 'angular' = 'linear';
    motionAsSurfaceVelocity = false;

    //* Surface materials (issue #46) ========================
    /**
     * Per-surface friction/restitution for a shape whose sub-shapes carry Jolt materials - in
     * practice a heightfield built with `materials`. Set through {@link setSurfaceMaterials};
     * read inside the contact callback, which is the only place friction can be changed.
     */
    surfaceMaterials?: SurfaceMaterialTable;

    get isSleeping() {
        return !this.body.IsActive();
    }
    // TODO: change to this one that doesn't require setting meshType
    //const isInstance = (object: any): object is THREE.InstancedMesh => object.isInstancedMesh

    get isInstance() {
        return this.meshType === 'instancedMesh';
    }

    /**
     * True for a body Jolt will never move on its own (`type="static"`).
     *
     * Static bodies *can* still be moved from the outside - see the `position` / `rotation`
     * setters - they are simply never simulated, never active, and therefore never visited by
     * the render sync loop.
     */
    get isStatic() {
        return this.body.IsStatic();
    }

    /**
     * Open sub-shape manifolds per peer handle, maintained by `BodySystem`'s contact listener.
     * Derived state - write through the listener, read through {@link isContacting}.
     */
    contacts: Map<number, number> = new Map();

    /**
     * The description this body's shape was built from, when it was built from one (`<Shape>`
     * and the `describeObject` path both set it; a body handed a ready made `Jolt.Shape` has
     * none). Only used to answer `payload.targetSubShape.descriptor` - issue #13.
     */
    shapeDescriptor?: ShapeDescriptor;

    // Listeners ----------------------------------
    /**
     * This body's events. `on(type, fn)` returns the unsubscribe; the named helpers below are
     * one-line sugar for the same thing, spelled exactly like the `<RigidBody>` props.
     */
    readonly events = new Emitter<BodyEventMap>(BODY_EVENT_BITS);
    /** Bits that are set for library-internal reasons, e.g. an active motion source. */
    private internalMask = 0;
    /** True once `dispose()` has run; the body is on its way out of the simulation. */
    disposed = false;

    /**
     * What this body is listening for, as a bitfield. Read inside the Jolt contact callback to
     * decide whether a manifold is worth wrapping at all.
     */
    get eventMask(): number {
        return this.events.mask | this.internalMask;
    }

    // References so we can modify the body directly.
    // (`joltPhysicsSystem` used to be held here too, untyped behind a `@ts-ignore`, and was
    // never read - only `bodyInterface`, derived from it in the constructor, ever is.)
    private bodyInterface: Jolt.BodyInterface;
    private bodySystem: BodySystem;
    //private collisionGroupChanged = false;
    // true once `set color` has cloned this (non-instanced) body's material so it stops sharing
    // it with whatever else was originally assigned it - see `set color` and `destroy()`.
    private ownsMaterial = false;

    constructor(
        object: Object3D | InstancedMesh,
        body: Jolt.Body,
        joltPhysicsSystem: Jolt.PhysicsSystem,
        bodySystem: BodySystem,
        index?: number
    ) {
        this.object = object;
        this.body = body;
        this.BodyID = body.GetID();
        this.handle = this.BodyID.GetIndexAndSequenceNumber();

        // Instance properties
        this.meshType = object instanceof InstancedMesh ? 'instancedMesh' : 'mesh';
        this.invertedWorldMatrix = object.matrixWorld.clone().invert();
        if (index !== undefined) this.index = index;

        // not sure this is a good idea here
        this.object.userData.body = body;
        this.object.userData.bodyHandle = this.handle;

        // set the references for direct manipulation
        this.bodySystem = bodySystem;
        this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
    }

    //* Activation & Contact Listeners ===================================
    /** Subscribe to one of this body's events. Returns the unsubscribe. */
    on<K extends keyof BodyEventMap>(type: K, fn: BodyEventMap[K]): Unsubscribe {
        return this.events.on(type, fn);
    }
    /** Fires once when this body starts touching another. */
    onCollisionEnter(fn: BodyEventMap['collisionEnter']): Unsubscribe {
        return this.events.on('collisionEnter', fn);
    }
    /** Fires every step the contact is maintained. Free from Jolt; zero cost when unused. */
    onCollisionPersist(fn: BodyEventMap['collisionPersist']): Unsubscribe {
        return this.events.on('collisionPersist', fn);
    }
    /** Fires once when the last sub-shape manifold between the two bodies closes. */
    onCollisionExit(fn: BodyEventMap['collisionExit']): Unsubscribe {
        return this.events.on('collisionExit', fn);
    }
    onSensorEnter(fn: BodyEventMap['sensorEnter']): Unsubscribe {
        return this.events.on('sensorEnter', fn);
    }
    onSensorExit(fn: BodyEventMap['sensorExit']): Unsubscribe {
        return this.events.on('sensorExit', fn);
    }
    onSleep(fn: BodyEventMap['sleep']): Unsubscribe {
        return this.events.on('sleep', fn);
    }
    onWake(fn: BodyEventMap['wake']): Unsubscribe {
        return this.events.on('wake', fn);
    }
    /** Synchronous, inside the step. Return false to reject the contact. See docs/events.md. */
    onContactValidate(fn: BodyEventMap['contactValidate']): Unsubscribe {
        return this.events.on('contactValidate', fn);
    }

    /** Back compat so the deprecated identity-based removers can still find their handles. */
    private legacySubs = new Map<Function, Unsubscribe[]>();
    private trackLegacy(listener: Function, off: Unsubscribe): Unsubscribe {
        const subs = this.legacySubs.get(listener);
        if (subs) subs.push(off);
        else this.legacySubs.set(listener, [off]);
        return off;
    }
    private removeLegacy(listener: Function): void {
        const subs = this.legacySubs.get(listener);
        if (!subs) return;
        this.legacySubs.delete(listener);
        for (const off of subs) off();
    }

    /**
     * @deprecated use {@link onSleep} / {@link onWake}, which tell the two apart. This fires
     * for both, as it always did.
     */
    addActivationListener(listener: Function): Unsubscribe {
        const handler = () => listener(this);
        const offSleep = this.events.on('sleep', handler);
        const offWake = this.events.on('wake', handler);
        return this.trackLegacy(listener, () => {
            offSleep();
            offWake();
        });
    }
    /** @deprecated keep the function {@link addActivationListener} returns. */
    removeActivationListener(listener: Function) {
        this.removeLegacy(listener);
    }
    /**
     * @deprecated use {@link on}. The handler now receives a single payload object rather than
     * `(handle1, handle2, manifold, settings, count, context)` - the old arguments handed out
     * Jolt pointers that are freed before the handler could run.
     */
    addContactListener(listener: Function, type: 'added' | 'removed' | 'persisted'): Unsubscribe {
        const event =
            type === 'added'
                ? 'collisionEnter'
                : type === 'removed'
                  ? 'collisionExit'
                  : 'collisionPersist';
        return this.trackLegacy(listener, this.events.on(event, listener as never));
    }
    /**
     * @deprecated keep the function {@link addContactListener} returns.
     *
     * Removes the listener from *every* channel it was added to. The old implementation used an
     * `else if` chain, so a function registered for both `"added"` and `"persisted"` - which
     * `activateMotionSource` did - could only ever be removed from the first.
     */
    removeContactListener(listener: Function) {
        this.removeLegacy(listener);
    }
    // get the value of a contact pair
    isContacting(handle: number) {
        return this.contacts.get(handle) || 0;
    }

    /**
     * Leave the simulation cleanly: close every open contact pair (peers get their exit event),
     * drop every listener, and forget the contact bookkeeping. Called by
     * `BodySystem.removeBody` before the body is removed from Jolt.
     *
     * Without this, a recycled handle inherits the previous body's open pairs and its peers
     * never learn the contact ended.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.contacts.size)
            this.bodySystem.closeContactsFor(this.handle, [...this.contacts.keys()]);
        this.contacts.clear();
        this.events.clear();
        this.legacySubs.clear();
        this.internalMask = 0;
        // the jolt materials themselves are owned by the shape and go with it; this only frees
        // the scratch SubShapeID and drops the pointer map (whose pointers are about to be
        // recycled by jolt anyway)
        this.surfaceMaterials?.dispose();
        this.surfaceMaterials = undefined;
    }
    //* Interpolation pose cache ==============================
    /*
    These hold the two most recent *world space* physics poses of this body so the render frame
    can interpolate between them (see PhysicsSystem.onUpdate). Everything here is preallocated
    and written in place: the frame loop touches every awake body every frame, so it is not
    allowed to allocate. Do not replace these objects, copy into them.
    */
    /** World space pose produced by the physics step before the most recent one. */
    readonly previousPosition = new Vector3();
    readonly previousRotation = new Quaternion();
    /** World space pose produced by the most recent physics step. */
    readonly currentPosition = new Vector3();
    readonly currentRotation = new Quaternion();
    /** False until `capturePose` has run at least once; until then there is nothing to lerp. */
    poseCacheValid = false;
    // scratch matrix for instanced writes, reused so `update` never allocates
    private instanceMatrix = new Matrix4();

    /**
     * Snapshot the body's pose at the end of a physics step. Shifts the previous snapshot down
     * so `previous*` / `current*` always bracket the last step. Allocation free.
     */
    capturePose() {
        if (this.poseCacheValid) {
            this.previousPosition.copy(this.currentPosition);
            this.previousRotation.copy(this.currentRotation);
        }
        vec3.joltToThree(this.body.GetPosition(), this.currentPosition);
        quat.joltToThree(this.body.GetRotation(), this.currentRotation);
        // the first capture has no history, so start from a standstill instead of lerping in
        // from the origin
        if (!this.poseCacheValid) {
            this.previousPosition.copy(this.currentPosition);
            this.previousRotation.copy(this.currentRotation);
            this.poseCacheValid = true;
        }
    }
    /** Drop the pose history, e.g. after a teleport, so the next frame does not lerp across it. */
    resetPoseCache() {
        this.poseCacheValid = false;
    }
    /**
     * Write the world pose `alpha` of the way between the last two physics steps into the
     * supplied objects. Allocation free; the caller owns the output.
     */
    getInterpolatedPose(alpha: number, outPosition: Vector3, outRotation: Quaternion) {
        outPosition.lerpVectors(this.previousPosition, this.currentPosition, alpha);
        outRotation.copy(this.previousRotation).slerp(this.currentRotation, alpha);
    }
    /**
     * Write the body's live world pose into the supplied objects. Allocation free; this is the
     * hot loop equivalent of the `position` / `rotation` getters, which allocate.
     */
    readPose(outPosition: Vector3, outRotation: Quaternion) {
        vec3.joltToThree(this.body.GetPosition(), outPosition);
        quat.joltToThree(this.body.GetRotation(), outRotation);
    }

    //* Updates ===============================================
    //this will be called in loop functions
    update(position: anyVec3, rotation: Jolt.Quat | THREE.Quaternion) {
        // if this is a mesh, use basic updates
        if (!this.isInstance) {
            this.object.position.copy(vec3.three(position));
            this.object.quaternion.copy(quat.three(rotation));
            return;
        }
        // we are an instance. we have to build a matrix
        const matrix = this.instanceMatrix;
        matrix.compose(vec3.three(position), quat.three(rotation), vec3.three(this.scale));
        // update the matrix
        this.setMatrix(matrix);
    }
    //* Shapes ===============================================
    // get the shape of the body
    get shape() {
        return this.body.GetShape();
    }
    // set the shape of the body
    set shape(shape: Jolt.Shape) {
        this.bodyInterface.SetShape(this.BodyID, shape, false, Raw.module.EActivation_Activate);
        // update the debug object if it exists
        if (this.debugMesh) this.updateDebugMesh();
        this.bodySystem.worldEvents?.emit('shapeChanged', this);
    }

    //* Mutable compounds (issue #108) ========================
    /**
     * True when this body's shape is a `MutableCompoundShape`, i.e. when `addSubShape`,
     * `removeSubShape` and `modifySubShape` can be used on it. Build one with a
     * `{ type: 'mutableCompound' }` descriptor or a `<Shape dynamic>`.
     */
    get isMutableCompound() {
        return isMutableCompoundShape(this.shape);
    }
    /** The body's shape as a `MutableCompoundShape`. Throws when it is anything else. */
    get mutableCompound(): Jolt.MutableCompoundShape {
        return asMutableCompoundShape(this.shape);
    }

    /**
     * Tell Jolt the shape this body holds changed underneath it.
     *
     * Editing a `MutableCompoundShape` in place does not touch the body, so its broadphase bounds
     * and its mass properties would both go stale: the body would collide against the shape it
     * had when it was created. `NotifyShapeChanged` re-inserts it in the broadphase and (with
     * `updateMassProperties`) recomputes mass and inertia from the new shape.
     *
     * @param previousCenterOfMass the shape's centre of mass *before* the edit - Jolt moves the
     * body so the shape stays where it was. Read it with `readCenterOfMass(body.shape)` before
     * editing; it defaults to the current one, which is only right if the edit did not move it.
     */
    notifyShapeChanged(
        previousCenterOfMass: Vec3Tuple = readCenterOfMass(this.shape),
        updateMassProperties = true
    ) {
        // NotifyShapeChanged takes the vector by value, so the shared scratch is safe here
        this.bodyInterface.NotifyShapeChanged(
            this.BodyID,
            joltScratch.vec3(previousCenterOfMass),
            updateMassProperties,
            Raw.module.EActivation_Activate
        );
        if (this.debugMesh) this.updateDebugMesh();
        // An in-place compound edit keeps the same shape pointer, so a geometry cache keyed on
        // that pointer cannot see it. This is the only notification there is (issue #158).
        this.bodySystem.worldEvents?.emit('shapeChanged', this);
    }

    /**
     * Add a shape to this body's mutable compound and return its index.
     *
     * The descriptor's `position`/`rotation` place it inside the compound. The compound owns the
     * new sub shape; drop it again with `removeSubShape(index)`, never by hand.
     */
    addSubShape(descriptor: ShapeDescriptor): number {
        const compound = this.mutableCompound;
        const previousCenterOfMass = readCenterOfMass(compound);
        const index = addSubShape(compound, descriptor);
        this.notifyShapeChanged(previousCenterOfMass);
        return index;
    }

    /**
     * Remove the sub shape at `index`. Every index above it shifts down by one, so a caller
     * holding several indices should remove from the back.
     */
    removeSubShape(index: number) {
        const compound = this.mutableCompound;
        const previousCenterOfMass = readCenterOfMass(compound);
        removeSubShape(compound, index);
        this.notifyShapeChanged(previousCenterOfMass);
    }

    /** Move and/or turn the sub shape at `index`; anything left out keeps its current value. */
    modifySubShape(index: number, transform: SubShapeTransform) {
        const compound = this.mutableCompound;
        const previousCenterOfMass = readCenterOfMass(compound);
        modifySubShape(compound, index, transform);
        this.notifyShapeChanged(previousCenterOfMass);
    }

    //* Debugging ===============================================
    updateDebugMesh() {
        const newMesh = getThreeObjectForBody(this.body);
        // reset any weird position data
        newMesh.position.set(0, 0, 0);
        newMesh.rotation.set(0, 0, 0);
        // we have to put an inverted scale on the newMesh so it matches the actual body

        newMesh.scale.copy(new THREE.Vector3(1, 1, 1).divide(this.activeScale));
        // if the current object is visible it will have a parent
        const currentParent = this.debugMesh?.parent;
        if (currentParent) currentParent.remove(this.debugMesh!);
        this.debugMesh = newMesh;
        if (currentParent) currentParent.add(this.debugMesh);
    }
    // get and set debugging
    get debug() {
        return this.isDebugging;
    }
    set debug(newDebug: boolean) {
        //if we are already debugging stop by removing from the object
        if (!newDebug) {
            this.object.remove(this.debugMesh!);
            this.isDebugging = false;
            return;
        }
        // check if the debug mesh already exists
        if (!this.debugMesh) this.updateDebugMesh();
        // add the debug mesh to the object
        this.object.add(this.debugMesh!);
        this.isDebugging = true;
    }

    //* Direct Manipulation ===================================
    // destroy the body
    destroy(ignoreThree?: boolean) {
        this.bodySystem.removeBody(this.handle, ignoreThree);
        // only dispose the material if `set color` cloned it for us - anything else is still
        // whatever the caller (or another body sharing the same mesh/material) put there.
        if (this.ownsMaterial && !this.isInstance) {
            const mesh = this.object as THREE.Mesh;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of materials) material?.dispose();
        }
    }
    // probably only used for instances
    getMatrix(matrix: Matrix4) {
        if (this.isInstance) {
            const object = this.object as THREE.InstancedMesh;
            object.getMatrixAt(this.index!, matrix);
        } else matrix.copy(this.object.matrixWorld);
        return matrix;
    }
    setMatrix(matrix: Matrix4) {
        if (this.isInstance) {
            const object = this.object as THREE.InstancedMesh;
            object.setMatrixAt(this.index!, matrix);
            object.instanceMatrix.needsUpdate = true;
        } else {
            this.object.matrix.copy(matrix);
            this.object.updateMatrixWorld(true);
        }
        // TODO: determine if we will really use this or not
        /*
        // now that the threeJS object is updated, we need to set the jolt body
        if (!ignoreJolt) {
            const position = this.object.position.clone();
            const rotation = this.object.quaternion.clone();
            this.position = position;
            this.rotation = rotation;
        }
        */
    }

    /**
     * Move the body. Works on every motion type, **including static bodies** (issue #61):
     * `SetPosition` updates the broadphase, and the three.js object is brought along by the
     * dirty-static drain in `PhysicsSystem.onUpdate`, since the frame loop only walks bodies
     * that can be awake.
     *
     * Moving a static body every frame is an anti pattern - it teleports, so nothing resting on
     * it is carried, sleeping neighbours are not woken, and contacts are resolved as if the body
     * had always been there. Use `type="kinematic"` with {@link setKinematicTarget} (or
     * {@link moveKinematic}) for anything that moves repeatedly; statics are for the occasional
     * reposition of scenery.
     */
    // `SetPosition` takes an RVec3Arg and copies it, so the shared scratch vector is safe here
    // and keeps this setter allocation free - it is driven from useFrame by user code.
    set position(position) {
        this.bodyInterface.SetPosition(
            this.BodyID,
            joltScratch.rvec3(position),
            // activating a static body asserts inside Jolt (and means nothing - it is never
            // simulated), so only ask for activation when there is something to activate
            this.isStatic ? Raw.module.EActivation_DontActivate : Raw.module.EActivation_Activate
        );
        // A setter is a teleport, not simulation: the cached previous/current poses now bracket
        // a jump the body never travelled, and interpolating across them would smear the object
        // from its old place to its new one over the next frame.
        this.resetPoseCache();
        this.markMovedIfStatic();
    }
    // get the position of the body and wrap it in a three vector
    getPosition(asJolt?: boolean): THREE.Vector3 | Jolt.RVec3 {
        if (asJolt) return this.bodyInterface.GetPosition(this.BodyID);
        return vec3.joltToThree(this.bodyInterface.GetPosition(this.BodyID));
    }
    get position(): THREE.Vector3 {
        return this.getPosition() as THREE.Vector3;
    }
    /** Turn the body. Same rules as the {@link position} setter, statics included (issue #61). */
    // `SetRotation` takes a QuatArg and copies it; shared scratch, no allocation per call.
    set rotation(rotation: THREE.Quaternion) {
        this.bodyInterface.SetRotation(
            this.BodyID,
            joltScratch.quat(rotation),
            this.isStatic ? Raw.module.EActivation_DontActivate : Raw.module.EActivation_Activate
        );
        // see the `position` setter: a teleport must not be slerped across.
        this.resetPoseCache();
        this.markMovedIfStatic();
    }
    // get the rotation of the body and wrap it in a three quaternion
    get rotation(): THREE.Quaternion {
        return quat.joltToThree(this.body.GetRotation());
    }
    /**
     * Static bodies are not in the frame loop's iteration (they can never be awake), so a static
     * that was just moved has to tell the body system, which hands it to the render sync exactly
     * once. Costs nothing for every other motion type.
     */
    private markMovedIfStatic() {
        if (this.isStatic) this.bodySystem.markStaticMoved(this);
    }

    // set both position and rotation
    setPositionAndRotation(position: THREE.Vector3, rotation: THREE.Quaternion) {
        this.position = position;
        this.rotation = rotation;
        // the two setters above each drop the cache already; kept explicit so this stays correct
        // if either of them is ever reimplemented against the body interface directly.
        this.resetPoseCache();
    }
    get scale() {
        return this.activeScale;
    }

    /**
     * Scale the body's collision shape (issue #40).
     *
     * A number means a uniform scale on all three axes. Non-uniform scale is allowed wherever
     * Jolt allows it (a box, a convex hull, a mesh...); the shapes that cannot take it - spheres,
     * capsules, tapered capsules - fall back to a uniform scale of the largest component, with a
     * `devWarn`, rather than silently producing a shape that does not match what is on screen.
     *
     * Re-scaling replaces the `ScaledShape` rather than stacking a new one on top of it, so the
     * scale is always relative to the *unscaled* shape and the superseded wrapper is freed with
     * the body's reference.
     */
    set scale(inScale: THREE.Vector3 | number[] | number) {
        // `inScale instanceof Number` was always false for a primitive number, so a numeric
        // scale used to fall through to `vec3.three(2)` -> (2, undefined, undefined).
        const requested =
            typeof inScale === 'number'
                ? new THREE.Vector3(inScale, inScale, inScale)
                : vec3.three(inScale);

        let existingShape = this.body.GetShape() as Jolt.ScaledShape;
        let baseShape: Jolt.Shape | Jolt.ScaledShape = existingShape;
        // first, determine if the shape is a scaled shape
        if (existingShape.GetSubType() === Raw.module.EShapeSubType_Scaled) {
            // we have to be 100% that this shape has what we need
            existingShape = Raw.module.castObject(existingShape, Raw.module.ScaledShape);
            // get the existing scale
            const existingScale = existingShape.GetScale();
            // compare existing scale to new scale
            if (
                existingScale.GetX() === requested.x &&
                existingScale.GetY() === requested.y &&
                existingScale.GetZ() === requested.z
            ) {
                // if they are the same, we don't need to do anything
                return;
            }

            baseShape = existingShape.GetInnerShape();
        } else if (
            requested.x === 1 &&
            requested.y === 1 &&
            requested.z === 1 &&
            this.activeScale.x === 1 &&
            this.activeScale.y === 1 &&
            this.activeScale.z === 1
        ) {
            // an unscaled shape asked to stay unscaled: don't wrap it for nothing
            return;
        }
        // a sphere/capsule cannot be squashed: ask Jolt rather than guessing from the subtype,
        // because the answer also depends on what is inside a compound
        const scale = validScaleFor(baseShape, requested);
        // create the new scaled shape. `scaleShape` wraps the base shape in a `ScaledShape` that
        // takes its own reference on it, and hands back a shape we own exactly one reference on.
        const newShape = Raw.module.castObject(
            scaleShape(baseShape, scale),
            Raw.module.ScaledShape
        );
        // set the new shape - the body takes its own reference, and drops the one it held on the
        // shape we are replacing (which frees the superseded ScaledShape)
        this.bodyInterface.SetShape(this.BodyID, newShape, true, Raw.module.EActivation_Activate);

        // if we are a regular shape we can get an accurate actualScale
        let actualScale = scale;

        // check if the new shape is a scaled shape
        if (newShape.GetSubType() === Raw.module.EShapeSubType_Scaled) {
            actualScale = vec3.three(newShape.GetScale());
        }
        // the body owns it now
        releaseShape(newShape);
        this.activeScale = actualScale;
        // if not an instance update the object
        if (!this.isInstance) {
            this.object.scale.copy(actualScale);
        }
    }
    // get the velocity of the body
    get velocity() {
        return vec3.three(this.body.GetLinearVelocity());
    }
    // set the velocity of the body
    // `SetLinearVelocity` takes a Vec3Arg and copies it; shared scratch, no allocation per call.
    set velocity(velocity: Vector3) {
        this.body.SetLinearVelocity(joltScratch.vec3(velocity));
    }
    // get the angular velocity of the body
    get angularVelocity() {
        return vec3.three(this.body.GetAngularVelocity());
    }
    // set the angular velocity of the body
    set angularVelocity(angularVelocity: Vector3) {
        this.body.SetAngularVelocity(joltScratch.vec3(angularVelocity));
    }
    get color(): THREE.Color {
        // if we are a mesh, get the material color of the mesh
        if (!this.isInstance) {
            const material = this.firstMaterial;
            return (material as THREE.Material & { color: THREE.Color }).color;
        }
        // if we are an instance, get the color of the instanced mesh
        const _color = new THREE.Color();
        (this.object as InstancedMesh).getColorAt(this.index!, _color);
        return _color;
    }
    set color(color: THREE.ColorRepresentation) {
        const newColor = color instanceof THREE.Color ? color : new THREE.Color(color);
        // if we are an instance, set the color on the shared InstancedMesh's color buffer
        if (this.isInstance) {
            const object = this.object as InstancedMesh;
            object.setColorAt(this.index!, newColor);
            // setColorAt only writes into the CPU-side buffer; without this the GPU buffer (and
            // therefore what's rendered) never picks up the change.
            if (object.instanceColor) object.instanceColor.needsUpdate = true;
            return;
        }
        // plain mesh: the material may be shared with other meshes (e.g. re-used across several
        // <RigidBody>s), so mutating it in place would recolor all of them. Clone it exactly
        // once - on the first color write - and mark it as owned so `destroy()` disposes it;
        // every subsequent write reuses that same owned clone.
        const mesh = this.object as THREE.Mesh;
        if (!this.ownsMaterial) {
            mesh.material = Array.isArray(mesh.material)
                ? mesh.material.map((material) => material.clone())
                : mesh.material.clone();
            this.ownsMaterial = true;
        }
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
            (material as THREE.Material & { color?: THREE.Color }).color?.copy(newColor);
        }
    }
    // the material this body's mesh renders with (first slot, for multi-material meshes)
    private get firstMaterial(): THREE.Material {
        const material = (this.object as THREE.Mesh).material;
        return Array.isArray(material) ? material[0] : material;
    }

    //* Physics Properties ----------------------------------
    // sensors
    get isSensor() {
        return this.body.IsSensor();
    }
    set isSensor(isSensor: boolean) {
        this.body.SetIsSensor(isSensor);
    }
    //friction
    get friction() {
        return this.body.GetFriction();
    }
    set friction(friction: number) {
        this.body.SetFriction(friction);
    }
    //restitution
    set restitution(restitution: number) {
        this.body.SetRestitution(restitution);
    }
    get restitution() {
        return this.body.GetRestitution();
    }
    /**
     * This body's `MotionProperties`, or `undefined` for a static body - which has none at all.
     * `Body::GetMotionProperties()` asserts on a static body in a debug build and hands back a
     * null pointer in a release one, so every caller goes through here.
     */
    private get motionProperties(): Jolt.MotionProperties | undefined {
        if (this.body.IsStatic()) return undefined;
        return this.body.GetMotionProperties();
    }
    get angularDamping() {
        return this.motionProperties?.GetAngularDamping() ?? 0;
    }
    set angularDamping(damping: number) {
        this.motionProperties?.SetAngularDamping(damping);
    }
    get linearDamping() {
        return this.motionProperties?.GetLinearDamping() ?? 0;
    }
    set linearDamping(damping: number) {
        this.motionProperties?.SetLinearDamping(damping);
    }
    get gravityFactor() {
        return this.motionProperties?.GetGravityFactor() ?? 0;
    }
    set gravityFactor(factor: number) {
        this.motionProperties?.SetGravityFactor(factor);
    }
    /**
     * The body's mass in kilograms (issue #201).
     *
     * Read from the body's own `MotionProperties`, not from the shape: a body created with a
     * `mass` option (or scaled afterwards) overrides what the shape's density implies, and the
     * old getter reported the shape's number and ignored the override entirely.
     *
     * **`0` for static and kinematic bodies**, which Jolt treats as having infinite mass - they
     * have no inverse mass to invert. Setting it on one is a no-op.
     */
    get mass(): number {
        // only a dynamic body has a meaningful inverse mass; Jolt asserts on the others
        if (!this.body.IsDynamic()) return 0;
        const inverseMass = this.body.GetMotionProperties().GetInverseMass();
        return inverseMass > 0 ? 1 / inverseMass : 0;
    }
    set mass(mass: number) {
        const motionProperties = this.motionProperties;
        if (!motionProperties || !this.body.IsDynamic()) {
            devWarn(
                `*** R3/Jolt: mass has no meaning on a ${
                    this.body.IsStatic() ? 'static' : 'kinematic'
                } body (Jolt treats it as infinite); ignoring ***`
            );
            return;
        }
        if (!(mass > 0)) {
            devWarn(`*** R3/Jolt: mass must be greater than 0, got ${mass}; ignoring ***`);
            return;
        }
        // scales the inverse mass and the inertia tensor together, and - unlike going through
        // `SetMassProperties` - leaves the body's allowed degrees of freedom alone
        motionProperties.ScaleToMass(mass);
    }

    //* Group Filtering ----------------------------------
    // Object layers (`Layer` in constants.ts) remain the broad "what kind of thing is this"
    // filter. Collision groups are the narrow one: two bodies only consult the group filter when
    // their group ids match, and `bodySystem.disableCollision(subA, subB)` then turns off that one
    // sub group pair. Give every body in a group its own sub group id.
    //
    // Both are live: the getters read the body itself and the setters push a new CollisionGroup
    // through BodyInterface.SetCollisionGroup, so they work after creation too (issue #95).
    get group() {
        return this.body.GetCollisionGroup().GetGroupID();
    }
    set group(group: number) {
        this.bodySystem.setBodyCollisionGroup(this.handle, group);
    }
    get subGroup() {
        return this.body.GetCollisionGroup().GetSubGroupID();
    }
    set subGroup(subGroup: number) {
        this.bodySystem.setBodyCollisionGroup(this.handle, undefined, subGroup);
    }
    /** Alias of {@link group}. */
    get collisionGroup() {
        return this.group;
    }
    set collisionGroup(group: number) {
        this.group = group;
    }
    /** Alias of {@link subGroup}. */
    get collisionSubGroup() {
        return this.subGroup;
    }
    set collisionSubGroup(subGroup: number) {
        this.subGroup = subGroup;
    }

    //* DOF Manipulation ------------------------------------
    // get the raw DOF
    get rawDOF() {
        return this.body.GetMotionProperties().GetAllowedDOFs();
    }
    // set the raw DOF
    set rawDOF(dof: number) {
        // massProperties comes from the shape.
        const massProperties = this.body.GetShape().GetMassProperties();
        this.body.GetMotionProperties().SetMassProperties(dof, massProperties);
    }

    get dof() {
        const rawDOF = this.rawDOF;
        return {
            x: (rawDOF & Raw.module.EAllowedDOFs_TranslationX) !== 0,
            y: (rawDOF & Raw.module.EAllowedDOFs_TranslationY) !== 0,
            z: (rawDOF & Raw.module.EAllowedDOFs_TranslationZ) !== 0,
            rotX: (rawDOF & Raw.module.EAllowedDOFs_RotationX) !== 0,
            rotY: (rawDOF & Raw.module.EAllowedDOFs_RotationY) !== 0,
            rotZ: (rawDOF & Raw.module.EAllowedDOFs_RotationZ) !== 0
        };
    }
    setDof(dof: {
        x?: boolean;
        y?: boolean;
        z?: boolean;
        rotX?: boolean;
        rotY?: boolean;
        rotZ?: boolean;
    }) {
        let newDOF = this.rawDOF;
        // `key` typed off `dof` itself so the lookups below index it without a suppression
        const allowedDOFs: { key: keyof typeof dof; flag: number }[] = [
            { key: 'x', flag: Raw.module.EAllowedDOFs_TranslationX },
            { key: 'y', flag: Raw.module.EAllowedDOFs_TranslationY },
            { key: 'z', flag: Raw.module.EAllowedDOFs_TranslationZ },
            { key: 'rotX', flag: Raw.module.EAllowedDOFs_RotationX },
            { key: 'rotY', flag: Raw.module.EAllowedDOFs_RotationY },
            { key: 'rotZ', flag: Raw.module.EAllowedDOFs_RotationZ }
        ];

        allowedDOFs.forEach((optionalDof) => {
            //console.log("checking", dof[optionalDof.key], dof[optionalDof.key] == undefined);
            if (dof[optionalDof.key]) {
                newDOF |= optionalDof.flag;
                // leaving these logs because its annoying to retype
                /*console.log(
					"setting",
					optionalDof.key,
					optionalDof.flag,
					newDOF,
					createBinaryString(newDOF)
				);
				*/
            } else if (dof[optionalDof.key] !== undefined) {
                newDOF &= ~optionalDof.flag;
                /*console.log(
					"unsetting",
					optionalDof.key,
					optionalDof.flag,
					newDOF,
					createBinaryString(newDOF)
				);
				*/
            }
        });

        this.rawDOF = newDOF;
    }
    // Rapier stype
    lockRotations() {
        this.setDof({ rotX: false, rotY: false, rotZ: false });
    }
    lockTranslations() {
        this.setDof({ x: false, y: false, z: false });
    }
    // rapier style activation
    setEnabledRotations(x: boolean, y: boolean, z: boolean) {
        this.setDof({ rotX: x, rotY: y, rotZ: z });
    }
    setEnabledTranslations(x: boolean, y: boolean, z: boolean) {
        this.setDof({ x, y, z });
    }

    //* Force Manipulation ----------------------------------
    // Every one of these takes its vector by value and accumulates it into the body, so the
    // shared scratch objects are safe and these stay allocation free in the frame loop.
    // apply a force to the body
    applyForce(force: Vector3) {
        this.body.AddForce(joltScratch.vec3(force));
    }
    // apply a torque to the body
    applyTorque(torque: Vector3) {
        this.body.AddTorque(joltScratch.vec3(torque));
    }
    // add impulse to the body
    addImpulse(impulse: Vector3) {
        this.body.AddImpulse(joltScratch.vec3(impulse));
    }
    //* Kinematic motion ----------------------------------
    /**
     * Drive a kinematic body towards `position` (and `rotation`) over `deltaTime`.
     *
     * Jolt derives the body's velocity from `(target - current) / deltaTime`, which is what makes
     * a kinematic platform push and carry the things resting on it - a plain `position` write
     * teleports instead, and carries nothing.
     *
     * @param position world space target position.
     * @param rotation world space target rotation. Omitted (or `null`) keeps the body's current
     * rotation, so `moveKinematic(pos)` never silently straightens a rotated platform (#194).
     * @param deltaTime seconds to cover the distance in. Defaults to the world's step length:
     * `physicsSystem.timeStep` when it is a number, otherwise the last frame delta. It used to
     * default to `0`, which produces no velocity and therefore no motion at all.
     *
     * Called from `useFrame`, this applies the whole move in the first substep of the frame;
     * {@link setKinematicTarget} is the smoother option, since the step loop re-aims it with the
     * real substep dt.
     */
    moveKinematic(
        position: anyVec3,
        rotation?: THREE.Quaternion | Jolt.Quat | null,
        deltaTime: number = this.stepDelta
    ) {
        this.bodyInterface.MoveKinematic(
            this.BodyID,
            joltScratch.rvec3(position),
            // `rvec3` and `quat` are separate scratch singletons, so both are live here
            joltScratch.quat(rotation ?? this.body.GetRotation()),
            deltaTime
        );
    }

    /**
     * Give this body per-surface materials, and tell the contact listener to keep calling us
     * even when no user handler is attached (the friction write is synchronous, inside
     * `Step()`, so it cannot be deferred like a normal event).
     *
     * The table's Jolt materials belong to the *shape*, not to this body: `dispose()` only drops
     * the JS side bookkeeping.
     */
    setSurfaceMaterials(table: SurfaceMaterialTable | undefined) {
        this.surfaceMaterials?.dispose();
        this.surfaceMaterials = table;
        if (table) this.internalMask |= EventBit.surfaceMaterial;
        else this.internalMask &= ~EventBit.surfaceMaterial;
    }

    /**
     * Where this body is being driven to by {@link setKinematicTarget}, or `null`. Preallocated
     * and written in place - the step loop reads it every substep, so it must not allocate.
     */
    kinematicTarget: { position: Vector3; rotation: Quaternion } | null = null;

    /**
     * Aim a kinematic body at a world space pose and let the step loop do the driving (#194).
     *
     * Unlike {@link moveKinematic}, which is applied once with whatever delta the caller passes,
     * the target is re-applied at the top of **every substep** with that substep's real dt, so
     * the body converges on the target exactly however many substeps a frame runs, and riders
     * see a steady velocity instead of one big lurch followed by nothing.
     *
     * The target is sticky: set it once per frame (or once, and leave it) and clear it with
     * {@link clearKinematicTarget}. Once reached, the derived velocity is zero, so a stale
     * target simply parks the body where it asked to be.
     *
     * @param rotation omitted keeps the body's current rotation.
     */
    setKinematicTarget(position: anyVec3, rotation?: THREE.Quaternion | Jolt.Quat | null) {
        if (!this.kinematicTarget)
            this.kinematicTarget = { position: new Vector3(), rotation: new Quaternion() };
        const target = this.kinematicTarget;
        // `three()`'s out parameter is its fourth argument (it also takes loose x/y/z numbers)
        vec3.three(position, undefined, undefined, target.position);
        quat.three(rotation ?? this.body.GetRotation(), target.rotation);
        this.bodySystem.trackKinematicTarget(this);
    }

    /** Stop driving this body; it keeps whatever velocity the last substep gave it. */
    clearKinematicTarget() {
        this.kinematicTarget = null;
        this.bodySystem.untrackKinematicTarget(this);
    }

    /**
     * Apply the standing target with the step's own dt. Called by `BodySystem` from inside the
     * fixed step loop, before `Step()`; not part of the public API.
     * @internal
     */
    applyKinematicTarget(deltaTime: number) {
        const target = this.kinematicTarget;
        if (!target || deltaTime <= 0) return;
        this.bodyInterface.MoveKinematic(
            this.BodyID,
            joltScratch.rvec3(target.position),
            joltScratch.quat(target.rotation),
            deltaTime
        );
    }

    /**
     * How long one physics step is, for callers that don't want to pass a delta. The fixed step
     * length when the world runs one, the last frame delta when it steps with `timeStep="vary"`,
     * and 1/60 when there is no world to ask (a body built against a bare `BodySystem`).
     */
    private get stepDelta(): number {
        const world = this.bodySystem.world;
        if (!world) return 1 / 60;
        if (typeof world.timeStep === 'number' && world.timeStep > 0) return world.timeStep;
        return world.lastDelta > 0 ? world.lastDelta : 1 / 60;
    }

    //* Motion Source ----------------------------------
    // activate the impulse source
    activateMotionSource(linearVector = new THREE.Vector3(), angularVector?: THREE.Vector3) {
        this.motionActive = true;
        this.isMotionSource = true;
        this.motionType = angularVector ? 'angular' : 'linear';
        this.motionLinearVector = linearVector;
        if (angularVector) this.motionAngularVector = angularVector;
        // if you want to use the normal for a bouncepad call it separately

        // Tier A: this no longer goes on the user listener lists. `ContactSettings` is only
        // live inside the Jolt callback, so the surface velocity half has to run there, while
        // the impulse/teleport half is illegal there and is queued instead. The bit tells the
        // contact listener to keep calling us even when no user handler is attached.
        this.internalMask |= EventBit.motionSource;
    }

    /**
     * Synchronous, inside `Step()`. Writes `ContactSettings` directly (surface velocity) and
     * queues anything that touches the body interface as a pending action, which
     * `BodySystem.handlePendingActions` applies at the top of the next substep.
     *
     * `addImpulse` used to be called straight from the contact callback, which goes through
     * `BodyInterface` and is not allowed while Jolt owns the world.
     */
    handleMotionContact = (
        body1Handle: number,
        body2Handle: number,
        settings: Jolt.ContactSettings
    ) => {
        // get the body states of the two bodies
        const body1 = this.bodySystem.getBody(body1Handle);
        const body2 = this.bodySystem.getBody(body2Handle);
        if (!body1 || !body2) return;
        // get body rotations
        const rotation1 = body1.rotation;
        const rotation2 = body2.rotation;
        const targetBody = body1.isMotionSource ? body2 : body1;
        const sourceBody = body1.isMotionSource ? body1 : body2;

        //if this is a teleporter
        if (sourceBody.isTeleporter) {
            //the target position is the linear vector
            const target = sourceBody.motionLinearVector;
            this.bodySystem.createPendingAction('position', targetBody.handle, target);
            // if the angle is set we'll use that for rotation
            if (sourceBody.motionAngularVector)
                this.bodySystem.createPendingAction(
                    'rotation',
                    targetBody.handle,
                    sourceBody.motionAngularVector
                );
            // bail
            return undefined;
        }
        // we need to determine which type of force to add
        //let doLinear = false;
        //if (body1.isMotionSource && body1.motionType === "linear") doLinear = true;
        //if (body2.isMotionSource && body2.motionType === "linear") doLinear = true;

        if (sourceBody.motionType === 'linear') {
            // get the linear vector
            const linearVector =
                body1.motionLinearVector?.clone() ||
                body2.motionLinearVector?.clone() ||
                new THREE.Vector3(-10, 0, 0);
            if (sourceBody.motionAsSurfaceVelocity) {
                // this seems like the wrong way to do this but I'll follow the original example
                // Determine the world space surface velocity of both bodies
                const cLocalSpaceVelocity = linearVector?.clone();
                const body1LinearSurfaceVelocity = body1.isMotionSource
                    ? cLocalSpaceVelocity.applyQuaternion(rotation1)
                    : new THREE.Vector3(0, 0, 0);
                const body2LinearSurfaceVelocity = body2.isMotionSource
                    ? cLocalSpaceVelocity.applyQuaternion(rotation2)
                    : new THREE.Vector3(0, 0, 0);
                const v = body2LinearSurfaceVelocity.sub(body1LinearSurfaceVelocity);
                settings.mRelativeLinearSurfaceVelocity.Set(v.x, v.y, v.z);
            } else {
                // Queued, not applied: AddImpulse goes through the body interface, which may
                // not be touched while Jolt is inside Step().
                if (this.useRotation) linearVector.applyQuaternion(sourceBody.rotation);
                this.bodySystem.createPendingAction('addImpulse', targetBody.handle, linearVector);
            }
        }
        // angular
        if (sourceBody.motionType === 'angular') {
            if (sourceBody.motionAsSurfaceVelocity) {
                const cLocalSpaceAngularVelocity = new THREE.Vector3(
                    0,
                    THREE.MathUtils.degToRad(10.0),
                    0
                );
                const body1AngularSurfaceVelocity = body1.isMotionSource
                    ? cLocalSpaceAngularVelocity.applyQuaternion(rotation1)
                    : new THREE.Vector3(0, 0, 0);
                const body2AngularSurfaceVelocity = body2.isMotionSource
                    ? cLocalSpaceAngularVelocity.applyQuaternion(rotation2)
                    : new THREE.Vector3(0, 0, 0);

                // Note that the angular velocity is the angular velocity around body 1's center of mass, so we need to add the linear velocity of body 2's center of mass
                const COM1 = vec3.three(body1.body.GetCenterOfMassPosition());
                const COM2 = vec3.three(body2.body.GetCenterOfMassPosition());
                const body2LinearSurfaceVelocity = body2.isMotionSource
                    ? body2AngularSurfaceVelocity.cross(COM1.clone().sub(COM2))
                    : new THREE.Vector3(0, 0, 0);

                // Calculate the relative angular surface velocity
                const rls = body2LinearSurfaceVelocity;
                settings.mRelativeLinearSurfaceVelocity.Set(rls.x, rls.y, rls.z);
                const ras = body2AngularSurfaceVelocity.sub(body1AngularSurfaceVelocity);
                settings.mRelativeAngularSurfaceVelocity.Set(ras.x, ras.y, ras.z);
            } else {
                const angularVector =
                    body1.motionAngularVector?.clone() ||
                    body2.motionAngularVector?.clone() ||
                    new THREE.Vector3(0, 0, 0);
                this.bodySystem.createPendingAction(
                    'applyTorque',
                    targetBody.handle,
                    angularVector
                );
            }
        }
    };
    /*motionRemovedListener = (
		body1: Jolt.BodyID,
		body2: Jolt.BodyID,
		manifold: Jolt.ContactManifold,
		settings: Jolt.ContactSettings
	) => {};*/
}
