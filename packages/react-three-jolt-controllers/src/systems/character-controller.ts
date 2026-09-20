/* We do this as a class so it's not bound to a react component
so much and can be reused for things like NPC's */

import {
    type BodyState,
    type BodySystem,
    createShapeFromSettings,
    Emitter,
    generateBodySettings,
    joltScratch,
    Layer,
    type PhysicsSystem,
    quat,
    Raw,
    releaseShape,
    type Unsubscribe,
    vec3
} from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { MathUtils } from 'three';

interface CharacterFilters {
    objectVsBroadPhaseLayerFilter?: Jolt.ObjectVsBroadPhaseLayerFilter;
    objectLayerPairFilter?: Jolt.ObjectLayerPairFilter;
    movingBPFilter?: Jolt.DefaultBroadPhaseLayerFilter;
    movingLayerFilter?: Jolt.DefaultObjectLayerFilter;
    bodyFilter: Jolt.BodyFilterJS;
    shapeFilter: Jolt.ShapeFilter;
}

// biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
export type CharacterActionCallback = (action: any, payload?: any) => void;

/**
 * One contact between the character and a body, forwarded from Jolt's
 * `CharacterContactListener` (issues #79/#80/#187).
 *
 * **Pooled.** One object is reused for every contact in a step: read what you need inside the
 * handler, the same contract `CollisionPayload` carries. `body`/`object` are `undefined` for a
 * Jolt body `BodySystem` never registered.
 */
export interface CharacterContactPayload {
    body: BodyState | undefined;
    object: THREE.Object3D | undefined;
    /** `BodyID.GetIndexAndSequenceNumber()` of the other body. Always valid. */
    handle: number;
    /** `SubShapeID.GetValue()` on the *other* body's shape. */
    subShapeId: number;
    /** World space contact point. Zeroed for `contactRemoved`, which Jolt gives no geometry. */
    position: THREE.Vector3;
    /** Contact normal as Jolt reports it: pointing from the character into the other body. */
    normal: THREE.Vector3;
}

/**
 * Everything a `CharacterControllerSystem` emits (issues #50, #79, #80).
 *
 * The movement events are **edges**, derived once per pre-step from the character's ground state
 * and its velocity relative to whatever is carrying it. Every one of them is also emitted as an
 * `action` under the same name, so `controller.on('move', fn)` - the older action-filtered API -
 * and `controller.events.on('move', fn)` see the same things.
 */
export type CharacterEventMap = {
    /** Every action, including the ones below, as `(name, payload)`. */
    action: CharacterActionCallback;
    /** Started moving under its own power. `speed` is m/s relative to the ground. */
    move: (speed: number) => void;
    /** Stopped moving under its own power. */
    stop: () => void;
    /** Started sliding down something too steep to stand on. `speed` is along the surface. */
    slide: (speed: number) => void;
    /** Stopped sliding. */
    slideEnd: () => void;
    /** A jump was accepted; `count` is which jump of the allowed sequence it was. */
    jump: (count: number) => void;
    /** Touched down. `airtime` is how long, in seconds, it had been unsupported. */
    land: (airtime: number) => void;
    /** Became supported by something. Always paired with `land`. */
    ground: () => void;
    /** Stopped being supported by anything. */
    airborne: () => void;
    crouch: () => void;
    stand: () => void;
    /** A new contact with a body. Dispatched after the character update, never inside it. */
    contactAdded: (payload: CharacterContactPayload) => void;
    contactPersisted: (payload: CharacterContactPayload) => void;
    contactRemoved: (payload: CharacterContactPayload) => void;
};

/**
 * One bit per forwarded contact event. The Jolt callbacks read
 * `events.mask & CharacterEventBit.*` and return immediately when nobody is listening, so an
 * unused contact stream costs one `&` per contact and nothing else.
 */
export const CharacterEventBit = {
    contactAdded: 1 << 0,
    contactPersisted: 1 << 1,
    contactRemoved: 1 << 2
} as const;

const CHARACTER_EVENT_BITS: Partial<Record<keyof CharacterEventMap, number>> = {
    contactAdded: CharacterEventBit.contactAdded,
    contactPersisted: CharacterEventBit.contactPersisted,
    contactRemoved: CharacterEventBit.contactRemoved
};

/** Queue record kinds; the index into `CONTACT_EVENT_NAME`. */
const CONTACT_EVENT_NAME = ['contactAdded', 'contactPersisted', 'contactRemoved'] as const;

/**
 * One queued character contact. Jolt's `CharacterContactListener` fires from inside
 * `CharacterVirtual::ExtendedUpdate`, where adding or removing a body is illegal and the
 * pointers it hands over are into memory Jolt reuses - so the callback copies numbers into one
 * of these and returns. They are pooled: the queue only ever grows.
 */
type QueuedContact = {
    kind: number;
    handle: number;
    subShapeId: number;
    px: number;
    py: number;
    pz: number;
    nx: number;
    ny: number;
    nz: number;
};

export class CharacterControllerSystem {
    protected joltInterface: Jolt.JoltInterface;
    protected physicsSystem: PhysicsSystem;
    protected bodySystem: BodySystem;

