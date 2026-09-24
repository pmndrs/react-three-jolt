import type Jolt from 'jolt-physics';
import { Layer, type PhysicsSystem, Raw } from '../../../index';
import { VehicleManager } from './vehicle-manager';
import type { ResolvedTrackedVehicleSettings, TrackedVehicleSettings } from './vehicle-settings';
import type { WheelKind } from './wheel-state';
import { createTrackedWheelSettings } from './wheels';

const clamp = (value: number, limit = 1) =>
    value < -limit ? -limit : value > limit ? limit : value;

/**
 * A tank: two tracks driven by jolt's `TrackedVehicleController` (issue #246). There is no
 * steering wheel - the vehicle turns by running its two tracks at different speeds - so the
 * generic `move()` input (forward/back, left/right) is mixed into the `leftRatio`/`rightRatio`
 * jolt's controller wants rather than being forwarded as a steering angle.
 */
export class TrackedVehicleManager extends VehicleManager {
    declare settings: ResolvedTrackedVehicleSettings;
    declare controller: Jolt.TrackedVehicleController;

    constructor(physicsSystem: PhysicsSystem, settings: TrackedVehicleSettings = {}) {
        super(physicsSystem, { ...settings, type: 'tracked' });
    }

    protected wheelKind(): WheelKind {
        return 'tv';
    }

    createConstraint() {
        // Ownership here is the same as `VehicleManager.createConstraint`: `mWheels`/
        // `mController` are Ref<> members the settings (and then the constraint) own; `vehicle`
        // itself is ours and is destroyed once the constraint has been built.
        const settings = this.settings;
        const vehicle = new Raw.module.VehicleConstraintSettings();
        vehicle.mMaxPitchRollAngle = settings.maxPitchRollAngle;
        vehicle.mWheels.clear();

        const count = settings.wheels?.count ?? 4;
        // left track first (global wheel indices 0..count-1), then right (count..2*count-1) -
        // `addWheelState` below has to agree with this order, since it is what fixes each
        // WheelState's constraint index
        const layout: { side: 'left' | 'right'; indexInTrack: number }[] = [];
        for (let i = 0; i < count; i++) layout.push({ side: 'left', indexInTrack: i });
        for (let i = 0; i < count; i++) layout.push({ side: 'right', indexInTrack: i });
        layout.forEach(({ side, indexInTrack }) => {
            vehicle.mWheels.push_back(
                createTrackedWheelSettings(settings, side, indexInTrack, count)
            );
        });

        // controller: engine and transmission are configured exactly like the wheeled/motorcycle
        // controllers (both are plain Ref<> members of the controller settings)
        const controllerSettings = new Raw.module.TrackedVehicleControllerSettings();
        controllerSettings.mEngine.mMaxTorque = settings.maxEngineTorque;
        controllerSettings.mTransmission.mClutchStrength = settings.clutchStrength;
        vehicle.mController = controllerSettings;

        // `get_mTracks(index)` returns a live reference into `TrackedVehicleControllerSettings`'s
        // own fixed size mTracks[2] array (verified against the jolt-physics wasm glue), not a
        // copy - so the fields below are written straight onto the settings and there is no
        // `set_mTracks` call to make afterwards, exactly like `controllerSettings.mEngine` above.
        const leftTrack = controllerSettings.get_mTracks(0);
        leftTrack.mDrivenWheel = settings.left.drivenWheel ?? 0;
        leftTrack.mWheels.clear();
        for (let i = 0; i < count; i++) leftTrack.mWheels.push_back(i);
        if (settings.left.inertia !== undefined) leftTrack.mInertia = settings.left.inertia;
        if (settings.left.angularDamping !== undefined)
            leftTrack.mAngularDamping = settings.left.angularDamping;
        if (settings.left.maxBrakeTorque !== undefined)
            leftTrack.mMaxBrakeTorque = settings.left.maxBrakeTorque;
        if (settings.left.differentialRatio !== undefined)
            leftTrack.mDifferentialRatio = settings.left.differentialRatio;

        const rightTrack = controllerSettings.get_mTracks(1);
        rightTrack.mDrivenWheel = settings.right.drivenWheel ?? 0;
        rightTrack.mWheels.clear();
        for (let i = 0; i < count; i++) rightTrack.mWheels.push_back(count + i);
        if (settings.right.inertia !== undefined) rightTrack.mInertia = settings.right.inertia;
        if (settings.right.angularDamping !== undefined)
            rightTrack.mAngularDamping = settings.right.angularDamping;
        if (settings.right.maxBrakeTorque !== undefined)
            rightTrack.mMaxBrakeTorque = settings.right.maxBrakeTorque;
        if (settings.right.differentialRatio !== undefined)
            rightTrack.mDifferentialRatio = settings.right.differentialRatio;

        this.constraint = new Raw.module.VehicleConstraint(this.carBody, vehicle);

        // now we have the constraint we can create the wheelStates (issue #27: picks up any
        // injected wheel objects)
        layout.forEach(({ side, indexInTrack }, index) => {
            this.addWheelState(`${side === 'left' ? 'l' : 'r'}${indexInTrack}`, index);
        });

        let tester: Jolt.VehicleCollisionTester;
        switch (settings.castType) {
            case 'ray':
                tester = new Raw.module.VehicleCollisionTesterRay(Layer.MOVING);
                break;
            case 'sphere':
                tester = new Raw.module.VehicleCollisionTesterCastSphere(
                    Layer.MOVING,
                    0.5 * (settings.wheels?.width ?? 0.4)
                );
                break;
            default:
                tester = new Raw.module.VehicleCollisionTesterCastCylinder(Layer.MOVING, 0.05);
                break;
        }
        this.attachConstraint(tester);
        this.controller = Raw.module.castObject(
            this.constraint.GetController(),
            Raw.module.TrackedVehicleController
        );
        // issue #41: the readouts read the engine/transmission off `this.controller` through a
        // `WheeledVehicleController`-typed getter - `TrackedVehicleController` exposes the same
        // `GetEngine`/`GetTransmission`/`GetForwardInput`/`GetBrakeInput` methods at runtime, so
        // the base class's readouts work here unmodified.
        this.bindControllerReadouts();

        // the constraint has copied the wheels and built its controller, so the settings (and
        // everything they own) can go
        Raw.module.destroy(vehicle);
    }

    /**
     * `TrackedVehicleController.SetDriverInput(forward, leftRatio, rightRatio, brake)` has a
     * different shape than `WheeledVehicleController`'s (no separate hand brake, and steering is
     * a pair of per-track ratios rather than a single angle), so this replaces the base
     * implementation rather than extending it. `prePhysicsUpdate` (inherited, unchanged) still
     * supplies `right` as the steering input and folds the hand brake into `brake` before
     * calling here.
     *
     * Skid steering: the track on the outside of the turn is sped up and the inside one slowed
     * (or reversed, for a turn sharp enough to pivot in place) by the same amount, so driving
     * straight (`right === 0`) always asks both tracks for exactly `forward`.
     */
    protected driverInput(forward: number, right: number, brake: number, handBrake: number) {
        const turn = clamp(right);
        const leftRatio = clamp(forward + turn);
        const rightRatio = clamp(forward - turn);
        this.controller.SetDriverInput(forward, leftRatio, rightRatio, Math.max(brake, handBrake));
    }
}
