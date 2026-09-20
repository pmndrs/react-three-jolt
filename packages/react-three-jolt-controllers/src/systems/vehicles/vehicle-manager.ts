import {
    createShapeFromSettings,
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
import {
    type ResolvedFourWheelVehicleSettings,
    type ResolvedVehicleSettings,
    resolveVehicleSettings,
    type VehicleSettings
} from './vehicle-settings';
import { WheelState } from './wheel-state';
import { createWheelSettings, disposeGeneratedObject } from './wheels';

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
type ListenerBucket = 'preStepListeners' | 'postCollideListeners' | 'postStepListeners';

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
    //@ts-ignore assigned by createBody
    carBody: Jolt.Body;
    //@ts-ignore assigned by createConstraint
    constraint: Jolt.VehicleConstraint;
    //@ts-ignore assigned by createConstraint
    controller: Jolt.VehicleController;

    // listeners for collision events
    private preStepListeners: VehicleStepListener[] = [];
    private postCollideListeners: VehicleStepListener[] = [];
    private postStepListeners: VehicleStepListener[] = [];

    //listneer for actions
    private actionListeners: VehicleActionListener[] = [];

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
     * The step listener Jolt uses to run the vehicle's own pre/post step work. `AddStepListener`
     * stores a raw pointer, so this instance is ours to remove and free - it used to be
     * constructed anonymously, which made it impossible to do either (issue #140).
     */
    protected constraintStepListener?: Jolt.PhysicsStepListener;
    /**
     * The callbacks Jolt calls into from the simulation. This used to be a local `const` in
     * `bindListeners`, so its only JavaScript reference was dropped while Jolt kept calling it.
     */
    protected callbacks?: Jolt.VehicleConstraintCallbacksEm;
    protected turboTimer?: ReturnType<typeof setTimeout>;
    /** issue #26: the chassis object the *user* gave us. Synced, never disposed. */
    private userBodyObject?: THREE.Object3D;

    //* Per frame scratch (three side) - avoids garbage in postPhysicsUpdate
    protected readonly _position = new THREE.Vector3();
    protected readonly _rotation = new THREE.Quaternion();

    get position() {
        return this.threeObject.position;
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
        this.createBody();
        this.createConstraint();
        this.bindListeners();
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
        this.preStepListeners = [];
        this.postCollideListeners = [];
        this.postStepListeners = [];
        this.actionListeners = [];

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
            //@ts-ignore this is a TS bug in wrapPointer
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
            this.triggerListeners(
                'preStepListeners',
                unwrapVehicle(vehicle),
                ctx.mDeltaTime,
                ctx.mPhysicsSystem
            );
        };
        callbacks.OnPostCollideCallback = (vehicle, context) => {
            const ctx = unwrapContext(context);
            this.triggerListeners(
                'postCollideListeners',
                unwrapVehicle(vehicle),
                ctx.mDeltaTime,
                ctx.mPhysicsSystem
            );
        };
        callbacks.OnPostStepCallback = (vehicle, context) => {
            const ctx = unwrapContext(context);
            this.triggerListeners(
                'postStepListeners',
                unwrapVehicle(vehicle),
                ctx.mDeltaTime,
                ctx.mPhysicsSystem
            );
        };
        callbacks.SetVehicleConstraint(this.constraint);
    }
    //trigger listeners
    triggerListeners(
        listenerType: ListenerBucket,
        vehicle: Jolt.VehicleConstraint,
        deltaTime: number,
        physicsSystem: Jolt.PhysicsSystem
    ) {
        this[listenerType].forEach((listener) => {
            listener(vehicle, deltaTime, physicsSystem);
        });
    }
    // for actions
    triggerActions(action: string) {
        this.actionListeners.forEach((listener) => {
            listener(action, this);
        });
    }
    // add a listener to the correct type and return a function to remove the listener
    private addListener(listenerType: ListenerBucket, listener: VehicleStepListener) {
        this[listenerType].push(listener);
        return () => {
            this[listenerType] = this[listenerType].filter((l) => l !== listener);
        };
    }
    //explicit callback shorthands
    onPreStep(listener: VehicleStepListener) {
        return this.addListener('preStepListeners', listener);
    }
    onPostCollide(listener: VehicleStepListener) {
        return this.addListener('postCollideListeners', listener);
    }
    onPostStep(listener: VehicleStepListener) {
        return this.addListener('postStepListeners', listener);
    }
    // take an action type and filter it
    onAction(actionType: string, listener: VehicleActionListener) {
        const newListener: VehicleActionListener = (action) => {
            if (action === actionType) listener(action, this);
        };
        this.actionListeners.push(newListener);
        return () => {
            this.actionListeners = this.actionListeners.filter((l) => l !== newListener);
        };
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
    postPhysicsUpdate(_deltaTime: number) {
        if (this.destroyed) return;
        // lets try what happens if we update the render state after the world tick.
        // GetPosition/GetRotation return static temporaries by value, so reading straight into
        // the three objects neither allocates wasm memory nor produces per frame garbage.
        vec3.three(this.carBody.GetPosition(), undefined, undefined, this.threeObject.position);
        quat.joltToThree(this.carBody.GetRotation(), this.threeObject.quaternion);
        this.updateWheelTransforms();
    }
    //update the wheels
    updateWheelTransforms() {
        this.wheels.forEach((wheel) => {
            wheel.updateLocalTransform();
        });
    }
}
