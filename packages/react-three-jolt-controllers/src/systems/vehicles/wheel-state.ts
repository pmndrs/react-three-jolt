import { quat, Raw, vec3 } from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import type { ResolvedSkidSettings, ResolvedWheelSmoothingSettings } from './vehicle-settings';
import { disposeGeneratedObject, getWheelMaterial } from './wheels';

const TWO_PI = Math.PI * 2;

/** the exponential smoothing factor for a time constant of `tau` seconds over `dt` */
function easeFactor(tau: number, deltaTime: number) {
    if (tau <= 0 || deltaTime <= 0) return 1;
    return 1 - Math.exp(-deltaTime / tau);
}

/** what {@link WheelState.updateSkid} reports back to the manager */
export const SKID_UNCHANGED = 0;
export const SKID_STARTED = 1;
export const SKID_ENDED = -1;

/**
 * The three.js side of one wheel of a `VehicleConstraint`.
 *
 * `threeObject` is the container the wheel's local transform (including the steering rotation) is
 * written to every frame. Whatever is parented to it - the generated cylinder, or the object the
 * user injected through `setObject()` (issue #27) - follows the wheel.
 *
 * Issue #41 added the presentational layer: the rendered suspension travel and steering angle are
 * eased, and every readout a game needs for skid marks, tyre smoke and audio (`slipRatio`,
 * `lateralSlip`, `isSkidding`, `spinAngle`, `suspensionLength`) is published here every frame.
 * All of it is read out of jolt after the step and allocates nothing.
 */
export class WheelState {
    index: number;
    constraint: Jolt.VehicleConstraint | undefined;
    threeObject = new THREE.Object3D();
    /** the generated cylinder, if this wheel has one */
    debugObject?: THREE.Mesh;
    // because jolt isnt ready we'll put these here
    wheelRight: Jolt.Vec3 = new Raw.module.Vec3(0, 1, 0);
    wheelUp: Jolt.Vec3 = new Raw.module.Vec3(1, 0, 0);
    //true for now
    //TODO change this to default to false
    private isDebugging = true;
    /** issue #27: the object the *user* gave us. Synced, never disposed. */
    private userObject?: THREE.Object3D;

    //* Readouts (issue #41) ==================================================================
    /**
     * Jolt's longitudinal slip ratio: 0 while the tyre rolls, positive while it spins faster
     * than the ground under it (a standing start easily reaches 3), negative under lock up.
     */
    slipRatio = 0;
    /** Jolt's lateral slip angle in radians: the angle between where the tyre points and goes. */
    lateralSlip = 0;
    /** true while this wheel is over the skid thresholds (see `SkidSettings`) */
    isSkidding = false;
    /** true while the wheel is touching something */
    hasContact = false;
    /** the wheel's suspension length this frame, in metres */
    suspensionLength = 0;
    /**
     * The wheel's spin, in radians, accumulated rather than wrapped: it keeps growing while the
     * vehicle drives forward, so it can be handed to a shader or an odometer directly.
     */
    spinAngle = 0;
    /** the wheel's angular velocity in radians per second, straight from jolt */
    spinVelocity = 0;
    /** the steering angle that is actually rendered, in radians (eased) */
    steerAngle = 0;
    /** the steering angle jolt solved for this frame, in radians */
    rawSteerAngle = 0;

    // Im not sure we need this but I'll leave it for now
    wheelSettings: Jolt.WheelSettings | undefined;
    joltWheel: Jolt.Wheel | undefined;
    /**
     * The same wheel seen as a `WheelWV`, which is where the slip lives. `GetWheel` is typed (and
     * wrapped) as the base `Wheel`; `castObject` re-wraps the *same pointer*, and emscripten's
     * binder caches wrappers per pointer and class, so this is one object for the wheel's whole
     * life rather than a per frame allocation.
     */
    private wheelWV: Jolt.WheelWV | undefined;

    private destroyed = false;
    /** the vehicle's local up axis, which the steering rotates about. Read once, never changes. */
    private readonly steerAxis = new THREE.Vector3(0, 1, 0);
    /** true once the eased values have been seeded from jolt, so they don't lag in from zero */
    private primed = false;
    private lastRawSpin = 0;
    private skidTimer = 0;

    //* per frame scratch - updateLocalTransform runs for every wheel of every vehicle
    private readonly _position = new THREE.Vector3();
    private readonly _steerDelta = new THREE.Quaternion();