    // **Primary Holder Object ***
    character!: Jolt.CharacterVirtual;
    threeObject = new THREE.Object3D();
    threeCharacter = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshPhongMaterial({ color: 0xffff00 })
    );
    protected updateSettings = new Raw.module.ExtendedUpdateSettings();
    protected characterContactListener: any;

    //rig anchor
    anchor: any;
    anchorID: any;

    // DO NOT MESS WITH THESE
    filters: CharacterFilters = {
        objectVsBroadPhaseLayerFilter: undefined,
        objectLayerPairFilter: undefined,
        movingBPFilter: undefined,
        movingLayerFilter: undefined,
        bodyFilter: new Raw.module.BodyFilterJS(),
        shapeFilter: new Raw.module.ShapeFilter()
    };

    /**
     * Everything this controller emits, on the shared Emitter primitive (issues #50/#79/#80).
     * `events.on(type, fn)` returns its own unsubscribe; identity is never compared.
     */
    readonly events = new Emitter<CharacterEventMap>(CHARACTER_EVENT_BITS);
    /** Back compat so the deprecated `removeActionListener(fn)` still finds its handles. */
    private legacyActionSubs = new Map<Function, Unsubscribe[]>();

    // configurable options

    characterHeightStanding = 2;
    characterRadiusStanding = 1;
    characterHeightCrouching = 1;
    characterRadiusCrouching = 0.8;

    // Character movement properties
    allowAirbornControl = true; ///< If false the character cannot change movement direction in mid air
    characterSpeed = 6;
    characterSpeedCrouched = 3.0;
    characterSpeedExhausted = 2.0;
    jumpSpeed = 15.0;

    enableCharacterInertia = true;
    // if the body turns on move input
    enableCharacterRotation = true;
    enableWalkStairs = true;
    enableStickToFloor = true;

    direction = new THREE.Vector3(0, 0, 0);
    velocity = new THREE.Vector3(0, 0, 0);

    // State properties ------------------------------
    isDebugging = false;
    isCrouched = false;
    isRotating = false;
    private isJumping = false;
    isRunning = false;
    isExhausted = false;

    //* Derived motion state (issues #79, #80) ==============
    // Recomputed once per pre-step, after the character has been updated, and read back through
    // the cheap getters below. The `move`/`stop`, `slide`/`slideEnd`, `ground`/`airborne` and
    // `land` events are the edges of exactly these three booleans.
    private _isMoving = false;
    private _isSliding = false;
    private _isGrounded = false;
    private airtime = 0;

    /**
     * Relative horizontal speed (m/s) at which the character counts as moving. It is measured
     * against the *supporting body's* velocity, so standing on a moving platform is not walking
     * (#79). Falling back below half of this is what ends the move.
     */
    moveThreshold = 0.5;
    /**
     * Speed (m/s) along a too-steep surface at which the character counts as sliding (#80).
     * Falling back below half of this ends the slide.
     */
    slideThreshold = 0.5;

    /** True while the character is moving under its own power. Cheap: a cached boolean. */
    get isMoving(): boolean {
        return this._isMoving;
    }
    /** True while the character is sliding down something too steep to stand on. */
    get isSliding(): boolean {
        return this._isSliding;
    }
    /** True while something is supporting the character (`OnGround` or `OnSteepGround`). */
    get isGrounded(): boolean {
        return this._isGrounded;
    }

    allowSliding = false;
    allowRunning = true;
    enableExhaustion = true;
    exhaustionEffectsJump = true;
    exhaustionBlocksDoubleJump = true;
    allowJumpWhileFalling = true;
    jumpLimit = 2;
    jumpDegradeFactor = 0.5;
    hangtime = 0;
    runningTimeLimit = 5000;
    exauhstionTimeLimit = 7000;
    debugVerbose = false;

    //-------------------------------------------

    // private properties
    //active speed allows variable running speeds
    private activeSpeed = 6;
    private runningTimer: ReturnType<typeof setTimeout> | undefined;
    protected crouchingInterval: ReturnType<typeof setInterval> | undefined;
    private exhaustionTimer: ReturnType<typeof setTimeout> | undefined;
    private jumpTimer: ReturnType<typeof setTimeout> | undefined;

    /** true once `destroy()` has run; every jolt object below is freed and nulled out by then */
    private destroyed = false;
    private anchorHandle: number | undefined;

    /**
     * The *exact* function registered with the physics system. `removeStepListener` matches by
     * identity, so registering an inline arrow (which is what this used to do) made the listener
     * impossible to remove and left a destroyed character being stepped against freed memory -
     * issue #138. An instance arrow field is created once per instance, so add and remove see
     * the same object.
     */
    private readonly handlePreStep = (deltaTime: number) => this.prePhysicsUpdate(deltaTime);

    // shapes of the character
    private activeStandingShape!: Jolt.Shape;
    private activeCrouchingShape!: Jolt.Shape;
    standingMesh!: THREE.Mesh;
    crouchingMesh!: THREE.Mesh;

    // Rotation properties
    targetRotation = new THREE.Quaternion();
    maxRotationSpeed = 0.1; //radians per frame
    currentRotationSlerp = 0;

    // movement vectors
    private movementInput = new THREE.Vector3();
    private desiredVelocity = new THREE.Vector3();
    private jumpCounter = 0;
    lerpFactor = 0.4;

    // Temp variables
    //TODO remove this for global temps
    private _tmpVec3 = new Raw.module.Vec3();

    //* Event plumbing ====================================
    /** Records written inside `ExtendedUpdate`, dispatched by `flushContacts` after it. */
    private readonly contactQueue: QueuedContact[] = [];
    private contactQueueCount = 0;
    /** One reused payload for the whole flush - see {@link CharacterContactPayload}. */
    private readonly contactPayload: CharacterContactPayload = {
        body: undefined,
        object: undefined,
        handle: 0,
        subShapeId: -1,
        position: new THREE.Vector3(),
        normal: new THREE.Vector3()
    };
    // Scratch for the per-step state derivation. Kept as fields so it allocates nothing.
    private readonly _stateVelocity = new THREE.Vector3();
    private readonly _stateUp = new THREE.Vector3();
    private readonly _stateNormal = new THREE.Vector3();

    constructor(physicsSystem: PhysicsSystem) {
        this.physicsSystem = physicsSystem;
        this.joltInterface = physicsSystem.joltInterface;
        this.bodySystem = physicsSystem.bodySystem;
        // Filters
        this.filters.objectVsBroadPhaseLayerFilter =
            this.joltInterface.GetObjectVsBroadPhaseLayerFilter();
        this.filters.objectLayerPairFilter = this.joltInterface.GetObjectLayerPairFilter();
        this.filters.movingBPFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
            this.filters.objectVsBroadPhaseLayerFilter,
            Layer.MOVING
        );
        this.filters.movingLayerFilter = new Raw.module.DefaultObjectLayerFilter(
            this.filters.objectLayerPairFilter,
            Layer.MOVING
        );
        // adjust the main body filter to not conflict with sensors
        this.filters.bodyFilter.ShouldCollide = () => true;
        //@ts-ignore wrap still incorrect here.
        this.filters.bodyFilter.ShouldCollideLocked = (inBody: Jolt.Body) =>
            //@ts-ignore wrap still incorrect here.
            !Raw.module.wrapPointer(inBody, Raw.module.Body).IsSensor();

        // Init the character contact listener
        this.initCharacterContactListener();

        this.initCharacter();
        // Set a default shape size (know it will be overwritten by the user
        this.setCapsule(1, 2);
        // create the rig anchor
        this.createAnchor();
        // Finally, attach to main loop. Keep the handle: this used to be an inline arrow passed
        // to `addPreStepListener`, which `removeStepListener` could never match by identity, so
        // a destroyed character carried on being pre-stepped against a freed CharacterVirtual.
        this.detachFromLoop = this.physicsSystem.onBeforeStep(this.handlePreStep);
    }
    /** Unsubscribes the pre-step callback. Replaced in the constructor. */
    private detachFromLoop: () => void = () => {};

    /**
     * Free everything this controller owns: the step subscription, every timer, the three meshes
     * and every `new Raw.module.*` allocation (issue #138). Idempotent - a second call is a no-op,
     * so an explicit `destroy()` plus a React unmount (or StrictMode's double invoke) is safe.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        // stop being stepped before anything is freed: everything below is memory the step reads
        this.detachFromLoop();
        this.detachFromLoop = () => {};
        this.clearTimers();
        // the action listeners live on the Emitter now (issue #50/#187), so dropping them means
        // clearing it and the legacy subscription bookkeeping rather than emptying an array
        this.events.clear();
        this.legacyActionSubs.clear();
        this.contactQueueCount = 0;
        this.contactQueue.length = 0;

        // three side ---------------------------------------------------
        this.removeFromScene();
        if (this.standingMesh) this.destroyDebugMesh(this.standingMesh);
        if (this.crouchingMesh) this.destroyDebugMesh(this.crouchingMesh);
        this.threeCharacter.geometry.dispose();
        (this.threeCharacter.material as THREE.Material).dispose();
        this.threeObject.userData.body = undefined;

        // jolt side ----------------------------------------------------
        // React destroys a parent's effects before its children's, so `<Physics>` can already
        // have freed the JoltInterface - and with it every body, shape and the world these
        // objects live in. Touching jolt after that traps in wasm (issue #82), so only drop the
        // references in that case.
        if (!this.physicsSystem.destroyed) this.releaseJoltObjects();

        this.character = undefined as unknown as Jolt.CharacterVirtual;
        this.characterContactListener = undefined;
        this.activeStandingShape = undefined as unknown as Jolt.Shape;
        this.activeCrouchingShape = undefined as unknown as Jolt.Shape;
        this.updateSettings = undefined as unknown as Jolt.ExtendedUpdateSettings;
        this.filters = {
            objectVsBroadPhaseLayerFilter: undefined,
            objectLayerPairFilter: undefined,
            movingBPFilter: undefined,
            movingLayerFilter: undefined,
            bodyFilter: undefined as unknown as Jolt.BodyFilterJS,
            shapeFilter: undefined as unknown as Jolt.ShapeFilter
        };
        this._tmpVec3 = undefined as unknown as Jolt.Vec3;
        this.anchor = undefined;
        this.anchorHandle = undefined;
    }

    private clearTimers() {
        if (this.crouchingInterval) clearInterval(this.crouchingInterval);
        if (this.runningTimer) clearTimeout(this.runningTimer);
        if (this.exhaustionTimer) clearTimeout(this.exhaustionTimer);
        if (this.jumpTimer) clearTimeout(this.jumpTimer);
        this.crouchingInterval = undefined;
        this.runningTimer = undefined;
        this.exhaustionTimer = undefined;
        this.jumpTimer = undefined;
    }

    /** every `new Raw.module.*` this class owns, freed in dependency order */
    private releaseJoltObjects() {
        const jolt = Raw.module;
        // the anchor is a real body in the simulation; it has to go before the world does
        if (this.anchorHandle !== undefined) this.bodySystem.removeBody(this.anchorHandle);

        // the character holds a pointer to the contact listener, so it goes first
        if (this.character) jolt.destroy(this.character);
        if (this.characterContactListener) jolt.destroy(this.characterContactListener);

        // shapes are reference counted: give back the reference `createShapeFromSettings` took
        // (the character held its own, which its destructor above has just dropped).
        releaseShape(this.activeStandingShape);
        releaseShape(this.activeCrouchingShape);

        if (this.updateSettings) jolt.destroy(this.updateSettings);
        // NOTE: `objectVsBroadPhaseLayerFilter` / `objectLayerPairFilter` are borrowed from the
        // JoltInterface (`GetObjectVsBroadPhaseLayerFilter()`), not ours - never destroy those.
        if (this.filters.movingBPFilter) jolt.destroy(this.filters.movingBPFilter);
        if (this.filters.movingLayerFilter) jolt.destroy(this.filters.movingLayerFilter);
        if (this.filters.bodyFilter) jolt.destroy(this.filters.bodyFilter);
        if (this.filters.shapeFilter) jolt.destroy(this.filters.shapeFilter);
        if (this._tmpVec3) jolt.destroy(this._tmpVec3);
    }
    //* Properties ========================================
    get debug() {
        return this.isDebugging;
    }
    set debug(value: boolean) {
        this.isDebugging = value;
        if (!this.isCrouched) this.standingMesh.visible = value;
        else this.crouchingMesh.visible = value;
    }
    get shape() {
        return this.character.GetShape();
    }
    // probably shouldn't use this ever
    set shape(shape: Jolt.Shape) {
        const setAttempt = this.character.SetShape(
            shape,
            1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
            //@ts-ignore
            this.filters.movingBPFilter,
            this.filters.movingLayerFilter,
            this.filters.bodyFilter,
            this.filters.shapeFilter,
            this.joltInterface.GetTempAllocator()
        );
        if (this.isDebugging) console.log('Shape Set Attempt:', setAttempt);
    }
    get standingShape() {
        return this.activeStandingShape;
    }
    set standingShape(shape: Jolt.Shape) {
        this.activeStandingShape = shape;
        //TODO create geometry based on this shape for debugging
    }
    get crouchingShape() {
        return this.activeCrouchingShape;
    }
    set crouchingShape(shape: Jolt.Shape) {
        this.activeCrouchingShape = shape;
        //TODO create geometry based on this shape for debugging
    }
    // Stairs, Sticky Floors, etc -------------------------
    get stickToFloorStepDown(): THREE.Vector3 {
        return vec3.three(this.updateSettings.mStickToFloorStepDown);
    }
    // set to 0 to disable sticking to the floor
    set stickToFloorStepDown(value: THREE.Vector3) {
        this.updateSettings.mStickToFloorStepDown.Set(value.x, value.y, value.z);
    }
    // the details are a little complex.
    // link: https://jrouwe.github.io/JoltPhysics/class_character_virtual.html#a7b92d577e9abb6193f971e26df9964f7
    get walkStairsStepUp(): THREE.Vector3 {
        return vec3.three(this.updateSettings.mWalkStairsStepUp);
    }
    // set to 0 to turn off or higher to go up bigger steps
    set walkStairsStepUp(value: THREE.Vector3) {
        this.updateSettings.mWalkStairsStepUp.Set(value.x, value.y, value.z);
    }
    get walkStairsMinStepForward(): number {
        return this.updateSettings.mWalkStairsMinStepForward;
    }
    set walkStairsMinStepForward(value: number) {
        this.updateSettings.mWalkStairsMinStepForward = value;
    }
    get walkStairsStepForwardTest(): number {
        return this.updateSettings.mWalkStairsStepForwardTest;
    }
    set walkStairsStepForwardTest(value: number) {
        this.updateSettings.mWalkStairsStepForwardTest = value;
    }
    // add a little boost when walking down stairs
    get walkStairsStepDownExtra(): THREE.Vector3 {
        return vec3.three(this.updateSettings.mWalkStairsStepDownExtra);
    }
    set walkStairsStepDownExtra(value: THREE.Vector3) {
        this.updateSettings.mWalkStairsStepDownExtra.Set(value.x, value.y, value.z);
    }

    // Position and movement ------------------------------
    get linearVelocity(): THREE.Vector3 {
        return vec3.three(this.character.GetLinearVelocity());
    }
    // every one of these Jolt setters takes its argument by value and copies it, so the shared
    // scratch objects keep the per-frame character setters allocation free. `vec3.jolt()` would
    // be correct too, but it allocates (and used to hand back - and then free - the caller's own
    // object, issue #76).
    set linearVelocity(value: THREE.Vector3) {
        this.character.SetLinearVelocity(joltScratch.vec3(value));
    }
    get position(): THREE.Vector3 {
        return vec3.three(this.character.GetPosition());
    }
    set position(value: THREE.Vector3) {
        this.character.SetPosition(joltScratch.rvec3(value));
    }
    get rotation(): THREE.Quaternion {
        return quat.three(this.character.GetRotation());
    }
    set rotation(value: THREE.Quaternion) {
        this.character.SetRotation(joltScratch.quat(value));
    }
    //read-only
    get worldTransform(): THREE.Matrix4 {
        const transform = this.character.GetWorldTransform();
        //TODO are these references or new objects that need destroying?
        const position = vec3.three(transform.GetTranslation());
        const rotation = quat.three(transform.GetQuaternion());
        return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
    }
    // read-only
    get centerOfMassTransform(): THREE.Matrix4 {
        const transform = this.character.GetCenterOfMassTransform();
        //TODO are these references or new objects that need destroying?
        const position = vec3.three(transform.GetTranslation());
        const rotation = quat.three(transform.GetQuaternion());
        return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
    }
    get mass(): number {
        return this.character.GetMass();
    }
    set mass(value: number) {
        this.character.SetMass(value);
    }
    get maxStrength(): number {
        return this.character.GetMaxStrength();
    }
    // from character base --------------------------------
    get maxCosSlopeAngle(): number {
        return this.character.GetCosMaxSlopeAngle();
    }
    set maxSlopeAngle(value: number) {
        this.character.SetMaxSlopeAngle(value);
    }
    get up(): THREE.Vector3 {
        return vec3.three(this.character.GetUp());
    }
    set up(value: THREE.Vector3) {
        this.character.SetUp(joltScratch.vec3(value));
    }
    // Ground Properties ----------------------------------
    //Tell if we are flying, sliding, etc (Read-only)
    get groundState(): string | undefined {
        const joltState = this.character.GetGroundState();
        switch (joltState) {
            case Raw.module.EGroundState_OnGround:
                return 'OnGround';
            case Raw.module.EGroundState_OnSteepGround:
                return 'OnSteepGround';
            case Raw.module.EGroundState_InAir:
                return 'InAir';
            case Raw.module.EGroundState_NotSupported:
                return 'NotSupported';
        }
        return undefined;
        //TODO do we need to destroy joltState?
    }
    get isFalling(): boolean {
        if (this.isSupported) return false;
        const verticalVelocity = this.up.clone().multiplyScalar(this.linearVelocity.dot(this.up));
        return verticalVelocity.y - this.groundVelocity.y < 0.1;
    }
    get isSupported(): boolean {
        return this.character.IsSupported();
    }
    get groundNormal(): THREE.Vector3 {
        return vec3.three(this.character.GetGroundNormal());
    }
    get groundPosition(): THREE.Vector3 {
        return vec3.three(this.character.GetGroundPosition());
    }
    get groundVelocity(): THREE.Vector3 {
        return vec3.three(this.character.GetGroundVelocity());
    }
    get groundMaterial(): any {
        return this.character.GetGroundMaterial();
    }
    get groundBodyHandle(): any {
        return this.character.GetGroundBodyID().GetIndexAndSequenceNumber();
        //TODO do we need to destroy the bodyID?
    }

    // Rare ----------------------------------------------
    get penetrationRecoverySpeed(): number {
        return this.character.GetPenetrationRecoverySpeed();
    }
    set penetrationRecoverySpeed(value: number) {
        this.character.SetPenetrationRecoverySpeed(value);
    }
    // read-only
    get characterPadding(): number {
        return this.character.GetCharacterPadding();
    }
    get maxNumHits(): number {
        return this.character.GetMaxNumHits();
    }
    set maxNumHits(value: number) {
        this.character.SetMaxNumHits(value);
    }
    get shapeOffset(): THREE.Vector3 {
        return vec3.three(this.character.GetShapeOffset());
    }
    set shapeOffset(value: THREE.Vector3) {
        this.character.SetShapeOffset(joltScratch.vec3(value));
    }

    //* Contact Listeners =================================

    initCharacterContactListener() {
        this.characterContactListener = new Raw.module.CharacterContactListenerJS();
        this.characterContactListener.OnAdjustBodyVelocity = (
            _character: Jolt.CharacterVirtual,
            body2: Jolt.Body,
            linearVelocity: Jolt.Vec3,
            _angularVelocity: Jolt.Vec3
        ) => {
            //@ts-ignore wrapPointer TS error
            body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
            //@ts-ignore
            linearVelocity = Raw.module.wrapPointer(linearVelocity, Raw.module.Vec3);
            // get the body we are colliding with

            const body2State = this.bodySystem.getBody(body2.GetID().GetIndexAndSequenceNumber());
            // check if the body is a teleporter
            if (body2State) {
                if (body2State.isTeleporter && body2State.teleporterVector) {
                    this.position = body2State?.teleporterVector;
                }

                //check if the body is a conveyor
                if (body2State.isConveyor && body2State.conveyorVector) {
                    // `Add` returns a new (leaked) vector and leaves `linearVelocity` alone;
                    // write the sum back into the vector Jolt handed us instead.
                    const conveyor = body2State.conveyorVector;
                    linearVelocity.Set(
                        linearVelocity.GetX() + conveyor.x,
                        linearVelocity.GetY() + conveyor.y,
                        linearVelocity.GetZ() + conveyor.z
                    );
                }
            }
        };
        this.characterContactListener.OnContactValidate = (
            character: Jolt.CharacterVirtual,
            bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID
        ) => {
            //@ts-ignore wrapPointer TS error
            bodyID2 = Raw.module.wrapPointer(bodyID2, Raw.module.Body);
            //@ts-ignore wrapPointer TS error
            character = Raw.module.wrapPointer(character, Raw.module.Body);
            // this seems to be a space to trigger sensors
            return true;
        };
        // #79/#80/#187: forward the contacts Jolt actually reports. Every one of these is a
        // number from emscripten's glue; `queueContact` bails out on the event mask before it
        // wraps anything, so an unsubscribed stream costs one `&` per contact.
        this.characterContactListener.OnContactAdded = (
            _character: number,
            bodyID2: number,
            subShapeID2: number,
            contactPosition: number,
            contactNormal: number,
            _settings: number
        ) => this.queueContact(0, bodyID2, subShapeID2, contactPosition, contactNormal);
        this.characterContactListener.OnContactSolve = (
            character: any,
            _bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID,
            _contactPosition: Jolt.Vec3,
            contactNormal: Jolt.Vec3,
            contactVelocity: Jolt.Vec3,
            _contactMaterial: Jolt.PhysicsMaterial,
            _characterVelocity: Jolt.Vec3,
            newCharacterVelocity: Jolt.Vec3
        ) => {
            character = Raw.module.wrapPointer(character, Raw.module.Body);
            //@ts-ignore wrapPointer TS error
            contactVelocity = Raw.module.wrapPointer(contactVelocity, Raw.module.Vec3);
            //@ts-ignore
            newCharacterVelocity = Raw.module.wrapPointer(newCharacterVelocity, Raw.module.Vec3);
            //@ts-ignore
            contactNormal = Raw.module.wrapPointer(contactNormal, Raw.module.Vec3);

            if (
                !this.allowSliding &&
                contactVelocity.IsNearZero() &&
                !this.character.IsSlopeTooSteep(contactNormal)
            ) {
                // Dont allow the character to slide
                newCharacterVelocity.SetX(0);
                newCharacterVelocity.SetY(0);
                newCharacterVelocity.SetZ(0);
            }
        };

        // jolt-physics 0.32 grew the CharacterContactListener interface. Emscripten's
        // JSImplementation binding throws "a JSImplementation must implement all functions" the
        // moment Jolt calls one that JavaScript has not assigned - but the check is lazy, one
        // per call site, so only the callbacks Jolt actually reaches have to exist.
        //
        // Measured against jolt-physics 1.1.0 (test/character-contact-listener.test.ts): Jolt
        // calls exactly six of the eleven declared callbacks for a CharacterVirtual stepping
        // against bodies. The five character-vs-character variants only fire once a
        // CharacterVsCharacterCollision is installed, which this controller never does, so
        // their no-op assignments were dead code and are gone. The test fails if that changes.
        //
        // Their argument lists are not in the 1.1.0 typings (only four of the eleven callbacks
        // are), so they were settled at runtime: `OnContactPersisted` has the same six arguments
        // as `OnContactAdded`, `OnContactRemoved` has three and no geometry at all.
        this.characterContactListener.OnContactPersisted = (
            _character: number,
            bodyID2: number,
            subShapeID2: number,
            contactPosition: number,
            contactNormal: number,
            _settings: number
        ) => this.queueContact(1, bodyID2, subShapeID2, contactPosition, contactNormal);
        this.characterContactListener.OnContactRemoved = (
            _character: number,
            bodyID2: number,
            subShapeID2: number
        ) => this.queueContact(2, bodyID2, subShapeID2);
    }

    /**
     * Copy one contact out of the Jolt callback. Nothing Jolt owns outlives this function, and
     * nothing user facing runs here: `ExtendedUpdate` is still on the stack.
     */
    private queueContact(
        kind: number,
        bodyIDPtr: number,
        subShapeIDPtr: number,
        positionPtr?: number,
        normalPtr?: number
    ): void {
        const bit =
            kind === 0
                ? CharacterEventBit.contactAdded
                : kind === 1
                  ? CharacterEventBit.contactPersisted
                  : CharacterEventBit.contactRemoved;
        if ((this.events.mask & bit) === 0) return;
        const jolt = Raw.module;
        let record = this.contactQueue[this.contactQueueCount];
        if (!record) {
            record = {
                kind: 0,
                handle: 0,
                subShapeId: -1,
                px: 0,
                py: 0,
                pz: 0,
                nx: 0,
                ny: 0,
                nz: 0
            };
            this.contactQueue[this.contactQueueCount] = record;
        }
        this.contactQueueCount++;
        record.kind = kind;
        record.handle = jolt.wrapPointer(bodyIDPtr, jolt.BodyID).GetIndexAndSequenceNumber();
        record.subShapeId = jolt.wrapPointer(subShapeIDPtr, jolt.SubShapeID).GetValue();
        if (positionPtr === undefined || normalPtr === undefined) {
            record.px = 0;
            record.py = 0;
            record.pz = 0;
            record.nx = 0;
            record.ny = 0;
            record.nz = 0;
            return;
        }
        const position = jolt.wrapPointer(positionPtr, jolt.RVec3);
        record.px = position.GetX();
        record.py = position.GetY();
        record.pz = position.GetZ();
        const normal = jolt.wrapPointer(normalPtr, jolt.Vec3);
        record.nx = normal.GetX();
        record.ny = normal.GetY();
        record.nz = normal.GetZ();
    }

    /**
     * Dispatch the contacts this update queued, once `ExtendedUpdate` has returned. Handlers may
     * therefore do anything, including adding and removing bodies.
     */
    private flushContacts(): void {
        const count = this.contactQueueCount;
        if (count === 0) return;
        // reset first: a handler that provokes another update must not re-dispatch these
        this.contactQueueCount = 0;
        const payload = this.contactPayload;
        for (let i = 0; i < count; i++) {
            const record = this.contactQueue[i];
            const state = this.bodySystem.getBody(record.handle);
            payload.handle = record.handle;
            payload.subShapeId = record.subShapeId;
            payload.body = state;
            payload.object = state?.object;
            payload.position.set(record.px, record.py, record.pz);
            payload.normal.set(record.nx, record.ny, record.nz);
            this.events.emit(CONTACT_EVENT_NAME[record.kind], payload);
        }
    }
    // create the core character
    initCharacter() {
        const settings = new Raw.module.CharacterVirtualSettings();
        settings.mMass = 1000;
        settings.mMaxSlopeAngle = MathUtils.degToRad(45.0);
        settings.mMaxStrength = 100;
        settings.mShape = this.standingShape;
        settings.mBackFaceMode = Raw.module.EBackFaceMode_CollideWithBackFaces;
        settings.mCharacterPadding = 0.02;
        settings.mPenetrationRecoverySpeed = 1;
        settings.mPredictiveContactDistance = 0.1;
        // `sAxisY()` is a static temporary returned by value - it must never be destroyed (see
        // the memory notes in core's shape-system.ts). `mSupportingVolume` is a Plane by value,
        // so the assignment copies and the plane we built here is ours to free.
        const supportingVolume = new Raw.module.Plane(
            Raw.module.Vec3.prototype.sAxisY(),
            -this.characterRadiusStanding
        );
        settings.mSupportingVolume = supportingVolume;
        this.character = new Raw.module.CharacterVirtual(
            settings,
            // sZero()/sIdentity() are static temporaries too: not allocations, never destroyed
            Raw.module.RVec3.prototype.sZero(),
            Raw.module.Quat.prototype.sIdentity(),
            this.physicsSystem.physicsSystem
        );
        this.character.SetListener(this.characterContactListener);

        this.threeObject.userData.body = this.character;

        // CharacterVirtual has copied everything it needs out of the settings by now
        Raw.module.destroy(supportingVolume);
        Raw.module.destroy(settings);
    }

    // create the anchor object for rigs
    private createAnchor() {
        // `Create().Get()` hands back a shape owned by a *static* ShapeResult whose reference is
        // dropped by the next Create() anywhere in the process; createShapeFromSettings takes a
        // real reference (and destroys the settings) so the shape survives until we release it.
        const shape = createShapeFromSettings(new Raw.module.SphereShapeSettings(0.5));
        const bodySettings = generateBodySettings(shape, {
            bodyType: 'kinematic'
        });
        const anchor = this.physicsSystem.bodyInterface.CreateBody(bodySettings);
        anchor.SetIsSensor(true);
        this.anchorID = anchor.GetID();
        // we have to generate a correct bodyState
        this.anchorHandle = this.physicsSystem.bodySystem.addExistingBody(
            new THREE.Object3D(),
            anchor
        );
        this.anchor = this.physicsSystem.bodySystem.getBody(this.anchorHandle);

        // cleanup: the settings and the body both hold their own reference on the shape now
        Raw.module.destroy(bodySettings);
        releaseShape(shape);
    }
    // set the capsule shape for the character
    setCapsule(radius: number, height: number) {
        if (height) {
            this.characterHeightStanding = height;
            this.characterHeightCrouching = height * 0.5;
        }
        if (radius) {
            this.characterRadiusStanding = radius;
            this.characterRadiusCrouching = radius;
        }

        // shapes from a previous call are released once the new ones are in place, below
        const previousStanding = this.activeStandingShape;
        const previousCrouching = this.activeCrouchingShape;

        this.standingShape = this.createCapsuleShape(
            0.5 * this.characterHeightStanding,
            this.characterRadiusStanding
        );
        this.crouchingShape = this.createCapsuleShape(
            0.5 * this.characterHeightCrouching,
            this.characterRadiusCrouching
        );

        // if the debug meshes already exist, destroy them
        if (this.standingMesh) this.destroyDebugMesh(this.standingMesh);
        if (this.crouchingMesh) this.destroyDebugMesh(this.crouchingMesh);
        // create the geometry for debugging
        this.standingMesh = this.createDebugMesh(radius, height);
        this.crouchingMesh = this.createDebugMesh(radius, height * 0.5, '#00ff00');

        // finally set the shape
        this.shape = this.standingShape;

        // the character now holds its own reference on the new shape, so the references this
        // instance took for the previous pair can go. Destroying them outright (the commented
        // out `destroy(standingSettings)` this replaces) is what used to crash: shapes are
        // reference counted and the character was still using them.
        releaseShape(previousStanding);
        releaseShape(previousCrouching);
    }

    /**
     * A capsule offset so the character's origin sits at its feet.
     *
     * Ownership: `RotatedTranslatedShapeSettings` holds the inner `CapsuleShapeSettings` in a
     * `RefConst`, so destroying the outer settings (which `createShapeFromSettings` does) frees
     * the inner one too - freeing it here as well would be a double free. The position vector is
     * copied into the settings, so that one *is* ours.
     */
    private createCapsuleShape(halfHeight: number, radius: number): Jolt.Shape {
        const position = new Raw.module.Vec3(0, halfHeight + radius, 0);
        const settings = new Raw.module.RotatedTranslatedShapeSettings(
            position,
            // static temporary, not an allocation - never destroy it
            Raw.module.Quat.prototype.sIdentity(),
            new Raw.module.CapsuleShapeSettings(halfHeight, radius)
        );
        Raw.module.destroy(position);
        return createShapeFromSettings(settings);
    }
    //* Scene Functions ========================================
    // attach the character to a scene
    addToScene(scene: THREE.Scene) {
        scene.add(this.threeObject);
    }
    add(object: THREE.Object3D) {
        this.threeObject.add(object);
    }
    removeFromScene() {
        this.threeObject.parent?.remove(this.threeObject);
    }

    //* loop functions ========================================

    prePhysicsUpdate(deltaTime: number) {
        // `destroy()` removes this from the step listeners, but a listener captured mid-step (or
        // a caller driving the update by hand) must not dereference the freed CharacterVirtual.
        if (this.destroyed) return;
        // locks the character in a up position
        // TODO: consider angular velocity to slightly rotate (wolfram GDC2014)
        this.applyRotation();
        this.applyMovement(deltaTime);

        this.character.ExtendedUpdate(
            deltaTime,
            this.character.GetUp(),
            this.updateSettings,
            //@ts-ignore
            this.filters.movingBPFilter,
            this.filters.movingLayerFilter,
            this.filters.bodyFilter,
            this.filters.shapeFilter,
            this.joltInterface.GetTempAllocator()
        );
        // move the three object
        this.threeObject.position.lerp(vec3.three(this.character.GetPosition()), this.lerpFactor);
        this.threeObject.quaternion.slerp(
            quat.three(this.character.GetRotation()),
            this.lerpFactor
        );
        //console.log('character position', vec3.three(this.character.GetPosition()	);
        // update the anchor
        this.anchor.setPositionAndRotation(this.threeObject.position, this.threeObject.quaternion);

        // Everything user facing happens here, once the character update has returned: the
        // contacts Jolt queued from inside it, then the state edges derived from the result.
        this.flushContacts();
        this.updateMotionState(deltaTime);
    }

    /**
     * Recompute `isGrounded` / `isMoving` / `isSliding` and emit the edges (#79, #80).
     *
     * Movement is measured **relative to whatever is carrying the character**: Jolt's
     * `GetLinearVelocity()` on a moving platform already includes the platform's velocity, so
     * subtracting `GetGroundVelocity()` is what stops a ride reading as a walk - the open
     * question in #79. Sliding is the tangential part of that same relative velocity, measured
     * against the ground plane, and only counts on a surface too steep to stand on.
     *
     * Allocation free: every `Get*` below returns a Jolt static temporary, read straight into
     * the reusable three.js vectors and never destroyed.
     */
    private updateMotionState(deltaTime: number): void {
        const jolt = Raw.module;
        const character = this.character;
        const groundState = character.GetGroundState();
        const supported =
            groundState === jolt.EGroundState_OnGround ||
            groundState === jolt.EGroundState_OnSteepGround;

        const up = this._stateUp;
        const jup = character.GetUp();
        up.set(jup.GetX(), jup.GetY(), jup.GetZ());

        // velocity relative to the ground, so a moving platform is not movement
        const relative = this._stateVelocity;
        const velocity = character.GetLinearVelocity();
        relative.set(velocity.GetX(), velocity.GetY(), velocity.GetZ());
        if (supported) {
            const ground = character.GetGroundVelocity();
            relative.x -= ground.GetX();
            relative.y -= ground.GetY();
            relative.z -= ground.GetZ();
        }

        // horizontal (up-plane) part drives isMoving; the ground-plane part drives isSliding
        const alongUp = relative.dot(up);
        const moveSpeed = Math.sqrt(Math.max(0, relative.lengthSq() - alongUp * alongUp));

        const plane = this._stateNormal;
        if (supported) {
            const normal = character.GetGroundNormal();
            plane.set(normal.GetX(), normal.GetY(), normal.GetZ());
        } else plane.copy(up);
        const alongPlane = relative.dot(plane);
        const slideSpeed = Math.sqrt(Math.max(0, relative.lengthSq() - alongPlane * alongPlane));

        // Grounded --------------------------------------------------------
        if (supported !== this._isGrounded) {
            this._isGrounded = supported;
            if (supported) {
                const airtime = this.airtime;
                this.airtime = 0;
                this.emitEvent('ground');
                this.emitEvent('land', airtime);
            } else this.emitEvent('airborne');
        }
        if (!supported) this.airtime += deltaTime;

        // Moving ----------------------------------------------------------
        // Hysteresis: a walk has to clear the threshold to start and drop to half of it to end,
        // so a character hovering at exactly the threshold does not emit an event per step.
        const moving = this._isMoving
            ? moveSpeed > this.moveThreshold * 0.5
            : moveSpeed > this.moveThreshold;
        if (moving !== this._isMoving) {
            this._isMoving = moving;
            if (moving) this.emitEvent('move', moveSpeed);
            else this.emitEvent('stop');
        }

        // Sliding ---------------------------------------------------------
        // Only a surface that cannot support the character counts: `OnSteepGround` is Jolt's own
        // verdict, and `NotSupported` is touching something that is not a floor at all.
        const onSlope =
            groundState === jolt.EGroundState_OnSteepGround ||
            groundState === jolt.EGroundState_NotSupported;
        const sliding =
            onSlope &&
            (this._isSliding
                ? slideSpeed > this.slideThreshold * 0.5
                : slideSpeed > this.slideThreshold);
        if (sliding !== this._isSliding) {
            this._isSliding = sliding;
            if (sliding) this.emitEvent('slide', slideSpeed);
            else this.emitEvent('slideEnd');
        }
    }

    /**
     * Emit a typed event *and* the matching `action`, so `controller.on('move', fn)` (the older
     * action-filtered API) and `controller.events.on('move', fn)` agree about what happened.
     */
    private emitEvent<K extends keyof CharacterEventMap>(
        type: K,
        // biome-ignore lint/suspicious/noExplicitAny: forwarded straight to the emitter
        ...args: any[]
    ): void {
        // biome-ignore lint/suspicious/noExplicitAny: see above
        this.events.emit(type, ...(args as any));
        this.triggerActionListeners(type, args[0]);
    }
    //* Movement Functions ========================================
    // Rotate with slerp
    setRotation(rotation: THREE.Quaternion) {
        this.targetRotation = rotation;
        this.currentRotationSlerp = 0;
        this.isRotating = true;
    }
    private applyRotation() {
        if (this.isRotating) {
            this.currentRotationSlerp += this.maxRotationSpeed;
            if (this.currentRotationSlerp >= 1) {
                this.currentRotationSlerp = 1;
                this.isRotating = false;
            }
            const newRot = this.rotation
                .clone()
                .slerp(this.targetRotation, this.currentRotationSlerp);

            this.rotation = newRot;
        }
    }
    // set the movement input
    move(direction: THREE.Vector3) {
        this.movementInput = direction;
        // rotate based on the direction
        if (this.enableCharacterRotation && direction.length() > 0)
            this.setRotation(
                new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction)
            );
    }

    // move the character in space
    private applyMovement(deltaTime = 1) {
        const movementDirection = this.movementInput.clone();

        // can the user defy physics and move while airborne
        // also if the user passes a direction (allows jump without direction input)
        const playerControlsHorizontalVelocity =
            this.allowAirbornControl || this.character.IsSupported();
        if (playerControlsHorizontalVelocity) {
            // True if the player intended to move
            this.allowSliding = !(movementDirection.length() < 1.0e-12);
            // Smooth the player input
            if (this.enableCharacterInertia) {
                //degrades the inertia by a small value
                this.desiredVelocity.multiplyScalar(0.75);
                this.desiredVelocity.add(movementDirection.multiplyScalar(0.25 * this.activeSpeed));
            } else {
                // apply the velocity directly
                this.desiredVelocity.copy(movementDirection).multiplyScalar(this.activeSpeed);
            }
        } else {
            // While in air we allow sliding
            this.allowSliding = true;
        }
        // This is like a tick to make sure the ground velocity is up to date
        this.character.UpdateGroundVelocity();

        const characterUp = this.up;
        const linearVelocity = this.linearVelocity;
        const currentVerticalVelocity = characterUp
            .clone()
            .multiplyScalar(linearVelocity.dot(characterUp));
        const groundVelocity = this.groundVelocity;
        const gravity = vec3.joltToThree(this.physicsSystem.physicsSystem.GetGravity());

        let newVelocity: any;
        const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y < 0.1;

        // notify the user we are falling
        if (this.isFalling) {
            if (this.hangtime === 0) this.triggerActionListeners('falling', true);
            this.hangtime += deltaTime;
        }
        // If on ground and not moving away from ground
        if (
            this.character.GetGroundState() === Raw.module.EGroundState_OnGround && // If on ground
            (this.enableCharacterInertia
                ? movingTowardsGround // Inertia enabled: And not moving away from ground
                : !this.character.IsSlopeTooSteep(this.character.GetGroundNormal()))
        ) {
            //reset the falling counter
            if (this.hangtime > 0) {
                this.triggerActionListeners('falling', this.hangtime);
                this.hangtime = 0;
            }
            // reset the jump counter
            this.jumpCounter = 0;
            // Inertia disabled: And not on a slope that is too steep
            // Assume velocity of ground when on ground
            newVelocity = groundVelocity;
        } else newVelocity = currentVerticalVelocity.clone();

        //
        // JUMP. Double jump or on the ground
        //
        if (this.isJumping) {
            //block jump if falling
            if (this.isFalling && !this.allowJumpWhileFalling) return;
            // block double jump if exhausted
            if (this.jumpCounter >= 1 && this.isExhausted && this.exhaustionBlocksDoubleJump)
                return;
            // if we allow double jump.
            if (this.jumpCounter < this.jumpLimit) {
                this.jumpCounter++;
                this.events.emit('jump', this.jumpCounter);
                this.triggerActionListeners('jump', this.jumpCounter);
                const jumpSpeed =
                    this.exhaustionEffectsJump && this.isExhausted
                        ? this.jumpSpeed / 2
                        : this.jumpSpeed;
                newVelocity.add(characterUp.multiplyScalar(jumpSpeed));
                this.isJumping = false;
            }
        }
        const upRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(), this.up);

        // Gravity
        newVelocity.add(gravity.multiplyScalar(deltaTime).applyQuaternion(upRotation));

        if (playerControlsHorizontalVelocity) {
            // Player input
            newVelocity.add(this.desiredVelocity.clone().applyQuaternion(upRotation));
        } else {
            // Preserve horizontal velocity
            const currentHorizontalVelocity = linearVelocity.sub(currentVerticalVelocity);
            newVelocity.add(currentHorizontalVelocity);
        }

        this._tmpVec3.Set(newVelocity.x, newVelocity.y, newVelocity.z);
        this.character.SetLinearVelocity(this._tmpVec3);
    }
    // TODO Fix this
    setCrouched = (crouched: boolean, forceUpdate?: boolean) => {
        if (this.destroyed) return;
        if (crouched !== this.isCrouched || forceUpdate) {
            // clear any crouching intervals (if we were blocked to stand)
            if (this.crouchingInterval) clearInterval(this.crouchingInterval);

            const newShape = crouched ? this.crouchingShape : this.standingShape;
            const tryShape = this.character.SetShape(
                newShape,
                1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
                //@ts-ignore
                this.filters.movingBPFilter,
                this.filters.movingLayerFilter,
                this.filters.bodyFilter,
                this.filters.shapeFilter,
                this.joltInterface.GetTempAllocator()
            );
            if (tryShape) {
                // Accept the new shape only when the SetShape call was successful
                this.isCrouched = crouched;
                // move the character back
                //this.position = position;
                if (this.isDebugging) {
                    this.standingMesh.visible = !crouched;
                    this.crouchingMesh.visible = crouched;
                }
                this.events.emit(crouched ? 'crouch' : 'stand');
                this.triggerActionListeners('crouched', crouched);
            } else {
                this.crouchingInterval = setInterval(() => {
                    this.setCrouched(crouched, true);
                }, 500);
            }
        }
    };

    // Primary Movement functions =============================
    jump() {
        if (this.destroyed) return;
        this.isJumping = true;
        // TODO, is this still needed?
        // timer handles are kept so destroy() can clear them - an unmounted controller must not
        // keep firing callbacks that touch freed jolt objects.
        this.jumpTimer = setTimeout(() => {
            this.isJumping = false;
        }, 100);
    }
    startRunning(speed?: any) {
        if (this.destroyed) return;
        if (!this.allowRunning || this.isExhausted || this.isCrouched) return;
        const newSpeed = speed || this.characterSpeed * 2;
        this.activeSpeed = newSpeed;
        //notify
        this.triggerActionListeners('running', newSpeed);
        // start the running timeer to trigger exhaustion
        if (this.enableExhaustion)
            this.runningTimer = setTimeout(() => {
                this.isExhausted = true;
                this.activeSpeed = this.characterSpeedExhausted;
                this.triggerActionListeners('exhausted', this.exauhstionTimeLimit);
                // once exhausted, we can never stop.
                this.exhaustionTimer = setTimeout(() => {
                    this.isExhausted = false;
                    this.activeSpeed = this.characterSpeed;
                    this.triggerActionListeners('exausted', false);
                }, this.exauhstionTimeLimit);
            }, this.runningTimeLimit);
    }
    stopRunning() {
        this.activeSpeed = this.characterSpeed;
        clearTimeout(this.runningTimer);
        this.triggerActionListeners('running', 0);
    }

    //* Action Listener Functions ----------------------------
    /** Subscribe to every action. Returns the unsubscribe. */
    addActionListener = (listener: CharacterActionCallback): Unsubscribe => {
        const off = this.events.on('action', listener);
        const subs = this.legacyActionSubs.get(listener);
        if (subs) subs.push(off);
        else this.legacyActionSubs.set(listener, [off]);
        return off;
    };
    /**
     * @deprecated identity based removal; keep the function {@link addActionListener} returns.
     * Removes every subscription made for `listener`.
     */
    removeActionListener = (listener: CharacterActionCallback) => {
        const subs = this.legacyActionSubs.get(listener);
        if (!subs) return;
        this.legacyActionSubs.delete(listener);
        for (const off of subs) off();
    };
    // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
    triggerActionListeners = (action: any, payload?: any) => {
        if (this.isDebugging && this.debugVerbose)
            console.log('Character Controller:', action, payload);
        this.events.emit('action', action, payload);
    };
    // watch function takes an action and a callback and adds the correct listener
    // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
    on = (action: any, callback: (action: any, payload?: any) => void): Unsubscribe =>
        // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
        this.events.on('action', (a: any, payload?: any) => {
            if (a === action) callback(a, payload);
        });

    //* Debug mesh functions =================================
    // create a debug mesh for the character with arrow shape
    createDebugMesh(radius: number, height: number, color = 'red', nose = true) {
        const geometry = new THREE.CapsuleGeometry(radius, height, 8);
        geometry.translate(0, 0.5 * height + radius, 0);
        const material = new THREE.MeshPhongMaterial({ color: color, wireframe: true });
        const cylinder = new THREE.Mesh(geometry, material);
        if (nose) {
            const noseGeometry = new THREE.BoxGeometry(0.1, 0.5, 1);
            const noseMaterial = new THREE.MeshPhongMaterial({ color: 'orange' });
            const nose = new THREE.Mesh(noseGeometry, noseMaterial);
            cylinder.add(nose);
            nose.position.set(0, 0.5 * height + radius, -radius);
        }
        this.threeObject.add(cylinder);
        return cylinder;
    }
    destroyDebugMesh(mesh: THREE.Mesh) {
        this.threeObject.remove(mesh);
        // destroy the mesh geometry and material
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        //the mesh itself will cleanup as it wont have a reference
    }

    //* Util functions ----------------------------------

    isSlopeTooSteep(normal: THREE.Vector3) {
        // `threeToJolt` allocates; this is called per contact so use the shared scratch vector
        // (`IsSlopeTooSteep` only reads it).
        return this.character.IsSlopeTooSteep(joltScratch.vec3(normal));
    }
}
