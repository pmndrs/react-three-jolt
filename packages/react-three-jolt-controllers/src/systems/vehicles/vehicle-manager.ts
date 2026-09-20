import {
    createShapeFromSettings,
    Emitter,
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
import {
    type BodyRollSettings,
    type ResolvedBodyRollSettings,
    type ResolvedFourWheelVehicleSettings,
    type ResolvedSkidSettings,
    type ResolvedVehicleSettings,
    type ResolvedWheelSmoothingSettings,
    resolveBodyRoll,
    resolveSkid,
    resolveVehicleSettings,
    resolveWheelSmoothing,
    type SkidSettings,
    type VehicleSettings,
    type WheelSmoothingSettings
} from './vehicle-settings';
import { SKID_STARTED, WheelState } from './wheel-state';
import { createWheelSettings, disposeGeneratedObject } from './wheels';

// biome-ignore lint/suspicious/noExplicitAny: the Jolt constraint callbacks are untyped here
type VehicleStepCallback = (vehicle: any, deltaTime: number, physicsSystem: any) => void;
// biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
type VehicleActionCallback = (action: any) => void;

/**
 * Issue #41: what a skidding wheel reports. The object handed to a listener is **pooled** - it
 * is the same one on every dispatch, so read what you need and copy anything you keep.
 */
export type VehicleSkidEvent = {
    /** the wheel that started or stopped skidding */
    wheel: WheelState;
    /** its name ('fl' | 'fr' | 'bl' | 'br', or 'front' | 'back') */
    name: string;
    /** its index in the constraint */
    index: number;
    /** jolt's longitudinal slip ratio at the moment of the transition */
    slipRatio: number;
    /** jolt's lateral slip angle, in radians */
    lateralSlip: number;
    /** the contact patch in world space. Pooled like the event: copy it if you keep it. */
    position: THREE.Vector3;
    /** the vehicle's forward speed in km/h */
    speedKmh: number;
};

/**
 * Issue #41: the engine readout, for audio and instruments. Pooled, exactly like
 * {@link VehicleSkidEvent} - never retain it.
 */
export type VehicleEngineState = {
    /** jolt's current engine RPM */
    rpm: number;
    /** 0 while in neutral, 1..n forward, negative in reverse */
    gear: number;
    /** the driver's throttle, 0..1 */
    throttle: number;
    /** the driver's brake input, 0..1 */
    brake: number;
    /** signed forward speed in metres per second */
    speed: number;
    /** signed forward speed in km/h */
    speedKmh: number;
    /** true while the transmission is between gears */
    shifting: boolean;
    /** the clutch friction, 0..1 */
    clutch: number;
    /** true while any wheel is skidding */
    skidding: boolean;
};

export type VehicleSkidListener = (event: VehicleSkidEvent) => void;
export type VehicleEngineListener = (state: VehicleEngineState) => void;

type VehicleEventMap = {
    preStep: VehicleStepCallback;
    postCollide: VehicleStepCallback;
    postStep: VehicleStepCallback;
    action: VehicleActionCallback;
    skidStart: VehicleSkidListener;
    skidEnd: VehicleSkidListener;
    engine: VehicleEngineListener;
};

/** the explicit integrator behind `bodyRoll` goes unstable if a frame is allowed to be huge */
const MAX_ROLL_STEP = 1 / 30;
const clamp = (value: number, limit: number) =>
    value < -limit ? -limit : value > limit ? limit : value;

const FL_WHEEL = 0;
const FR_WHEEL = 1;
const BL_WHEEL = 2;
const BR_WHEEL = 3;

/** a listener registered through `onPreStep` / `onPostCollide` / `onPostStep` */
export type VehicleStepListener = (
    vehicle: Jolt.VehicleConstraint,
    deltaTime: number,
    physicsSystem: Jolt.PhysicsSystem
) => void;
export type VehicleActionListener = (action: string, vehicle: VehicleManager) => void;

/**
 * The base of every vehicle. It owns a chassis body, a `VehicleConstraint` (with its controller,
 * wheels and collision tester), the step listener jolt drives it with, and the three.js objects
 * that are synced to all of it.
 *
 * Three.js ownership (issues #26 and #27): `threeObject` follows the chassis body and each
 * `WheelState.threeObject` follows its wheel. Objects the manager *generated* are disposed on
 * teardown; objects a caller injected through `setBodyObject()` / `setWheelObject()` are only
 * detached again.
 */
export class VehicleManager {
    physicsSystem: PhysicsSystem;
    settings: ResolvedVehicleSettings;
    /** Assigned by `createBody()`, which the constructor calls. */
    carBody!: Jolt.Body;
    /** Assigned by `createConstraint()`, which the constructor calls. */
    constraint!: Jolt.VehicleConstraint;
    /** Assigned by `createConstraint()`, which the constructor calls. */
    controller!: Jolt.VehicleController;

    // Listeners for the vehicle constraint callbacks and for actions, all on the one Emitter
    // primitive (issue #50) so removal never depends on function identity.
    protected events = new Emitter<VehicleEventMap>();

    /**
     * The Jolt step listener driving the constraint's own pre/post step work. `AddStepListener`
     * stores a raw pointer, so this instance is ours to remove and free - it used to be
     * constructed anonymously, which made it impossible to do either (issue #140).
     */
    protected constraintStepListener?: Jolt.VehicleConstraintStepListener;

    //this holds the threejs objects
    threeObject = new THREE.Object3D();
    /** the generated chassis mesh, when no `bodyObject` was injected */
    debugObject?: THREE.Mesh;
    wheels: Map<string, WheelState> = new Map();
    /** the names of the wheels in constraint index order */
    readonly wheelOrder: string[] = [];

    //input handling
    moveDirection = new THREE.Vector3();
    handBrake = false;
    brake = false;
    turboTimeLimit = 3; //seconds
    turboActiveTime = 0;
    turboActive = false;
    // set true for now
    isDebugging = true;

    previousForward = 1.0;

    /** true once `destroy()` has run */
    protected destroyed = false;
    /**
     * The callbacks Jolt calls into from the simulation. This used to be a local `const` in
     * `bindListeners`, so its only JavaScript reference was dropped while Jolt kept calling it.
     */
    protected callbacks?: Jolt.VehicleConstraintCallbacksEm;
    protected turboTimer?: ReturnType<typeof setTimeout>;
    /** issue #26: the chassis object the *user* gave us. Synced, never disposed. */
    private userBodyObject?: THREE.Object3D;

    //* Secondary physics (issue #41) =========================================================
    /** resolved `bodyRoll` options, or undefined while the visual tilt is off */
    protected bodyRollOptions?: ResolvedBodyRollSettings;
    /** resolved `wheelSmoothing` options, or undefined while the rendered values are raw */
    protected wheelSmoothingOptions?: ResolvedWheelSmoothingSettings;
    /** resolved `skid` options, or undefined while skid detection is off */
    protected skidOptions?: ResolvedSkidSettings;

    /** the chassis object's current visual lean, in radians (positive = leaning left) */
    bodyRollAngle = 0;
    /** the chassis object's current visual pitch, in radians (positive = nose up) */
    bodyPitchAngle = 0;
    private rollVelocity = 0;
    private pitchVelocity = 0;
    /** true once a velocity has been sampled, so the first frame doesn't read as a huge jerk */
    private hasPreviousVelocity = false;

    /**
     * The engine and gearbox of the controller. Both are members of the controller rather than
     * things we own: emscripten hands back the same cached wrapper for the same pointer, so
     * reading them every frame allocates nothing, and neither may ever be destroyed.
     */
    protected engine?: Jolt.VehicleEngine;
    protected transmission?: Jolt.VehicleTransmission;

    /** the pooled payload of `skidStart`/`skidEnd`. One object for the vehicle's whole life. */
    private readonly skidEvent: VehicleSkidEvent = {
        wheel: undefined as unknown as WheelState,
        name: '',
        index: 0,
        slipRatio: 0,
        lateralSlip: 0,
        position: new THREE.Vector3(),
        speedKmh: 0
    };
    /** the pooled payload of `engine` */
    private readonly engineState: VehicleEngineState = {
        rpm: 0,
        gear: 0,
        throttle: 0,
        brake: 0,
        speed: 0,
        speedKmh: 0,
        shifting: false,
        clutch: 0,
        skidding: false
    };

    //* Per frame scratch (three side) - avoids garbage in postPhysicsUpdate
    protected readonly _position = new THREE.Vector3();
    protected readonly _rotation = new THREE.Quaternion();
    private readonly _velocity = new THREE.Vector3();
    private readonly _previousVelocity = new THREE.Vector3();
    private readonly _acceleration = new THREE.Vector3();
    private readonly _tilt = new THREE.Euler();
    // the `speed` getter has its own pair: it is public, so it can be called from anywhere in a
    // frame, including from inside a handler that is in the middle of using the scratch above
    private readonly _speedVector = new THREE.Vector3();
    private readonly _speedRotation = new THREE.Quaternion();

    get position() {
        return this.threeObject.position;
    }

    //* Engine / audio readouts (issue #41) ===================================================
    /** the engine's current RPM, 0 when there is no engine (a destroyed vehicle) */
    get rpm(): number {
        return this.engine?.GetCurrentRPM() ?? 0;
    }
    /** 0 in neutral, 1..n forward, negative in reverse */
    get gear(): number {
        return this.transmission?.GetCurrentGear() ?? 0;
    }
    /** true while the transmission is between gears */
    get shifting(): boolean {
        return this.transmission?.IsSwitchingGear() ?? false;
    }
    /** the clutch friction, 0..1 */
    get clutch(): number {
        return this.transmission?.GetClutchFriction() ?? 0;
    }
    /** the driver's throttle, 0..1 (the absolute value of the forward input) */
    get throttle(): number {
        return Math.abs(this.wheeledController?.GetForwardInput() ?? 0);
    }
    /** the driver's brake input, 0..1 */
    get brakeInput(): number {
        return this.wheeledController?.GetBrakeInput() ?? 0;
    }
    /** the chassis' signed forward speed in metres per second */
    get speed(): number {
        if (this.destroyed || !this.carBody) return 0;
        // both getters return static temporaries; nothing here allocates
        const velocity = vec3.joltToThree(this.carBody.GetLinearVelocity(), this._speedVector);
        const rotation = quat.joltToThree(this.carBody.GetRotation(), this._speedRotation);
        return velocity.applyQuaternion(rotation.conjugate()).z;
    }
    /** the chassis' signed forward speed in km/h */
    get speedKmh(): number {
        return this.speed * 3.6;
    }
    /** true while any wheel is over the skid thresholds */
    get skidding(): boolean {
        for (let i = 0; i < this.wheelOrder.length; i++) {
            if (this.wheels.get(this.wheelOrder[i])?.isSkidding) return true;
        }
        return false;
    }

    /** the controller seen as a `WheeledVehicleController`; a `MotorcycleController` is one too */
    protected get wheeledController(): Jolt.WheeledVehicleController | undefined {
        return this.controller as Jolt.WheeledVehicleController | undefined;
    }
    /** whatever is being synced as the chassis: the user's object if there is one */
    get bodyObject(): THREE.Object3D | undefined {
        return this.userBodyObject ?? this.debugObject;
    }
    set debug(value) {
        this.isDebugging = value;
        if (this.debugObject) this.debugObject.visible = value;
        this.wheels.forEach((wheel) => {
            wheel.debug = value;
        });
    }
    get debug() {
        return this.isDebugging;
    }

    constructor(physicsSystem: PhysicsSystem, settings: VehicleSettings | ResolvedVehicleSettings) {
        // every entry point resolves its settings, so a manager constructed directly gets the
        // same defaults `VehicleSystem`/`useVehicle` would have given it
        this.settings = resolveVehicleSettings(settings as VehicleSettings);
        this.physicsSystem = physicsSystem;
        // issue #41: the presentational layer is on unless it is explicitly turned off
        this.bodyRollOptions = resolveBodyRoll(this.settings.bodyRoll);
        this.wheelSmoothingOptions = resolveWheelSmoothing(this.settings.wheelSmoothing);
        this.skidOptions = resolveSkid(this.settings.skid);
        this.createBody();
        this.createConstraint();
        this.bindListeners();
    }

    //* Secondary physics setters (issue #41) =================================================
    /**
     * Change (or turn off, with `false`) the visual body roll. Turning it off puts the chassis
     * object back to its own orientation so nothing is left leaning.
     */
    setBodyRoll(settings: BodyRollSettings | false) {
        this.bodyRollOptions = resolveBodyRoll(settings);
        if (!this.bodyRollOptions) this.resetBodyRoll();
    }
    /** Change (or turn off, with `false`) the easing of the rendered wheels. */
    setWheelSmoothing(settings: WheelSmoothingSettings | false) {
        this.wheelSmoothingOptions = resolveWheelSmoothing(settings);
    }
    /**
     * Change (or turn off, with `false`) skid detection. Turning it off ends every skid that is
     * currently running, so a listener that started a particle effect gets its `skidEnd`.
     */
    setSkid(settings: SkidSettings | false) {
        this.skidOptions = resolveSkid(settings);
        if (!this.skidOptions) this.updateSkidState(0);
    }

    /** put the chassis object back to level and forget the spring's state */
    private resetBodyRoll() {
        this.bodyRollAngle = 0;
        this.bodyPitchAngle = 0;
        this.rollVelocity = 0;
        this.pitchVelocity = 0;
        this.hasPreviousVelocity = false;
        this.bodyObject?.quaternion.identity();
    }

    /**
     * Cache the controller's engine and gearbox for the readouts. Called once the subclass has
     * cast `this.controller`; both are plain members of the controller, so they live exactly as
     * long as the constraint does and are never ours to free.
     */
    protected bindControllerReadouts() {
        const controller = this.wheeledController;
        this.engine = controller?.GetEngine();
        this.transmission = controller?.GetTransmission();
    }

    /**
     * Free everything the vehicle owns (issue #140): the constraint and its step listener, the
     * callbacks Jolt calls into, the car body, the wheel states and every three resource it
     * generated itself. Neither `VehicleManager` nor `VehicleSystem` had a `destroy()` at all, so
     * a vehicle leaked its whole constraint graph and kept being stepped for the lifetime of the
     * page. Idempotent.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        if (this.turboTimer) clearTimeout(this.turboTimer);
        this.turboTimer = undefined;
        // constraint-callback and action listeners all live on the one Emitter now
        // (issue #50/#187), so dropping them is a single clear() rather than emptying four arrays
        this.events.clear();

        // React destroys a parent's effects before its children's, so `<Physics>` may already
        // have freed the JoltInterface - touching jolt after that traps in wasm (issue #82).
        if (!this.physicsSystem.destroyed) {
            const joltPhysicsSystem = this.physicsSystem.physicsSystem;
            if (this.constraintStepListener) {
                joltPhysicsSystem.RemoveStepListener(this.constraintStepListener);
                Raw.module.destroy(this.constraintStepListener);
            }
            if (this.constraint) {
                // RemoveConstraint gives back the reference AddConstraint took; Release gives
                // back ours (taken in attachConstraint). The second one is what frees the
                // constraint - and with it the wheels, the controller and the collision tester.
                joltPhysicsSystem.RemoveConstraint(this.constraint);
                this.constraint.Release();
            }
            // wheel states only hold their own scratch vectors now the constraint is gone
            this.wheels.forEach((wheel) => wheel.destroy());
            if (this.callbacks) Raw.module.destroy(this.callbacks);
            this.removeCarBody();
        }

        this.constraintStepListener = undefined;
        this.callbacks = undefined;
        // issue #41: the engine and gearbox belong to the controller, which the constraint just
        // took with it. Drop the wrappers rather than freeing anything.
        this.engine = undefined;
        this.transmission = undefined;
        this.skidEvent.wheel = undefined as unknown as WheelState;
        this.constraint = undefined as unknown as Jolt.VehicleConstraint;
        this.controller = undefined as unknown as Jolt.VehicleController;
        this.carBody = undefined as unknown as Jolt.Body;
        this.wheels.clear();

        // three side: hand the user's chassis back untouched, dispose only what we generated
        this.userBodyObject?.removeFromParent();
        this.userBodyObject = undefined;
        if (this.debugObject) disposeGeneratedObject(this.debugObject);
        this.debugObject = undefined;
        this.threeObject.clear();
        this.threeObject.removeFromParent();
    }

    /**
     * The car body is created straight off the body interface rather than through `BodySystem`,
     * so take whichever route it was registered by. Either way it has to happen *after* the
     * constraint is gone: Jolt dereferences both bodies while detaching a constraint.
     */
    private removeCarBody() {
        if (!this.carBody) return;
        const handle = this.carBody.GetID().GetIndexAndSequenceNumber();
        if (this.physicsSystem.bodySystem.getBody(handle)) {
            this.physicsSystem.bodySystem.removeBody(handle);
            return;
        }
        const bodyInterface = this.physicsSystem.bodyInterface;
        const bodyID = this.carBody.GetID();
        if (bodyInterface.IsAdded(bodyID)) bodyInterface.RemoveBody(bodyID);
        bodyInterface.DestroyBody(bodyID);
    }

    createBody() {
        // the shape settings copy both vectors, and the outer OffsetCenterOfMass settings own the
        // inner BoxShapeSettings through a RefConst (destroying the outer frees the inner, so the
        // inner must not be destroyed here). `createShapeFromSettings` destroys the outer and
        // hands back a shape we hold one reference on - `Create().Get()` used to hand back a
        // shape owned by a *static* ShapeResult whose reference the next Create() dropped.
        const halfExtents = vec3.jolt([
            this.settings.vehicleWidth / 2,
            this.settings.vehicleHeight / 2,
            this.settings.vehicleLength / 2
        ]);
        const centerOfMassOffset = vec3.jolt([0, -this.settings.vehicleHeight / 2, 0]);
        const carShapeSettings = new Raw.module.OffsetCenterOfMassShapeSettings(
            centerOfMassOffset,
            new Raw.module.BoxShapeSettings(halfExtents)
        );
        Raw.module.destroy(halfExtents);
        Raw.module.destroy(centerOfMassOffset);
        const carShape = createShapeFromSettings(carShapeSettings);

        const bodyPosition = vec3.rjolt(this.settings.bodyPosition);
        const upAxis = vec3.jolt([0, 1, 0]);
        const carBodySettings = new Raw.module.BodyCreationSettings(
            carShape,
            bodyPosition,
            // sRotation returns by value: a static temporary, not an allocation. The Vec3 we
            // built for it is ours though, and used to leak.
            Raw.module.Quat.prototype.sRotation(upAxis, Math.PI),
            Raw.module.EMotionType_Dynamic,
            Layer.MOVING
        );
        Raw.module.destroy(bodyPosition);
        Raw.module.destroy(upAxis);
        carBodySettings.mOverrideMassProperties =
            Raw.module.EOverrideMassProperties_CalculateInertia;
        carBodySettings.mMassPropertiesOverride.mMass = this.settings.vehicleMass;
        this.carBody = this.physicsSystem.bodyInterface.CreateBody(carBodySettings);
        // the settings and the body hold their own references on the shape now
        Raw.module.destroy(carBodySettings);
        releaseShape(carShape);
        /* VERRY VERY IMPORTANT
        ALWAYS ADD THE BODY TO THE INTERFACE
        */
        this.physicsSystem.bodyInterface.AddBody(
            this.carBody.GetID(),
            Raw.module.EActivation_Activate
        );
        // the three side: the caller's chassis if they gave us one, otherwise a generated box
        this.applyBodyObject();

        return this.carBody;
    }

    /** use the injected chassis object, or generate the default one (issue #26) */
    protected applyBodyObject() {
        if (this.settings.bodyObject) this.setBodyObject(this.settings.bodyObject);
        else this.createDebugBody();
    }

    /**
     * Issue #26: sync a caller supplied `Object3D` (a GLTF scene, say) as the chassis instead of
     * the generated box. The object is parented to `threeObject`, which follows the chassis body,
     * so it needs no transform of its own. Passing `null` puts the generated box back.
     *
     * The manager never disposes an object handed to it this way - `destroy()` only detaches it.
     */
    setBodyObject(object: THREE.Object3D | null) {
        if (this.destroyed) return;
        if (this.userBodyObject && this.userBodyObject !== object) {
            this.userBodyObject.removeFromParent();
            this.userBodyObject = undefined;
        }
        if (object) {
            // the generated chassis is ours, so it goes for good
            if (this.debugObject) {
                disposeGeneratedObject(this.debugObject);
                this.debugObject = undefined;
            }
            this.userBodyObject = object;
            if (object.parent !== this.threeObject) this.threeObject.add(object);
        } else if (!this.debugObject) {
            this.createDebugBody();
        }
    }

    /** the generated stand-in chassis: a box the size of the collider, plus a cab */
    protected createDebugBody(): THREE.Mesh {
        // TODO Consider renaming to "mesh" body will always be the physics system
        const debugBody = new THREE.Mesh(
            new THREE.BoxGeometry(
                this.settings.vehicleWidth,
                this.settings.vehicleHeight,
                this.settings.vehicleLength
            ),
            new THREE.MeshBasicMaterial({ color: 0xff0000 })
        );
        debugBody.visible = this.isDebugging;
        this.threeObject.add(debugBody);
        // add cab
        const cab = new THREE.Mesh(
            new THREE.BoxGeometry(this.settings.vehicleWidth, 0.75, 2),
            new THREE.MeshBasicMaterial({ color: 0xff0000 })
        );
        cab.position.set(0, this.settings.vehicleHeight, -1);
        debugBody.add(cab);
        this.debugObject = debugBody;
        return debugBody;
    }

    //* Wheels ============================================
    /** the wheel registered under `name` ('fl' | 'fr' | 'bl' | 'br', or 'front' | 'back') */
    getWheel(wheel: number | string): WheelState | undefined {
        if (typeof wheel === 'number') return this.wheels.get(this.wheelOrder[wheel]);
        return this.wheels.get(wheel);
    }
    /**
     * Issue #27: sync a caller supplied object for one wheel, by name or by constraint index.
     * The object is parented to the wheel's container, so it follows the wheel's position *and*
     * rotation (steering included). Passing `null` puts the generated cylinder back.
     */
    setWheelObject(wheel: number | string, object: THREE.Object3D | null) {
        this.getWheel(wheel)?.setObject(object);
    }
    /** `setWheelObject` for every wheel at once, in constraint order. `undefined` skips a wheel. */
    setWheelObjects(objects: (THREE.Object3D | null | undefined)[]) {
        objects.forEach((object, index) => {
            if (object !== undefined) this.setWheelObject(index, object);
        });
    }
    /** the object injected for a wheel, or the generated cylinder */
    getWheelObject(wheel: number | string): THREE.Object3D | undefined {
        return this.getWheel(wheel)?.object;
    }
    /** the object a wheel should be created with, from `wheels.<corner>.object` or `wheelObjects` */
    protected wheelObjectFor(corner: string, index: number): THREE.Object3D | null | undefined {
        const wheels = this.settings.wheels as unknown as Record<
            string,
            { object?: THREE.Object3D } | undefined
        >;
        return wheels?.[corner]?.object ?? this.settings.wheelObjects?.[index];
    }
    /** register a wheel state and parent its container under the vehicle */
    protected addWheelState(name: string, index: number) {
        const state = new WheelState(this.constraint, index, this.wheelObjectFor(name, index));
        state.debug = this.isDebugging;
        this.wheels.set(name, state);
        this.wheelOrder[index] = name;
        this.threeObject.add(state.threeObject);
        return state;
    }

    createConstraint() {
        // Ownership inside this method (jolt reference counting, see jolt-physics' README):
        //  - `mWheels` / `mController` are Ref<> members, so the settings own what is assigned to
        //    them and the constraint takes its own references. Never destroy those directly.
        //  - `mDifferentials` / `mAntiRollBars` are arrays *by value*: push_back copies, so the
        //    objects built here are ours and are freed right after.
        //  - `vehicle` itself is ours and is destroyed once the constraint has been built.
        const settings = this.settings as ResolvedFourWheelVehicleSettings;
        const vehicle = new Raw.module.VehicleConstraintSettings();
        vehicle.mMaxPitchRollAngle = settings.maxPitchRollAngle;
        vehicle.mWheels.clear();
        const wheelsToCreate = ['fl', 'fr', 'bl', 'br'];
        wheelsToCreate.forEach((corner) => {
            vehicle.mWheels.push_back(createWheelSettings(settings, corner));
        });

        //controller
        const controllerSettings = new Raw.module.WheeledVehicleControllerSettings();
        controllerSettings.mEngine.mMaxTorque = settings.maxEngineTorque;
        controllerSettings.mTransmission.mClutchStrength = settings.clutchStrength;
        vehicle.mController = controllerSettings;

        // Front Diff
        controllerSettings.mDifferentials.clear();
        const frontWheelDrive = new Raw.module.VehicleDifferentialSettings();
        frontWheelDrive.mLeftWheel = FL_WHEEL;
        frontWheelDrive.mRightWheel = FR_WHEEL;
        frontWheelDrive.mLimitedSlipRatio = settings.leftRightLimitedSlipRatio;
        if (settings.fourWheelDrive)
            frontWheelDrive.mEngineTorqueRatio = settings.splitEngineTorqueFront ?? 0.5;
        controllerSettings.mDifferentials.push_back(frontWheelDrive);
        Raw.module.destroy(frontWheelDrive);
        controllerSettings.mDifferentialLimitedSlipRatio = settings.frontBackLimitedSlipRatio;

        // Rear Diff
        if (settings.fourWheelDrive) {
            const rearWheelDrive = new Raw.module.VehicleDifferentialSettings();
            rearWheelDrive.mLeftWheel = BL_WHEEL;
            rearWheelDrive.mRightWheel = BR_WHEEL;
            rearWheelDrive.mLimitedSlipRatio = settings.leftRightLimitedSlipRatio;
            rearWheelDrive.mEngineTorqueRatio = settings.splitEngineTorqueRear ?? 0.5;
            controllerSettings.mDifferentials.push_back(rearWheelDrive);
            Raw.module.destroy(rearWheelDrive);
        }

        // Anti Roll Bars
        if (settings.antiRollbar) {
            const frontRollBar = new Raw.module.VehicleAntiRollBar();
            frontRollBar.mLeftWheel = FL_WHEEL;
            frontRollBar.mRightWheel = FR_WHEEL;
            if (settings.frontRollBarStiffness)
                frontRollBar.mStiffness = settings.frontRollBarStiffness;
            const rearRollBar = new Raw.module.VehicleAntiRollBar();
            rearRollBar.mLeftWheel = BL_WHEEL;
            rearRollBar.mRightWheel = BR_WHEEL;
            if (settings.rearRollBarStiffness)
                rearRollBar.mStiffness = settings.rearRollBarStiffness;
            vehicle.mAntiRollBars.push_back(frontRollBar);
            vehicle.mAntiRollBars.push_back(rearRollBar);
            Raw.module.destroy(frontRollBar);
            Raw.module.destroy(rearRollBar);
        }

        this.constraint = new Raw.module.VehicleConstraint(this.carBody, vehicle);
        //NOW we can create the wheelStates
        wheelsToCreate.forEach((corner, index) => this.addWheelState(corner, index));

        //set the collision tester that checks the wheels for collision with the floor
        let tester: Jolt.VehicleCollisionTester;
        switch (settings.castType) {
            case 'cylinder':
                tester = new Raw.module.VehicleCollisionTesterCastCylinder(Layer.MOVING, 0.05);
                break;
            case 'sphere':
                tester = new Raw.module.VehicleCollisionTesterCastSphere(
                    Layer.MOVING,
                    0.5 * (settings.wheels?.width ?? 0.3)
                );
                break;
            default:
                tester = new Raw.module.VehicleCollisionTesterRay(Layer.MOVING);
                break;
        }
        this.attachConstraint(tester);
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.WheeledVehicleController
        );
        // issue #41: cache the engine and gearbox the readouts are read from
        this.bindControllerReadouts();

        // the constraint has copied the wheels and built its controller, so the settings (and
        // everything they own: the wheel settings, the controller settings) can go
        Raw.module.destroy(vehicle);
    }

    /**
     * Put a freshly built constraint into the simulation. Shared with the subclasses so the
     * reference counting and the step listener are handled in exactly one place.
     *
     * Constraints are reference counted like the ones `ConstraintSystem` manages: `AddRef()` here
     * and `RemoveConstraint()` + `Release()` in `destroy()`. `Raw.module.destroy()` on a
     * constraint is a double free and is what used to crash the page (issue #82).
     */
    protected attachConstraint(tester: Jolt.VehicleCollisionTester) {
        // the collision tester is reference counted and owned by the constraint from here on,
        // so it must not be destroyed separately
        this.constraint.SetVehicleCollisionTester(tester);
        this.constraint.AddRef();
        this.physicsSystem.physicsSystem.AddConstraint(this.constraint);
        // SUPER IMPORTANT WEIRD LOOP LISTENER. AddStepListener keeps a raw pointer, so this one
        // is ours to remove and free.
        this.constraintStepListener = new Raw.module.VehicleConstraintStepListener(this.constraint);
        this.physicsSystem.physicsSystem.AddStepListener(this.constraintStepListener);
    }
    //* Event Listeners and Triggers ========================

    // create core listener handles
    private bindListeners() {
        // kept on the instance: Jolt calls into this object from the simulation, so dropping the
        // last JavaScript reference to it (as this used to do) is a use after free waiting to
        // happen, and there would be nothing left to destroy on teardown.
        const callbacks = new Raw.module.VehicleConstraintCallbacksJS();
        this.callbacks = callbacks;
        callbacks.GetCombinedFriction = (
            _wheelIndex,
            _tireFrictionDirection,
            tireFriction,
            body2,
            _subShapeID2
        ) => {
            const body = Raw.module.wrapPointer(body2, Raw.module.Body) as Jolt.Body;
            return Math.sqrt(tireFriction * body.GetFriction()); // This is the default calculation
        };
        // jolt-physics 0.26 replaced the (vehicle, deltaTime, physicsSystem) arguments of these
        // callbacks with (vehicle, PhysicsStepListenerContext*). Unwrap the context so our own
        // listeners keep receiving the delta time and physics system they always did.
        const unwrapContext = (inContext: number) =>
            Raw.module.wrapPointer(inContext, Raw.module.PhysicsStepListenerContext);
        const unwrapVehicle = (inVehicle: number) =>
            Raw.module.wrapPointer(inVehicle, Raw.module.VehicleConstraint);
        callbacks.OnPreStepCallback = (vehicle, context) => {
            const ctx = unwrapContext(context);
            this.events.emit('preStep', unwrapVehicle(vehicle), ctx.mDeltaTime, ctx.mPhysicsSystem);
        };
        callbacks.OnPostCollideCallback = (vehicle, context) => {
            const ctx = unwrapContext(context);
            this.events.emit(
                'postCollide',
                unwrapVehicle(vehicle),
                ctx.mDeltaTime,
                ctx.mPhysicsSystem
            );
        };
        callbacks.OnPostStepCallback = (vehicle, context) => {
            const ctx = unwrapContext(context);
            this.events.emit(
                'postStep',
                unwrapVehicle(vehicle),
                ctx.mDeltaTime,
                ctx.mPhysicsSystem
            );
        };
        callbacks.SetVehicleConstraint(this.constraint);
    }
    // for actions
    // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
    triggerActions(action: any) {
        this.events.emit('action', action);
    }
    //explicit callback shorthands
    onPreStep(listener: VehicleStepCallback): Unsubscribe {
        return this.events.on('preStep', listener);
    }
    onPostCollide(listener: VehicleStepCallback): Unsubscribe {
        return this.events.on('postCollide', listener);
    }
    onPostStep(listener: VehicleStepCallback): Unsubscribe {
        return this.events.on('postStep', listener);
    }
    /**
     * Issue #41: a wheel crossed the skid thresholds - start the tyre smoke, the skid mark, the
     * screech. The payload is pooled; copy anything you keep.
     */
    onSkidStart(listener: VehicleSkidListener): Unsubscribe {
        return this.events.on('skidStart', listener);
    }
    /** Issue #41: that wheel has had grip again for `skid.releaseTime` seconds. */
    onSkidEnd(listener: VehicleSkidListener): Unsubscribe {
        return this.events.on('skidEnd', listener);
    }
    /**
     * Issue #41: the engine readout, once per physics step, for audio and instruments. The state
     * object is pooled - read what you need inside the handler.
     *
     * ```ts
     * vehicle.onEngine(({ rpm, gear, throttle }) => {
     *     engineSound.playbackRate = 0.5 + rpm / 6000;
     *     engineSound.volume = 0.2 + 0.8 * throttle;
     * });
     * ```
     */
    onEngine(listener: VehicleEngineListener): Unsubscribe {
        return this.events.on('engine', listener);
    }
    // take an action type and filter it
    // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
    onAction(actionType: string, listener: (action: any, manager: VehicleManager) => void) {
        // Two subscriptions of the same filtered wrapper now unsubscribe independently, because
        // the handle closes over the entry rather than comparing function identity.
        // biome-ignore lint/suspicious/noExplicitAny: action payloads are user defined
        return this.events.on('action', (action: any) => {
            if (action === actionType) listener(action, this);
        });
    }
    //* Input Handling ====================================
    move(direction: THREE.Vector3 | THREE.Vector2) {
        this.moveDirection.set(direction.x, direction.y, 0);
    }
    setHandBrake(value: boolean) {
        this.handBrake = value;
    }
    setBrake(value: boolean) {
        this.brake = value;
    }
    triggerTurbo(extraTime?: number) {
        if (this.destroyed) return;
        this.turboActive = true;
        // the handle is kept so destroy() can clear it
        this.turboTimer = setTimeout(() => {
            this.turboActive = false;
        }, extraTime || this.turboTimeLimit);
    }
    setPosition(position: THREE.Vector3 | number[]) {
        if (this.destroyed) return;
        // `joltScratch.rvec3` hands back a shared vector and `SetPosition` copies it;
        // this used to allocate (and leak) one RVec3 per call.
        this.physicsSystem.bodyInterface.SetPosition(
            this.carBody.GetID(),
            joltScratch.rvec3(position),
            Raw.module.EActivation_Activate
        );
        // a teleport is not acceleration: forget the sampled velocity so the body roll spring
        // does not get a one frame kick out of the jump (issue #41)
        this.hasPreviousVelocity = false;
    }

    //* Physics Update ====================================
    // attach to loop
    // we are going to do this in the main vehicle system
    // the delta time is unused here but the subclasses (and the system) pass it
    prePhysicsUpdate(_deltaTime: number) {
        if (this.destroyed) return;
        let forward = this.moveDirection.y;
        const right = this.moveDirection.x;
        let brake = 0;
        let handBrake = 0;
        // if we have reveresed direction
        if (this.previousForward * forward < 0) {
            // every getter here returns a static temporary by value (not an allocation, and
            // never to be destroyed); reading into the scratch objects keeps the frame free of
            // three.js garbage as well.
            const rotation = quat.joltToThree(
                this.carBody.GetRotation().Conjugated(),
                this._rotation
            );
            const linearVelocity = vec3.joltToThree(
                this.carBody.GetLinearVelocity(),
                this._position
            );
            const velocity = linearVelocity.applyQuaternion(rotation).z;
            // if we are moving either direction
            if ((forward > 0 && velocity < -0.1) || (forward < 0 && velocity > 0.1)) {
                //brake while not stopped
                forward = 0;
                brake = 1;
            } else {
                this.previousForward = forward;
            }
        }
        if (this.handBrake) {
            forward = 0;
            handBrake = 1;
        }
        this.driverInput(forward, right, brake, handBrake);
        if (right !== 0 || forward !== 0 || brake !== 0 || handBrake !== 0) {
            this.physicsSystem.bodyInterface.ActivateBody(this.carBody.GetID());
        }
    }
    /** the controller is typed per vehicle flavour; both expose `SetDriverInput` */
    protected driverInput(forward: number, right: number, brake: number, handBrake: number) {
        (
            this.controller as unknown as {
                SetDriverInput: (f: number, r: number, b: number, h: number) => void;
            }
        ).SetDriverInput(forward, right, brake, handBrake);
    }
    /**
     * Everything render side happens here, after jolt has solved the step: the chassis and the
     * wheels are synced, the presentational layer of issue #41 is advanced (body roll, wheel
     * easing, skid detection) and the readouts are published.
     *
     * It allocates nothing, on either side of the wasm boundary: every jolt getter used here
     * returns a number or a static temporary, and every three object it writes to is scratch
     * owned by the manager or by a `WheelState`.
     */
    postPhysicsUpdate(deltaTime: number) {
        if (this.destroyed) return;
        // lets try what happens if we update the render state after the world tick.
        // GetPosition/GetRotation return static temporaries by value, so reading straight into
        // the three objects neither allocates wasm memory nor produces per frame garbage.
        vec3.three(this.carBody.GetPosition(), undefined, undefined, this.threeObject.position);
        quat.joltToThree(this.carBody.GetRotation(), this.threeObject.quaternion);
        this.updateWheelTransforms(deltaTime);
        this.updateSkidState(deltaTime);
        this.updateBodyRoll(deltaTime);
        this.emitEngineState();
    }
    //update the wheels
    updateWheelTransforms(deltaTime = 0) {
        // a plain loop over the wheel order rather than `wheels.forEach(fn)`: the callback would
        // be a fresh closure on every step of every vehicle
        for (let i = 0; i < this.wheelOrder.length; i++) {
            const wheel = this.wheels.get(this.wheelOrder[i]);
            wheel?.updateLocalTransform(deltaTime, this.wheelSmoothingOptions);
        }
    }

    /**
     * Issue #41: advance each wheel's skid hysteresis and emit the transitions. Nothing is built
     * unless somebody is listening, and the payload that is handed out is the pooled one.
     */
    protected updateSkidState(deltaTime: number) {
        // read once for every wheel; `speed` costs two calls into wasm
        const speed = this.skidOptions ? Math.abs(this.speed) : 0;
        for (let i = 0; i < this.wheelOrder.length; i++) {
            const name = this.wheelOrder[i];
            const wheel = this.wheels.get(name);
            if (!wheel) continue;
            const transition = wheel.updateSkid(this.skidOptions, deltaTime, speed);
            if (transition === 0) continue;
            const type = transition === SKID_STARTED ? 'skidStart' : 'skidEnd';
            if (!this.events.has(type)) continue;
            const event = this.skidEvent;
            event.wheel = wheel;
            event.name = name;
            event.index = i;
            event.slipRatio = wheel.slipRatio;
            event.lateralSlip = wheel.lateralSlip;
            event.speedKmh = this.speedKmh;
            // GetContactPosition returns an RVec3 by value - a static temporary, read never freed
            if (wheel.hasContact && wheel.joltWheel) {
                vec3.three(
                    wheel.joltWheel.GetContactPosition(),
                    undefined,
                    undefined,
                    event.position
                );
            } else {
                event.position.set(0, 0, 0);
            }
            this.events.emit(type, event);
        }
    }

    /**
     * Issue #41: the spring damped visual tilt. The chassis *body* is never touched - this only
     * writes the local rotation of the object being synced as the chassis, which sits inside
     * `threeObject` and therefore leans relative to the body jolt solved.
     *
     * The tilt is driven by the chassis' own acceleration rotated into its local frame, so a
     * steady turn (whose world space acceleration is purely centripetal) reads as pure lateral
     * acceleration and leans the body outwards, exactly as a real sprung mass does.
     */
    protected updateBodyRoll(deltaTime: number) {
        const options = this.bodyRollOptions;
        const object = this.bodyObject;
        if (!options || !object || deltaTime <= 0) return;

        vec3.joltToThree(this.carBody.GetLinearVelocity(), this._velocity);
        if (this.hasPreviousVelocity) {
            this._acceleration
                .subVectors(this._velocity, this._previousVelocity)
                .divideScalar(deltaTime)
                // into the chassis' own frame. `_rotation` is scratch, and conjugating it in
                // place is what turns the body rotation into its inverse.
                .applyQuaternion(this._rotation.copy(this.threeObject.quaternion).conjugate());
        } else {
            this._acceleration.set(0, 0, 0);
            this.hasPreviousVelocity = true;
        }
        this._previousVelocity.copy(this._velocity);

        const reference = options.referenceAcceleration || 1;
        // a right hand turn accelerates the chassis towards its local +x and leans it to the
        // left, which is a positive rotation about the local forward axis
        const targetRoll = clamp(this._acceleration.x / reference, 1) * options.maxAngle;
        const targetPitch = clamp(this._acceleration.z / reference, 1) * options.maxPitchAngle;

        const step = deltaTime > MAX_ROLL_STEP ? MAX_ROLL_STEP : deltaTime;
        this.rollVelocity +=
            ((targetRoll - this.bodyRollAngle) * options.stiffness -
                this.rollVelocity * options.damping) *
            step;
        this.pitchVelocity +=
            ((targetPitch - this.bodyPitchAngle) * options.stiffness -
                this.pitchVelocity * options.damping) *
            step;
        this.bodyRollAngle = clamp(this.bodyRollAngle + this.rollVelocity * step, options.maxAngle);
        this.bodyPitchAngle = clamp(
            this.bodyPitchAngle + this.pitchVelocity * step,
            options.maxPitchAngle
        );

        object.quaternion.setFromEuler(this._tilt.set(this.bodyPitchAngle, 0, this.bodyRollAngle));
    }

    /** Issue #41: fill and dispatch the pooled engine readout, if anybody asked for it. */
    protected emitEngineState() {
        if (!this.events.has('engine')) return;
        const state = this.engineState;
        state.rpm = this.rpm;
        state.gear = this.gear;
        state.throttle = this.throttle;
        state.brake = this.brakeInput;
        state.speed = this.speed;
        state.speedKmh = state.speed * 3.6;
        state.shifting = this.shifting;
        state.clutch = this.clutch;
        state.skidding = this.skidding;
        this.events.emit('engine', state);
    }
}