    set debug(value) {
        this.isDebugging = value;
        if (this.debugObject) this.debugObject.visible = value;
    }
    get debug() {
        return this.isDebugging;
    }
    /** whatever is being synced for this wheel: the user's object if there is one */
    get object(): THREE.Object3D | undefined {
        return this.userObject ?? this.debugObject;
    }

    constructor(
        constraint: Jolt.VehicleConstraint,
        wheelIndex: number,
        object?: THREE.Object3D | null
    ) {
        this.constraint = constraint;
        this.index = wheelIndex;
        this.joltWheel = constraint.GetWheel(wheelIndex);
        this.wheelSettings = this.joltWheel.GetSettings();
        // every wheel of a WheeledVehicleController (and so of a MotorcycleController too) is a
        // WheelWV; the cast is a re-wrap of the same pointer, not a conversion
        this.wheelWV = Raw.module.castObject(
            this.joltWheel,
            Raw.module.WheelWV
        ) as unknown as Jolt.WheelWV;
        // GetLocalUp returns a static temporary by value: read it, never destroy it
        vec3.joltToThree(constraint.GetLocalUp(), this.steerAxis);
        // a user supplied wheel replaces the generated one outright: no cylinder is ever built
        if (object) this.setObject(object);
        else this.createDebugWheel();
    }
    /**
     * Free the two axis vectors and the *generated* geometry (issue #140). The material is shared
     * between every wheel in the process, and an injected object belongs to the user, so neither
     * is disposed here (issue #27).
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        Raw.module.destroy(this.wheelRight);
        Raw.module.destroy(this.wheelUp);
        this.wheelRight = undefined as unknown as Jolt.Vec3;
        this.wheelUp = undefined as unknown as Jolt.Vec3;
        // hand the user's object back untouched before anything is disposed
        this.userObject?.removeFromParent();
        this.userObject = undefined;
        if (this.debugObject) disposeGeneratedObject(this.debugObject);
        this.debugObject = undefined;
        this.threeObject.clear();
        this.threeObject.removeFromParent();
        // the constraint owns the wheel; both are freed by VehicleManager.destroy(). `wheelWV` is
        // a wrapper around the same pointer as `joltWheel` - destroying it would be a double free.
        this.constraint = undefined;
        this.joltWheel = undefined;
        this.wheelWV = undefined;
        this.wheelSettings = undefined;
        this.isSkidding = false;
    }

    /**
     * Issue #27: inject (or replace) the object this wheel syncs. Passing `null` puts the
     * generated cylinder back. The manager never disposes an object handed to it this way; it is
     * simply detached again on `destroy()`.
     */
    setObject(object: THREE.Object3D | null) {
        if (this.destroyed) return;
        if (this.userObject && this.userObject !== object) {
            this.userObject.removeFromParent();
            this.userObject = undefined;
        }
        if (object) {
            // the generated wheel is ours, so it goes for good
            if (this.debugObject) {
                disposeGeneratedObject(this.debugObject);
                this.debugObject = undefined;
            }
            this.userObject = object;
            if (object.parent !== this.threeObject) this.threeObject.add(object);
        } else if (!this.debugObject) {
            this.createDebugWheel();
        }
    }

    createDebugWheel() {
        const radius = this.wheelSettings?.mRadius ?? 0.5;
        const width = this.wheelSettings?.mWidth ?? 0.3;
        const geometry = new THREE.CylinderGeometry(radius, radius, width, 20, 1);
        const mesh = new THREE.Mesh(geometry, getWheelMaterial());
        mesh.visible = this.isDebugging;
        this.debugObject = mesh;
        this.threeObject.add(mesh);
        return mesh;
    }
    add(object: THREE.Object3D) {
        this.threeObject.add(object);
    }

