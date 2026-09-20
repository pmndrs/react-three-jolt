import {
    createShapeFromSettings,
    Layer,
    PhysicsSystem,
    quat,
    Raw,
    releaseShape,
    vec3,
    withJolt
} from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { VehicleManager } from './VehicleManager';
import {
    VehicleFourWheelSettings,
    WheelState
    //createWheelSettings
} from './wheels';

/*
const FL_WHEEL = 0;
const FR_WHEEL = 1;
const BL_WHEEL = 2;
const BR_WHEEL = 3;
*/

//TODO Fix this type
interface VehicleTwoWheelSettings extends VehicleFourWheelSettings {
    backWheelRadius: number;
    backWheelWidth: number;
    backWheelPosZ: number;
    backWheelSuspensionMinLength: number;
    backWheelSuspensionMaxLength: number;
    backSuspensionFreq: number;
    backBrakeTorque: number;

    frontWheelRadius: number;
    frontWheelWidth: number;
    frontWheelPosZ: number;
    frontSuspensionMinLength: number;
    frontSuspensionMaxLength: number;
    frontSuspensionFreq: number;
    frontBrakeTorque: number;

    steerSpeed: number;
    casterAngle: number;
    maxPitchRollAngle: number;
}

export class VehicleManagerTwoWheels extends VehicleManager {
    currentRight = 0;
    settings: VehicleTwoWheelSettings;
    constructor(physicsSystem: PhysicsSystem, settings: VehicleTwoWheelSettings) {
        super(physicsSystem, settings);
        // TODO: is this necessary?
        this.settings = settings;
    }

    // this createBody is different for motorcycles
    createBody(): Jolt.Body {
        // from jolt example.
        // Ownership is the same as the four wheel version: the outer shape settings own the inner
        // box settings, the vectors are copied on assignment, and `createShapeFromSettings` takes
        // a real reference on the shape (`Create().Get()` only borrowed a static one).
        const halfExtents = vec3.jolt([
            this.settings.vehicleWidth! / 2,
            this.settings.vehicleHeight! / 2,
            this.settings.vehicleLength! / 2
        ]);
        const centerOfMassOffset = vec3.jolt([0, -this.settings.vehicleHeight! / 2, 0]);
        const motorcycleShapeSettings = new Raw.module.OffsetCenterOfMassShapeSettings(
            centerOfMassOffset,
            new Raw.module.BoxShapeSettings(halfExtents)
        );
        Raw.module.destroy(halfExtents);
        Raw.module.destroy(centerOfMassOffset);
        const motorcycleShape = createShapeFromSettings(motorcycleShapeSettings);

        const bodyPosition = vec3.rjolt(this.settings.bodyPosition);
        const upAxis = vec3.jolt([0, 1, 0]);
        const motorcycleBodySettings = new Raw.module.BodyCreationSettings(
            motorcycleShape,
            bodyPosition,
            // sRotation returns a static temporary; the Vec3 handed to it is ours
            Raw.module.Quat.prototype.sRotation(upAxis, Math.PI),
            Raw.module.EMotionType_Dynamic,
            Layer.MOVING
        );
        Raw.module.destroy(bodyPosition);
        Raw.module.destroy(upAxis);
        motorcycleBodySettings.mOverrideMassProperties =
            Raw.module.EOverrideMassProperties_CalculateInertia;
        motorcycleBodySettings.mMassPropertiesOverride.mMass = this.settings.vehicleMass! | 250;
        const motorcycleBody = this.physicsSystem.bodyInterface.CreateBody(motorcycleBodySettings);
        Raw.module.destroy(motorcycleBodySettings);
        releaseShape(motorcycleShape);
        // DONT FORGET TO ADD TO THE SIMULATION
        this.physicsSystem.bodyInterface.AddBody(
            motorcycleBody.GetID(),
            Raw.module.EActivation_Activate
        );
        this.carBody = motorcycleBody;
        const debugMesh = new THREE.Mesh(
            new THREE.BoxGeometry(
                this.settings.vehicleWidth!,
                this.settings.vehicleHeight!,
                this.settings.vehicleLength!
            ),
            new THREE.MeshStandardMaterial({ color: '#EAF0CE' })
        );
        this.threeObject.add(debugMesh);

        return motorcycleBody;
    }
    // create the primary Jolt items and generate the wheels
    createConstraint() {
        const vehicle = new Raw.module.VehicleConstraintSettings();
        vehicle.mMaxPitchRollAngle = this.settings.maxPitchRollAngle!;
        vehicle.mWheels.clear();

        // motorcycle makes the wheels declaritively. have to figure out the wheelState
        // TODO rewrite these to use the createWheelSettings()
        const front = new Raw.module.WheelSettingsWV();
        const frontPosition = new THREE.Vector3(
            0.0,
            (-0.9 * this.settings.vehicleHeight!) / 2,
            //@ts-ignore
            this.settings.wheels.front.posZ
        );
        // the settings copy the vector on assignment, so release the temporary `vec3.jolt` made
        withJolt(frontPosition, (v) => {
            front.mPosition = v;
        });
        //@ts-ignore
        front.mMaxSteerAngle = this.settings.wheels.front.maxSteerAngle;
        // `Normalized()` returns a static temporary by value and the property assignment copies
        // it, so only the vector built here needs freeing - it used to leak one per wheel.
        withJolt([0, -1, Math.tan(this.settings.casterAngle)], (v) => {
            front.mSuspensionDirection = v.Normalized();
        });
        withJolt([0, 1, -Math.tan(this.settings.casterAngle)], (v) => {
            front.mSteeringAxis = v.Normalized();
        });

        if (this.settings.wheels.radius) front.mRadius = this.settings.wheels.radius;
        if (this.settings.wheels.width) front.mWidth = this.settings.wheels.width;
        if (this.settings.wheels.suspensionMinLength)
            front.mSuspensionMinLength = this.settings.wheels.suspensionMinLength;
        if (this.settings.wheels.suspensionMaxLength)
            front.mSuspensionMaxLength = this.settings.wheels.suspensionMaxLength;
        front.mSuspensionSpring.mFrequency =
            //@ts-ignore
            this.settings.wheels.front.suspensionFreq;
        //@ts-ignore
        front.mMaxBrakeTorque = this.settings.wheels.front.brakeTorque;

        vehicle.mWheels.push_back(front);

        const back = new Raw.module.WheelSettingsWV();
        withJolt(
            [
                0.0,
                (-0.9 * this.settings.vehicleHeight!) / 2,
                //@ts-ignore
                this.settings.wheels.back.posZ
            ],
            (v) => {
                back.mPosition = v;
            }
        );
        back.mMaxSteerAngle = 0.0;
        if (this.settings.wheels.radius) back.mRadius = this.settings.wheels.radius;
        if (this.settings.wheels.width) back.mWidth = this.settings.wheels.width;
        if (this.settings.wheels.suspensionMinLength)
            back.mSuspensionMinLength = this.settings.wheels.suspensionMinLength;
        if (this.settings.wheels.suspensionMaxLength)
            back.mSuspensionMaxLength = this.settings.wheels.suspensionMaxLength;
        back.mSuspensionSpring.mFrequency =
            //@ts-ignore
            this.settings.wheels.back.suspensionFreq;
        //@ts-ignore
        back.mMaxBrakeTorque = this.settings.wheels.back.brakeTorque;

        vehicle.mWheels.push_back(back);

        // create the controller
        const controllerSettings = new Raw.module.MotorcycleControllerSettings();
        controllerSettings.mEngine.mMaxTorque = 150.0;
        controllerSettings.mEngine.mMinRPM = 1000.0;
        controllerSettings.mEngine.mMaxRPM = 10000.0;
        controllerSettings.mTransmission.mShiftDownRPM = 2000.0;
        controllerSettings.mTransmission.mShiftUpRPM = 8000.0;
        controllerSettings.mTransmission.mClutchStrength = 2.0;
        vehicle.mController = controllerSettings;

        controllerSettings.mDifferentials.clear();
        const differential = new Raw.module.VehicleDifferentialSettings();
        differential.mLeftWheel = -1;
        differential.mRightWheel = 1;
        differential.mDifferentialRatio = (1.93 * 40.0) / 16.0;
        // the array holds differentials by value, so push_back copies and this one is ours
        controllerSettings.mDifferentials.push_back(differential);
        Raw.module.destroy(differential);

        this.constraint = new Raw.module.VehicleConstraint(this.carBody, vehicle);

        // now we have the constraint we can set the wheelStates
        const frontState = new WheelState(this.constraint, 0);
        this.wheels.set('front', frontState);
        this.threeObject.add(frontState.threeObject);
        //now the back
        const backState = new WheelState(this.constraint, 1);
        this.wheels.set('back', backState);
        this.threeObject.add(backState.threeObject);

        // the tester is owned by the constraint; the constraint is reference counted and its
        // step listener is ours - see VehicleManager.attachConstraint
        this.attachConstraint(new Raw.module.VehicleCollisionTesterCastCylinder(Layer.MOVING, 1));
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.MotorcycleController
        );

