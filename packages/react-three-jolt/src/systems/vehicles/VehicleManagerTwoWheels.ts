import * as THREE from 'three';
import Jolt from 'jolt-physics';
import { Raw } from '../../raw';
import { vec3, quat } from '../../utils';
import { Layer, PhysicsSystem } from '../physics-system';
import {
    VehicleFourWheelSettings,
    WheelState,
    createWheelSettings
} from './wheels';
import { VehicleManager } from './VehicleManager';

const FL_WHEEL = 0;
const FR_WHEEL = 1;
const BL_WHEEL = 2;
const BR_WHEEL = 3;

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
    constructor(
        physicsSystem: PhysicsSystem,
        settings: VehicleTwoWheelSettings
    ) {
        super(physicsSystem, settings);
        // TODO: is this necessary?
        this.settings = settings;
    }

    // this createBody is different for motorcycles
    createBody() {
        // from jolt example
        const motorcycleShapeSettings =
            new Raw.module.OffsetCenterOfMassShapeSettings(
                new Raw.module.Vec3(0, -this.settings.vehicleHeight! / 2, 0),
                new Raw.module.BoxShapeSettings(
                    new Raw.module.Vec3(
                        this.settings.vehicleWidth! / 2,
                        this.settings.vehicleHeight! / 2,
                        this.settings.vehicleLength! / 2
                    )
                )
            );
        const motorcycleShape = motorcycleShapeSettings.Create().Get();
        const motorcycleBodySettings = new Raw.module.BodyCreationSettings(
            motorcycleShape,
            new Raw.module.RVec3(...this.settings.bodyPosition),
            Raw.module.Quat.prototype.sRotation(
                new Raw.module.Vec3(0, 1, 0),
                Math.PI
            ),
            Raw.module.EMotionType_Dynamic,
            Layer.MOVING
        );
        motorcycleBodySettings.mOverrideMassProperties =
            Raw.module.EOverrideMassProperties_CalculateInertia;
        motorcycleBodySettings.mMassPropertiesOverride.mMass =
            this.settings.vehicleMass! | 250;
        const motorcycleBody = this.physicsSystem.bodyInterface.CreateBody(
            motorcycleBodySettings
        );
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
            this.settings.wheels.front.posZ
        );
        front.mPosition = vec3.jolt(frontPosition);

        front.mMaxSteerAngle = this.settings.wheels.front.maxSteerAngle;
        front.mSuspensionDirection = new Raw.module.Vec3(
            0,
            -1,
            Math.tan(this.settings.casterAngle)
        ).Normalized();
        front.mSteeringAxis = new Raw.module.Vec3(
            0,
            1,
            -Math.tan(this.settings.casterAngle)
        ).Normalized();

        front.mRadius = this.settings.wheels.radius;
        front.mWidth = this.settings.wheels.width;
        front.mSuspensionMinLength = this.settings.wheels.suspensionMinLength;
        front.mSuspensionMaxLength = this.settings.wheels.suspensionMaxLength;
        front.mSuspensionSpring.mFrequency =
            this.settings.wheels.front.suspensionFreq;
        front.mMaxBrakeTorque = this.settings.wheels.front.brakeTorque;

        vehicle.mWheels.push_back(front);

        const back = new Raw.module.WheelSettingsWV();
        back.mPosition = new Raw.module.Vec3(
            0.0,
            (-0.9 * this.settings.vehicleHeight!) / 2,
            this.settings.wheels.back.posZ
        );
        back.mMaxSteerAngle = 0.0;
        back.mRadius = this.settings.wheels.radius;
        back.mWidth = this.settings.wheels.width;
        back.mSuspensionMinLength = this.settings.wheels.suspensionMinLength;
        back.mSuspensionMaxLength = this.settings.wheels.suspensionMaxLength;
        back.mSuspensionSpring.mFrequency =
            this.settings.wheels.back.suspensionFreq;
        back.mMaxBrakeTorque = this.settings.wheels.back.brakeTorque;

        vehicle.mWheels.push_back(back);

        // create the controller
        const controllerSettings =
            new Raw.module.MotorcycleControllerSettings();
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
        controllerSettings.mDifferentials.push_back(differential);

        this.constraint = new Raw.module.VehicleConstraint(
            this.carBody,
            vehicle
        );

        const tester = new Raw.module.VehicleCollisionTesterCastCylinder(
            Layer.MOVING,
            1
        );
        this.constraint.SetVehicleCollisionTester(tester);

        console.log('wheel count', vehicle.mWheels.size());
        // now we have the constraint we can set the wheelStates
        const frontState = new WheelState(this.constraint, 0);
        this.wheels.set('front', frontState);
        this.threeObject.add(frontState.threeObject);
        //now the back
        const backState = new WheelState(this.constraint, 1);
        this.wheels.set('back', backState);
        this.threeObject.add(backState.threeObject);

        // add the constraint to the physics system
        this.physicsSystem.physicsSystem.AddConstraint(this.constraint);
        // SUPER IMPORTANT WEIRD LOOP LISTENER
        this.physicsSystem.physicsSystem.AddStepListener(
            new Raw.module.VehicleConstraintStepListener(this.constraint)
        );
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.MotorcycleController
        );
    }

    // run the physics step
    prePhysicsUpdate(deltaTime: number): void {
        let forward = this.moveDirection.y;
        let right = this.moveDirection.x;
        let brake = 0.0,
            handBrake = 0.0;

        if (this.previousForward * forward < 0.0) {
            const rotation = quat.joltToThree(
                this.carBody.GetRotation().Conjugated()
            );
            const linearV = vec3.three(this.carBody.GetLinearVelocity());
            const velocity = linearV.applyQuaternion(rotation).z;
            if (
                (forward > 0.0 && velocity < -0.1) ||
                (forward < 0.0 && velocity > 0.1)
            ) {
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
