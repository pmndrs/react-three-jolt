import * as THREE from 'three';
import type Jolt from 'jolt-physics';
import { Raw, vec3, quat, PhysicsSystem, Layer } from '@react-three/jolt';
import { VehicleFourWheelSettings, WheelState, createWheelSettings } from './wheels';

const FL_WHEEL = 0;
const FR_WHEEL = 1;
const BL_WHEEL = 2;
const BR_WHEEL = 3;

export class VehicleManager {
    physicsSystem: PhysicsSystem;
    settings: VehicleFourWheelSettings; //@ts-ignore
    carBody: Jolt.Body; //@ts-ignore
    constraint: Jolt.VehicleConstraint; //@ts-ignore
    controller: Jolt.WheeledVehicleController;

    // listeners for collision events
    //@ts-ignore these get added to dynamicly. ts is wrong
    private preStepListeners = [];
    //@ts-ignore
    private postCollideListeners = [];
    //@ts-ignore
    private postStepListeners = [];

    //listneer for actions
    private actionListeners = [];

    //this holds the threejs objects
    threeObject = new THREE.Object3D();
    //@ts-ignore this is created by a function but TS says it isn't
    debugObject: THREE.Mesh;
    wheels: Map<string, WheelState> = new Map();

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

    get position() {
        return this.threeObject.position;
    }
    set debug(value) {
        this.isDebugging = value;
        if (value) this.debugObject.visible = true;
        else this.debugObject.visible = false;
        this.wheels.forEach((wheel) => {
            wheel.debug = value;
        });
    }
    get debug() {
        return this.isDebugging;
    }

    constructor(physicsSystem: PhysicsSystem, settings: any) {
        this.settings = settings;
        this.physicsSystem = physicsSystem;
        this.createBody();
        this.createConstraint();
        this.bindListeners();
    }
    createBody() {
        const carShapeSettings = new Raw.module.OffsetCenterOfMassShapeSettings(
            new Raw.module.Vec3(0, -this.settings.vehicleHeight! / 2, 0),
            new Raw.module.BoxShapeSettings(
                new Raw.module.Vec3(
                    this.settings.vehicleWidth! / 2,
                    this.settings.vehicleHeight! / 2,
                    this.settings.vehicleLength! / 2
                )
            )
        );
        const carShape = carShapeSettings.Create().Get();
        const carBodySettings = new Raw.module.BodyCreationSettings(
            carShape,
            new Raw.module.RVec3(...this.settings.bodyPosition),
            Raw.module.Quat.prototype.sRotation(new Raw.module.Vec3(0, 1, 0), Math.PI),
            Raw.module.EMotionType_Dynamic,
            Layer.MOVING
        );
        carBodySettings.mOverrideMassProperties =
            Raw.module.EOverrideMassProperties_CalculateInertia;
        carBodySettings.mMassPropertiesOverride.mMass = this.settings.vehicleMass!;
        this.carBody = this.physicsSystem.bodyInterface.CreateBody(carBodySettings);
        // TODO: destroy everything
        Raw.module.destroy(carBodySettings);
        /* VERRY VERY IMPORTANT
        ALWAYS ADD THE BODY TO THE INTERFACE
        */
        this.physicsSystem.bodyInterface.AddBody(
            this.carBody.GetID(),
            Raw.module.EActivation_Activate
        );
        // create the debug body
        // TODO Consider renaming to "mesh" body will always be the physics system
        const debugBody = new THREE.Mesh(
            new THREE.BoxGeometry(
                this.settings.vehicleWidth,
                this.settings.vehicleHeight,
                this.settings.vehicleLength
            ),
            new THREE.MeshBasicMaterial({ color: 0xff0000 })
        );
        //debugBody.position.set(...this.settings.bodyPosition);
        this.threeObject.add(debugBody);
        // add cab
        const cab = new THREE.Mesh(
            new THREE.BoxGeometry(this.settings.vehicleWidth, 0.75, 2),
            new THREE.MeshBasicMaterial({ color: 0xff0000 })
        );
        cab.position.set(0, this.settings.vehicleHeight!, -1);
        debugBody.add(cab);

        return this.carBody;
    }