        // the constraint has taken everything it needs out of the settings (the wheels and the
        // controller settings are reference counted members, freed with the settings)
        Raw.module.destroy(vehicle);
    }

    // run the physics step
    prePhysicsUpdate(deltaTime: number): void {
        if (this.destroyed) return;
        let forward = this.moveDirection.y;
        let right = this.moveDirection.x;
        let brake = 0.0,
            handBrake = 0.0;

        if (this.previousForward * forward < 0.0) {
            // static temporaries read into the shared scratch objects, see VehicleManager
            const rotation = quat.joltToThree(
                this.carBody.GetRotation().Conjugated(),
                this._rotation
            );
            const linearV = vec3.three(
                this.carBody.GetLinearVelocity(),
                undefined,
                undefined,
                this._position
            );
            const velocity = linearV.applyQuaternion(rotation).z;
            if ((forward > 0.0 && velocity < -0.1) || (forward < 0.0 && velocity > 0.1)) {
                // Brake while we've not stopped yet
                forward = 0.0;
                brake = 1.0;
            } else {
                // When we've come to a stop, accept the new direction
                this.previousForward = forward;
            }
        }

        if (this.handBrake) {
            forward = 0.0;
            handBrake = 1.0;
        }

        if (right > this.currentRight)
            this.currentRight = Math.min(
                this.currentRight + this.settings.steerSpeed * deltaTime,
                right
            );
        else if (right < this.currentRight)
            this.currentRight = Math.max(
                this.currentRight - this.settings.steerSpeed * deltaTime,
                right
            );
        right = this.currentRight;

        this.controller.SetDriverInput(forward, right, brake, handBrake);
        if (right != 0.0 || forward != 0.0 || brake != 0.0 || handBrake != 0.0)
            this.physicsSystem.bodyInterface.ActivateBody(this.carBody.GetID());
    }
}
