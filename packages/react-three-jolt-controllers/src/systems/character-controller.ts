/* We do this as a class so it's not bound to a react component
so much and can be reused for things like NPC's */

import {
    type BodySystem,
    createShapeFromSettings,
    generateBodySettings,
    joltScratch,
    Layer,
    type PhysicsSystem,
    quat,
    Raw,
    releaseShape,
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

    protected actionListeners: any = [];

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
    isMoving = false;
    isSliding = false;
    isRunning = false;
    isExhausted = false;

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
        // Finally, attach to main loop
        this.physicsSystem.addPreStepListener(this.handlePreStep);
    }

    /**
     * Free everything this controller owns: the step listener, every timer, the three meshes and
     * every `new Raw.module.*` allocation (issue #138). Idempotent - a second call is a no-op, so
     * an explicit `destroy()` plus a React unmount (or StrictMode's double invoke) is safe.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        // stop being stepped before anything is freed: everything below is memory the step reads
        this.physicsSystem.removeStepListener(this.handlePreStep);
        this.clearTimers();
        this.actionListeners = [];

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
        this.characterContactListener.OnContactAdded = (
            _character: Jolt.CharacterVirtual,
            _bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID,
            _contactPosition: Jolt.Vec3,
            _contactNormal: Jolt.Vec3,
            _settings: any
        ) => {
            // not using this at the moment
        };
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

        // jolt-physics 0.32 grew the CharacterContactListener interface (persisted/removed
        // contacts, and the character-vs-character variants). Emscripten's JSImplementation
        // binding throws "a JSImplementation must implement all functions" the moment Jolt calls
        // one that JavaScript has not assigned, so every remaining callback gets the no-op /
        // accept-everything behaviour this listener had before those functions existed.
        this.characterContactListener.OnContactPersisted = () => {};
        this.characterContactListener.OnContactRemoved = () => {};
        this.characterContactListener.OnCharacterContactValidate = () => true;
        this.characterContactListener.OnCharacterContactAdded = () => {};
        this.characterContactListener.OnCharacterContactPersisted = () => {};
        this.characterContactListener.OnCharacterContactRemoved = () => {};
        this.characterContactListener.OnCharacterContactSolve = () => {};
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
    addActionListener = (listener: any) => {
        this.actionListeners.push(listener);
    };
    removeActionListener = (listener: any) => {
        this.actionListeners = this.actionListeners.filter((l: any) => l !== listener);
    };
    triggerActionListeners = (action: any, payload?: any) => {
        if (this.isDebugging && this.debugVerbose)
            console.log('Character Controller:', action, payload);
        //@ts-ignore
        this.actionListeners.forEach((listener) => listener(action, payload));
    };
    // watch function takes an action and a callback and adds the correct listener
    on = (action: any, callback: any) => {
        const listener = (a: any) => {
            if (a === action) callback();
        };
        this.addActionListener(listener);
        return () => this.removeActionListener(listener);
    };

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