    createConstraint() {
        const vehicle = new Raw.module.VehicleConstraintSettings();
        vehicle.mMaxPitchRollAngle = THREE.MathUtils.degToRad(60);
        vehicle.mWheels.clear();
        const wheelsToCreate = ['fl', 'fr', 'bl', 'br'];
        //we are going to hold the wheels for after the constraint is created
        const wheelHolder: any = [];
        wheelsToCreate.forEach((corner) => {
            const wheel = createWheelSettings(this.settings, corner);
            vehicle.mWheels.push_back(wheel);
            wheelHolder.push(wheel);
        });

        //controller
        const controllerSettings = new Raw.module.WheeledVehicleControllerSettings();
        controllerSettings.mEngine.mMaxTorque = this.settings.maxEngineTorque!;
        controllerSettings.mTransmission.mClutchStrength = this.settings.clutchStrength!;
        vehicle.mController = controllerSettings;

        // Front Diff
        controllerSettings.mDifferentials.clear();
        const frontWheelDrive = new Raw.module.VehicleDifferentialSettings();
        frontWheelDrive.mLeftWheel = FL_WHEEL;
        frontWheelDrive.mRightWheel = FR_WHEEL;
        frontWheelDrive.mLimitedSlipRatio = this.settings.leftRightLimitedSlipRatio!;
        if (this.settings.fourWheelDrive)
            frontWheelDrive.mEngineTorqueRatio = this.settings.splitEngineTorqueFront || 0.5;
        controllerSettings.mDifferentials.push_back(frontWheelDrive);
        controllerSettings.mDifferentialLimitedSlipRatio = this.settings.frontBackLimitedSlipRatio!;

        // Rear Diff
        if (this.settings.fourWheelDrive) {
            const rearWheelDrive = new Raw.module.VehicleDifferentialSettings();
            rearWheelDrive.mLeftWheel = BL_WHEEL;
            rearWheelDrive.mRightWheel = BR_WHEEL;
            rearWheelDrive.mLimitedSlipRatio = this.settings.leftRightLimitedSlipRatio!;
            rearWheelDrive.mEngineTorqueRatio = this.settings.splitEngineTorqueRear || 0.5;
            controllerSettings.mDifferentials.push_back(rearWheelDrive);
        }

        // Anti Roll Bars
        if (this.settings.antiRollbar) {
            const frontRollBar = new Raw.module.VehicleAntiRollBar();
            frontRollBar.mLeftWheel = FL_WHEEL;
            frontRollBar.mRightWheel = FR_WHEEL;
            if (this.settings.frontRollBarStiffness)
                frontRollBar.mStiffness = this.settings.frontRollBarStiffness;
            const rearRollBar = new Raw.module.VehicleAntiRollBar();
            rearRollBar.mLeftWheel = BL_WHEEL;
            rearRollBar.mRightWheel = BR_WHEEL;
            if (this.settings.rearRollBarStiffness)
                rearRollBar.mStiffness = this.settings.rearRollBarStiffness;
            vehicle.mAntiRollBars.push_back(frontRollBar);
            vehicle.mAntiRollBars.push_back(rearRollBar);
        }

        this.constraint = new Raw.module.VehicleConstraint(this.carBody, vehicle);
        console.log('constraint active', this.constraint.IsActive());
        //NOW we can create the wheelStates
        // TODO this process seems dirty....
        //@ts-ignore
        wheelHolder.forEach((wheel: any, i: number) => {
            const wheelState = new WheelState(this.constraint, i);
            this.wheels.set(wheelsToCreate[i], wheelState);
            this.threeObject.add(wheelState.threeObject);
        });

        //set the collision tester that checks the wheels for collision with the floor
        let tester;
        switch (this.settings.castType) {
            case 'cylinder':
                tester = new Raw.module.VehicleCollisionTesterCastCylinder(Layer.MOVING, 0.05);
                break;
            case 'sphere':
                tester = new Raw.module.VehicleCollisionTesterCastSphere(
                    Layer.MOVING,
                    0.5 * this.settings.wheelWidth!
                );
                break;
            default:
                tester = new Raw.module.VehicleCollisionTesterRay(Layer.MOVING);
                break;
        }
        this.constraint.SetVehicleCollisionTester(tester);

        // add to the JOLT physics system
        this.physicsSystem.physicsSystem.AddConstraint(this.constraint);
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.WheeledVehicleController
        );
        this.physicsSystem.physicsSystem.AddStepListener(
            new Raw.module.VehicleConstraintStepListener(this.constraint)
        );
    }
    //* Event Listeners and Triggers ========================

    // create core listener handles
    private bindListeners() {
        const callbacks = new Raw.module.VehicleConstraintCallbacksJS();
        callbacks.GetCombinedFriction = (
            wheelIndex,
            tireFrictionDirection,
            tireFriction,
            body2,
            subShapeID2
        ) => {
            //this exists solely to get typescript to stop complainig
            //@ts-ignore
            const uselessprop = wheelIndex + tireFrictionDirection + subShapeID2;
            //@ts-ignore this is a TS bug in wrapPointer
            body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
            //@ts-ignore
            return Math.sqrt(tireFriction * body2.GetFriction()); // This is the default calculation
        };
        callbacks.OnPreStepCallback = (vehicle, deltaTime, physicsSystem) => {
            this.triggerListeners('preStepListeners', vehicle, deltaTime, physicsSystem);
        };
        callbacks.OnPostCollideCallback = (vehicle, deltaTime, physicsSystem) => {
            this.triggerListeners('postCollideListeners', vehicle, deltaTime, physicsSystem);
        };
        callbacks.OnPostStepCallback = (vehicle, deltaTime, physicsSystem) => {
            this.triggerListeners('postStepListeners', vehicle, deltaTime, physicsSystem);
        };
        callbacks.SetVehicleConstraint(this.constraint);
    }
    //trigger listeners
    triggerListeners(listenerType: any, vehicle: any, deltaTime: any, physicsSystem: any) {
        //@ts-ignore
        const listeners = this[listenerType];
        listeners.forEach((listener: any) => {
            listener(vehicle, deltaTime, physicsSystem);
        });
    }
    // for actions
    triggerActions(action: any) {
        this.actionListeners.forEach((listener: any) => {
            listener(action);
        });
    }
    // add a listener to the correct type and return a function to remove the listener
    private addListener(listenerType: any, listener: any) {
        //@ts-ignore
        this[listenerType].push(listener);
        return () => {
            //@ts-ignore
            this[listenerType] = this[listenerType].filter((l: any) => l !== listener);
        };
    }
    //explicit callback shorthands
    onPreStep(listener: any) {
        return this.addListener('preStepListeners', listener);
    }
    onPostCollide(listener: any) {
        return this.addListener('postCollideListeners', listener);
    }
    onPostStep(listener: any) {
        return this.addListener('postStepListeners', listener);
    }
    // take an action type and filter it
    onAction(actionType: string, listener: any) {
        const newListener = (action: any) => {
            if (action === actionType) listener(action, this);
        };
        //@ts-ignore
        this.actionListeners.push(newListener);
        return () => {
            this.actionListeners = this.actionListeners.filter((l) => l !== newListener);
        };
    }
    //* Input Handling ====================================
    move(direction: any) {
        //console.log('move', direction);
        this.moveDirection = direction;
    }
    setHandBrake(value: any) {
        this.handBrake = value;
    }
    setBrake(value: any) {
        this.brake = value;
    }
    triggerTurbo(extraTime?: any) {
        this.turboActive = true;
        this.turboTimeLimit;
        setTimeout(() => {
            this.turboActive = false;
        }, extraTime || this.turboTimeLimit);
    }
    setPosition(position: any) {
        this.physicsSystem.bodyInterface.SetPosition(
            this.carBody.GetID(),
            vec3.jolt(position),
            Raw.module.EActivation_Activate
        );
    }

    //* Physics Update ====================================
    // attach to loop
    // we are going to do this in the main vehicle system
    /*
    private attachToLoop() {
        this.physicsSystem.addPreStepListener(this.prePhysicsUpdate);
        this.physicsSystem.addPostStepListener(this.postPhysicsUpdate);
    }
    */
    //@ts-ignore deltaTime not used at the moment but it's here if we need it
    prePhysicsUpdate(deltaTime: number) {
        let forward = this.moveDirection.y;
        const right = this.moveDirection.x;
        let brake = 0;
        let handBrake = 0;
        // if we have reveresed direction
        if (this.previousForward * forward < 0) {
            const rotation = quat.joltToThree(this.carBody.GetRotation().Conjugated());
            const linearVelocity = vec3.joltToThree(this.carBody.GetLinearVelocity());
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
        this.controller.SetDriverInput(forward, right, brake, handBrake);
        if (right != 0 || forward != 0 || brake != 0 || handBrake != 0) {
            this.physicsSystem.bodyInterface.ActivateBody(this.carBody.GetID());
        }
    }
    //@ts-ignore
    postPhysicsUpdate(deltaTime) {
        // lets try what happens if we update the render state after the world tick
        this.threeObject.position.copy(vec3.three(this.carBody.GetPosition()));
        this.threeObject.quaternion.copy(quat.joltToThree(this.carBody.GetRotation()));
        this.updateWheelTransforms();
    }
    //update the wheels
    updateWheelTransforms() {
        this.wheels.forEach((wheel) => {
            wheel.updateLocalTransform();
        });
    }
}
