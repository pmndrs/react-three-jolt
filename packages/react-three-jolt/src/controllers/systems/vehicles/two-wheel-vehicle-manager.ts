import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import {
    createShapeFromSettings,
    Layer,
    type PhysicsSystem,
    quat,
    Raw,
    releaseShape,
    vec3,
    withJolt
} from '../../../index';
import { VehicleManager } from './vehicle-manager';
import type {
    ResolvedTwoWheelVehicleSettings,
    TwoWheelVehicleSettings,
    WheelSettingsTwoWheel
} from './vehicle-settings';

/**
 * A motorcycle: two wheels driven by jolt's `MotorcycleController`, with a caster angle on the
 * front fork and a steering speed the rider can't exceed.
 */
export class TwoWheelVehicleManager extends VehicleManager {
    currentRight = 0;
    // `declare` (not a redeclaration): with `useDefineForClassFields` a plain field declaration
    // would define `settings` as undefined *after* the base constructor filled it in.
    declare settings: ResolvedTwoWheelVehicleSettings;
    declare controller: Jolt.MotorcycleController;

    constructor(physicsSystem: PhysicsSystem, settings: TwoWheelVehicleSettings = {}) {
        super(physicsSystem, { ...settings, type: 'twoWheel' });
    }

    // this createBody is different for motorcycles
    createBody(): Jolt.Body {
        // from jolt example.
        // Ownership is the same as the four wheel version: the outer shape settings own the inner
        // box settings, the vectors are copied on assignment, and `createShapeFromSettings` takes
        // a real reference on the shape (`Create().Get()` only borrowed a static one).
        const halfExtents = vec3.jolt([
            this.settings.vehicleWidth / 2,
            this.settings.vehicleHeight / 2,
            this.settings.vehicleLength / 2
        ]);
        const centerOfMassOffset = vec3.jolt([0, -this.settings.vehicleHeight / 2, 0]);
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
        motorcycleBodySettings.mMassPropertiesOverride.mMass = this.settings.vehicleMass;
        const motorcycleBody = this.physicsSystem.bodyInterface.CreateBody(motorcycleBodySettings);
        Raw.module.destroy(motorcycleBodySettings);
        releaseShape(motorcycleShape);
        // DONT FORGET TO ADD TO THE SIMULATION
        this.physicsSystem.bodyInterface.AddBody(
            motorcycleBody.GetID(),
            Raw.module.EActivation_Activate
        );
        this.carBody = motorcycleBody;
        // the caller's chassis object if they injected one, otherwise our own box (issue #26)
        this.applyBodyObject();

        return motorcycleBody;
    }

    /** the generated stand-in chassis of a motorcycle: one box, no cab */
    protected createDebugBody(): THREE.Mesh {
        const debugMesh = new THREE.Mesh(
            new THREE.BoxGeometry(
                this.settings.vehicleWidth,
                this.settings.vehicleHeight,
                this.settings.vehicleLength
            ),
            new THREE.MeshStandardMaterial({ color: '#EAF0CE' })
        );
        debugMesh.visible = this.isDebugging;
        this.debugObject = debugMesh;
        this.threeObject.add(debugMesh);
        return debugMesh;
    }

    /** apply the settings shared by both wheels of a motorcycle */
    private applyWheelSettings(wheel: Jolt.WheelSettingsWV, settings: WheelSettingsTwoWheel) {
        const shared = this.settings.wheels;
        const radius = settings.radius ?? shared.radius;
        const width = settings.width ?? shared.width;
        const suspensionMinLength = settings.suspensionMinLength ?? shared.suspensionMinLength;
        const suspensionMaxLength = settings.suspensionMaxLength ?? shared.suspensionMaxLength;
        if (radius !== undefined) wheel.mRadius = radius;
        if (width !== undefined) wheel.mWidth = width;
        if (suspensionMinLength !== undefined) wheel.mSuspensionMinLength = suspensionMinLength;
        if (suspensionMaxLength !== undefined) wheel.mSuspensionMaxLength = suspensionMaxLength;
        if (settings.suspensionFreq !== undefined)
            wheel.mSuspensionSpring.mFrequency = settings.suspensionFreq;
        if (settings.brakeTorque !== undefined) wheel.mMaxBrakeTorque = settings.brakeTorque;
        wheel.mMaxSteerAngle = settings.maxSteerAngle ?? 0;
        // `mPosition` copies the vector, so the temporary built here is ours to free
        withJolt(
            settings.position ?? [
                0.0,
                (-0.9 * this.settings.vehicleHeight) / 2,
                settings.posZ ?? 0
            ],
            (value) => {
                wheel.mPosition = value;
            }
        );
    }

    // create the primary Jolt items and generate the wheels
    createConstraint() {
        const vehicle = new Raw.module.VehicleConstraintSettings();
        vehicle.mMaxPitchRollAngle = this.settings.maxPitchRollAngle;
        vehicle.mWheels.clear();

        // motorcycle makes the wheels declaratively (the front one has a caster angle), so it
        // doesn't go through `createWheelSettings`
        const front = new Raw.module.WheelSettingsWV();
        this.applyWheelSettings(front, this.settings.wheels.front ?? {});
        // `Normalized()` returns a static temporary by value and the property assignment copies
        // it, so only the vector built here needs freeing - it used to leak one per wheel.
        withJolt([0, -1, Math.tan(this.settings.casterAngle)], (v) => {
            front.mSuspensionDirection = v.Normalized();
        });
        withJolt([0, 1, -Math.tan(this.settings.casterAngle)], (v) => {
            front.mSteeringAxis = v.Normalized();
        });
        vehicle.mWheels.push_back(front);

        const back = new Raw.module.WheelSettingsWV();
        this.applyWheelSettings(back, this.settings.wheels.back ?? {});
        back.mMaxSteerAngle = 0.0;
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

        // now we have the constraint we can set the wheelStates (which pick up any injected
        // wheel objects, issue #27)
        this.addWheelState('front', 0);
        this.addWheelState('back', 1);

        // the tester is owned by the constraint; the constraint is reference counted and its
        // step listener is ours - see VehicleManager.attachConstraint
        this.attachConstraint(new Raw.module.VehicleCollisionTesterCastCylinder(Layer.MOVING, 1));
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.MotorcycleController
        );
        // issue #41: a MotorcycleController *is* a WheeledVehicleController, so it has the same
        // engine and gearbox the readouts are built from
        this.bindControllerReadouts();

        // the constraint has taken everything it needs out of the settings (the wheels and the
        // controller settings are reference counted members, freed with the settings)
        Raw.module.destroy(vehicle);
    }

    // run the physics step
    prePhysicsUpdate(deltaTime: number): void {
        if (this.destroyed) return;
        let forward = this.moveDirection.y;
        let right = this.moveDirection.x;
        let brake = 0.0;
        let handBrake = 0.0;

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

        this.driverInput(forward, right, brake, handBrake);
        if (right !== 0.0 || forward !== 0.0 || brake !== 0.0 || handBrake !== 0.0)
            this.physicsSystem.bodyInterface.ActivateBody(this.carBody.GetID());
    }
}

/** @deprecated renamed to `TwoWheelVehicleManager` (issue #10) */
export const VehicleManagerTwoWheels = TwoWheelVehicleManager;
/** @deprecated renamed to `TwoWheelVehicleManager` (issue #10) */
export type VehicleManagerTwoWheels = TwoWheelVehicleManager;