    /**
     * Read everything jolt solved for this wheel into the readouts above (issue #41).
     *
     * Every getter here returns a number or a static temporary; nothing is allocated and nothing
     * is destroyed.
     */
    private readState() {
        const wheel = this.wheelWV;
        if (!wheel) return;
        this.hasContact = wheel.HasContact();
        this.suspensionLength = wheel.GetSuspensionLength();
        this.spinVelocity = wheel.GetAngularVelocity();
        this.slipRatio = wheel.mLongitudinalSlip;
        this.lateralSlip = wheel.mLateralSlip;
        this.rawSteerAngle = wheel.GetSteerAngle();

        // jolt wraps the rotation angle into [0, 2pi); unwrap it so the readout keeps climbing
        const rawSpin = wheel.GetRotationAngle();
        if (this.primed) {
            let spinDelta = rawSpin - this.lastRawSpin;
            if (spinDelta > Math.PI) spinDelta -= TWO_PI;
            else if (spinDelta < -Math.PI) spinDelta += TWO_PI;
            this.spinAngle += spinDelta;
        }
        this.lastRawSpin = rawSpin;
    }

    /**
     * Advance the skid hysteresis and report the transition, if any, so the manager can emit it.
     * A wheel starts skidding the moment it crosses a threshold and only stops once it has been
     * back under `release` times that threshold for `releaseTime` seconds - without the delay a
     * wheel at the edge of grip machine-guns skid events at 60 Hz.
     */
    updateSkid(
        options: ResolvedSkidSettings | undefined,
        deltaTime: number,
        speed: number
    ): number {
        if (!options) {
            if (!this.isSkidding) return SKID_UNCHANGED;
            this.isSkidding = false;
            this.skidTimer = 0;
            return SKID_ENDED;
        }
        const longitudinal = Math.abs(this.slipRatio);
        // below `minLateralSpeed` jolt's atan2 is dividing noise by noise - see SkidSettings
        const lateral = speed < options.minLateralSpeed ? 0 : Math.abs(this.lateralSlip);
        const grounded = !options.requireContact || this.hasContact;
        if (!this.isSkidding) {
            const started =
                grounded &&
                (longitudinal > options.longitudinalSlip || lateral > options.lateralSlip);
            if (!started) return SKID_UNCHANGED;
            this.isSkidding = true;
            this.skidTimer = 0;
            return SKID_STARTED;
        }
        const stillSlipping =
            grounded &&
            (longitudinal > options.longitudinalSlip * options.release ||
                lateral > options.lateralSlip * options.release);
        if (stillSlipping) {
            this.skidTimer = 0;
            return SKID_UNCHANGED;
        }
        this.skidTimer += deltaTime;
        if (this.skidTimer < options.releaseTime) return SKID_UNCHANGED;
        this.isSkidding = false;
        this.skidTimer = 0;
        return SKID_ENDED;
    }

    // set the wheel position and rotation
    updateLocalTransform(deltaTime = 0, smoothing?: ResolvedWheelSmoothingSettings) {
        if (this.destroyed || !this.constraint) return;
        this.readState();
        // `GetWheelLocalTransform` (and `GetTranslation`/`GetRotation`/`GetQuaternion` below)
        // return by value, which the emscripten binder implements as a pointer to one static
        // temporary per function: not allocations, and never to be destroyed. Reading straight
        // into the three objects avoids the per frame THREE.Vector3/Quaternion garbage the old
        // `copy(vec3.three(...))` produced for every wheel of every vehicle.
        const transform = this.constraint.GetWheelLocalTransform(
            this.index,
            this.wheelRight,
            this.wheelUp
        );

        const target = vec3.three(transform.GetTranslation(), undefined, undefined, this._position);
        quat.joltToThree(transform.GetRotation().GetQuaternion(), this.threeObject.quaternion);

        if (!smoothing || !this.primed) {
            this.threeObject.position.copy(target);
            this.steerAngle = this.rawSteerAngle;
        } else {
            // the suspension is the only thing that moves the wheel in vehicle space, so easing
            // the local position *is* easing the suspension travel
            this.threeObject.position.lerp(target, easeFactor(smoothing.suspension, deltaTime));
            this.steerAngle +=
                (this.rawSteerAngle - this.steerAngle) * easeFactor(smoothing.steering, deltaTime);
            // jolt builds the wheel's transform as `steer(angle) * (everything else)`, all of it
            // about the vehicle's local up axis, so swapping the rendered steering angle in is a
            // single pre-multiplied delta rather than a rebuild of the transform.
            const steerDelta = this.steerAngle - this.rawSteerAngle;
            if (steerDelta !== 0) {
                this._steerDelta.setFromAxisAngle(this.steerAxis, steerDelta);
                this.threeObject.quaternion.premultiply(this._steerDelta);
            }
        }
        this.primed = true;
    }
}
