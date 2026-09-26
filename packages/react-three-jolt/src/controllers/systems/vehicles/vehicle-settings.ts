// The typed settings surface of the vehicle API (issue #10).
//
// Everything a vehicle can be configured with lives here: the jolt side (VehicleConstraintSettings,
// the controller, the suspension and the differentials) and our own layout helpers. The managers
// used to take `settings: any`, which meant none of this was discoverable and every typo was
// silently accepted.

import type * as THREE from 'three';
import { MathUtils } from 'three';

/** The vehicle flavours the library ships. `fourWheel` is the default. */
export type VehicleType = 'fourWheel' | 'twoWheel' | 'tracked';

/** [x, y, z] */
export type Vector = [number, number, number];

/**
 * How the wheels are tested against the world. `cylinder` is the most accurate, `ray` the
 * cheapest. See jolt's `VehicleCollisionTester*`.
 */
export type WheelCastType = 'ray' | 'sphere' | 'cylinder';

/** Spring settings of a wheel's suspension (jolt `SpringSettings`). */
export interface SuspensionSpringSettings {
    frequency?: number;
    damping?: number;
}

/**
 * Settings shared by every wheel, mirroring jolt's `WheelSettings`
 * (https://jrouwe.github.io/JoltPhysics/class_wheel_settings_w_v.html) plus the few layout
 * helpers this library adds.
 */
export interface WheelSettings {
    inertia?: number;
    angularDamping?: number;
    width?: number;
    radius?: number;
    /**
     * Attachment point on the chassis in local space. When omitted the position is derived from
     * `wheelOffsetHorizontal` / `wheelOffsetVertical` and the vehicle width.
     */
    position?: Vector;
    /** where the suspension force is applied, best kept at the centre of the wheel */
    suspensionForcePoint?: Vector;
    /** should point down, e.g. [0, -1, 0] */
    suspensionDirection?: Vector;
    /** think of a bike's suspension, pointing towards the frame: [0, 1, 0] */
    steeringAxis?: Vector;
    /** can be used to give camber */
    wheelUp?: Vector;
    /** can be used to give toe */
    wheelForward?: Vector;
    suspensionMinLength?: number;
    suspensionMaxLength?: number;
    /** gives the springs more bounce */
    suspensionPreloadLength?: number;
    /** jolt advises against enabling this */
    enableSuspensionForcePoint?: boolean;
    suspensionSpring?: SuspensionSpringSettings;

    //* layout helpers (not jolt settings) ---------------------------------------------------
    /** distance from the centre of the chassis along z; ignored when `position` is given */
    wheelOffsetHorizontal?: number;
    /** distance below the centre of the chassis; ignored when `position` is given */
    wheelOffsetVertical?: number;
    /**
     * Issue #27: the object the manager should sync for this wheel. When supplied no default
     * cylinder is generated and the object is never disposed by the manager.
     */
    object?: THREE.Object3D | null;
}

/** A wheel driven by jolt's `WheeledVehicleController`. */
export interface WheelSettingsFourWheel extends WheelSettings {
    /** radians; 1.22 (70 degrees) is jolt's default */
    maxSteerAngle?: number;
    maxBrakeTorque?: number;
    maxHandBrakeTorque?: number;
}

/** A wheel of a motorcycle, driven by jolt's `MotorcycleController`. */
export interface WheelSettingsTwoWheel extends WheelSettings {
    maxSteerAngle?: number;
    /** position of the wheel along z */
    posZ?: number;
    suspensionFreq?: number;
    brakeTorque?: number;
}

/** Wheel settings for a four wheeled vehicle: shared defaults plus a per corner override. */
export interface FourWheelWheelSettings extends WheelSettingsFourWheel {
    fl?: WheelSettingsFourWheel;
    fr?: WheelSettingsFourWheel;
    bl?: WheelSettingsFourWheel;
    br?: WheelSettingsFourWheel;
}

/** Wheel settings for a two wheeled vehicle: shared defaults plus a per wheel override. */
export interface TwoWheelWheelSettings extends WheelSettingsTwoWheel {
    front?: WheelSettingsTwoWheel;
    back?: WheelSettingsTwoWheel;
}

/**
 * A wheel of a tracked vehicle, driven by jolt's `TrackedVehicleController`. Unlike a `WheelWV`
 * it never steers - the whole track turns the vehicle - so the only jolt properties beyond the
 * shared `WheelSettings` are the two friction curves jolt's `WheelSettingsTV` adds.
 */
export interface WheelSettingsTracked extends WheelSettings {
    longitudinalFriction?: number;
    lateralFriction?: number;
}

/**
 * One track of a tracked vehicle (jolt's `VehicleTrackSettings`): the wheel the engine drives and
 * how the track as a whole answers the throttle and the brake. `drivenWheel` is an index into
 * *this track's own* wheel list (jolt: "Index (in mWheels) of the wheel that's driven by the
 * engine"), not a global wheel index - 0, the frontmost wheel, is a sound default.
 */
export interface TrackSettings {
    drivenWheel?: number;
    inertia?: number;
    angularDamping?: number;
    maxBrakeTorque?: number;
    differentialRatio?: number;
}

/** The wheels of a tracked vehicle: shared settings plus how many sit on each side. */
export interface TrackedVehicleWheelSettings extends WheelSettingsTracked {
    /** wheels per side, evenly spaced front to back (default 4) */
    count?: number;
}

//* Secondary physics (issue #41) =============================================================
//
// The presentational layer that sits on top of the constraint. None of it touches the
// simulation: it reads what jolt solved and drives the three objects (and the readouts a game
// needs for particles, skid marks and engine audio) from that.

/**
 * A spring damped visual tilt of the chassis *object*, driven by the chassis body's own
 * acceleration. The physics body is never rotated by this - only the object that is being
 * synced as the chassis (`bodyObject`, or the generated box).
 *
 * Because the manager owns that object's local rotation while this is on, rotate your model
 * inside a wrapper (or set `bodyRoll: false`) if you need to orient it yourself.
 */
export interface BodyRollSettings {
    /** the most the body may lean sideways, in radians (default 0.1, about 5.7 degrees) */
    maxAngle?: number;
    /** the most the body may pitch under acceleration and braking (default `maxAngle / 2`) */
    maxPitchAngle?: number;
    /**
     * The acceleration, in m/s², that produces the full `maxAngle`. Lower it for a floatier
     * body, raise it for a stiff one. Default 9.81, i.e. one g of lateral acceleration puts the
     * body at `maxAngle`.
     */
    referenceAcceleration?: number;
    /** spring constant pulling the tilt towards its target (default 120) */
    stiffness?: number;
    /** damping of that spring; about `2 * sqrt(stiffness)` is critical (default 20) */
    damping?: number;
}

/**
 * Easing applied to what the wheels *render*, so a wheel does not snap between two suspension
 * lengths (or two steering angles) the solver happens to land on. The wheel's spin is jolt's
 * own, integrated from its angular velocity, and is never eased.
 */
export interface WheelSmoothingSettings {
    /**
     * Time constant, in seconds, for the rendered suspension travel: the rendered position
     * covers ~63% of the distance to jolt's every `suspension` seconds. 0 renders it raw.
     * Default 0.04.
     */
    suspension?: number;
    /** the same, for the rendered steering angle. 0 renders it raw. Default 0.05. */
    steering?: number;
}

/**
 * When a wheel counts as skidding. The thresholds are compared against jolt's own per wheel
 * slip, and are deliberately generous: `slipRatio` of 3 (the wheel spinning at four times the
 * speed of the ground under it) is an ordinary standing start in a 500 Nm car.
 */
export interface SkidSettings {
    /** the |slipRatio| a wheel has to exceed to be skidding (default 1.5) */
    longitudinalSlip?: number;
    /** the |lateralSlip| a wheel has to exceed, in radians (default 0.25, about 14 degrees) */
    lateralSlip?: number;
    /**
     * How fast the vehicle has to be going, in m/s, before *lateral* slip counts (default 0.5).
     *
     * Jolt's lateral slip is `atan2(lateral velocity, |longitudinal velocity|)`, so a vehicle
     * that has come to a stop reports whatever the solver's residual noise divides out to - a
     * right angle, as often as not. Without this floor a parked car skids forever.
     */
    minLateralSpeed?: number;
    /** the fraction of those thresholds a skidding wheel has to fall back under (default 0.7) */
    release?: number;
    /** seconds a wheel has to stay under the release threshold before `skidEnd` (default 0.12) */
    releaseTime?: number;
    /** wheels that are not touching anything never skid (default true) */
    requireContact?: boolean;
}

export type ResolvedBodyRollSettings = Required<BodyRollSettings>;
export type ResolvedWheelSmoothingSettings = Required<WheelSmoothingSettings>;
export type ResolvedSkidSettings = Required<SkidSettings>;

export const defaultBodyRollSettings: ResolvedBodyRollSettings = {
    maxAngle: 0.1,
    maxPitchAngle: 0.05,
    referenceAcceleration: 9.81,
    stiffness: 120,
    damping: 20
};

export const defaultWheelSmoothingSettings: ResolvedWheelSmoothingSettings = {
    suspension: 0.04,
    steering: 0.05
};

export const defaultSkidSettings: ResolvedSkidSettings = {
    longitudinalSlip: 1.5,
    lateralSlip: 0.25,
    minLateralSpeed: 0.5,
    release: 0.7,
    releaseTime: 0.12,
    requireContact: true
};

/** `false` turns the feature off; `undefined` means "the defaults", so all three are on. */
export function resolveBodyRoll(
    settings?: BodyRollSettings | false
): ResolvedBodyRollSettings | undefined {
    if (settings === false) return undefined;
    const merged = { ...defaultBodyRollSettings, ...settings };
    // the pitch default follows maxAngle rather than the constant above
    if (settings?.maxPitchAngle === undefined) merged.maxPitchAngle = merged.maxAngle / 2;
    return merged;
}

export function resolveWheelSmoothing(
    settings?: WheelSmoothingSettings | false
): ResolvedWheelSmoothingSettings | undefined {
    if (settings === false) return undefined;
    return { ...defaultWheelSmoothingSettings, ...settings };
}

export function resolveSkid(settings?: SkidSettings | false): ResolvedSkidSettings | undefined {
    if (settings === false) return undefined;
    return { ...defaultSkidSettings, ...settings };
}

/** Everything both vehicle types understand. */
export interface VehicleSettingsBase {
    type?: VehicleType;
    /** world space position the chassis body is created at */
    bodyPosition?: Vector;
    castType?: WheelCastType;

    vehicleLength?: number;
    vehicleWidth?: number;
    vehicleHeight?: number;
    vehicleMass?: number;
    /** radians; the constraint gives up on the vehicle past this angle */
    maxPitchRollAngle?: number;

    maxEngineTorque?: number;
    clutchStrength?: number;
    previousForward?: number;

    /**
     * Issue #26: the chassis object the manager should sync instead of generating a box (a GLTF
     * scene, for instance). The manager never disposes an object it did not create.
     */
    bodyObject?: THREE.Object3D | null;
    /**
     * Issue #27: wheel objects in constraint order (fl, fr, bl, br / front, back). An entry may
     * also be supplied per wheel through `wheels.<corner>.object`.
     */
    wheelObjects?: (THREE.Object3D | null | undefined)[];

    //* secondary physics (issue #41) ---------------------------------------------------------
    /** the visual body roll and pitch of the chassis object. `false` turns it off. */
    bodyRoll?: BodyRollSettings | false;
    /** easing of the rendered suspension travel and steering angle. `false` turns it off. */
    wheelSmoothing?: WheelSmoothingSettings | false;
    /** when a wheel counts as skidding, and so when `skidStart`/`skidEnd` fire. */
    skid?: SkidSettings | false;
}

export interface FourWheelVehicleSettings extends VehicleSettingsBase {
    type?: 'fourWheel';
    fourWheelDrive?: boolean;
    frontBackLimitedSlipRatio?: number;
    leftRightLimitedSlipRatio?: number;
    antiRollbar?: boolean;
    /** how the engine torque is split when `fourWheelDrive` is on */
    splitEngineTorqueFront?: number;
    splitEngineTorqueRear?: number;
    frontRollBarStiffness?: number;
    rearRollBarStiffness?: number;
    wheels?: FourWheelWheelSettings;
}

export interface TwoWheelVehicleSettings extends VehicleSettingsBase {
    type?: 'twoWheel';
    /** radians per second the steering angle is allowed to change by */
    steerSpeed?: number;
    /** radians; the tilt of the front fork */
    casterAngle?: number;
    wheels?: TwoWheelWheelSettings;
}

/** A tank: two tracks driven by jolt's `TrackedVehicleController`, steered by skidding. */
export interface TrackedVehicleSettings extends VehicleSettingsBase {
    type?: 'tracked';
    maxEngineTorque?: number;
    clutchStrength?: number;
    left?: TrackSettings;
    right?: TrackSettings;
    wheels?: TrackedVehicleWheelSettings;
}

/** Anything `<Vehicle vehicleSettings={...}>` / `useVehicle({ settings })` accepts. */
export type VehicleSettings =
    FourWheelVehicleSettings | TwoWheelVehicleSettings | TrackedVehicleSettings;

/** @deprecated renamed to `FourWheelVehicleSettings` (issue #10) */
export type VehicleFourWheelSettings = FourWheelVehicleSettings;
/** @deprecated renamed to `TwoWheelVehicleSettings` (issue #10) */
export type VehicleTwoWheelSettings = TwoWheelVehicleSettings;

//* Defaults ==================================================================================

/**
 * The settings a manager actually runs on: the user's settings merged over the defaults, so every
 * value the managers read is present. This is what removes the `!` from `settings.vehicleWidth!`.
 */
type AlwaysResolved = 'type' | 'bodyPosition' | 'castType' | 'vehicleLength' | 'vehicleWidth';
export type ResolvedFourWheelVehicleSettings = FourWheelVehicleSettings &
    Required<
        Pick<
            FourWheelVehicleSettings,
            | AlwaysResolved
            | 'vehicleHeight'
            | 'vehicleMass'
            | 'maxPitchRollAngle'
            | 'maxEngineTorque'
            | 'clutchStrength'
            | 'fourWheelDrive'
            | 'frontBackLimitedSlipRatio'
            | 'leftRightLimitedSlipRatio'
            | 'antiRollbar'
            | 'wheels'
        >
    >;
export type ResolvedTwoWheelVehicleSettings = TwoWheelVehicleSettings &
    Required<
        Pick<
            TwoWheelVehicleSettings,
            | AlwaysResolved
            | 'vehicleHeight'
            | 'vehicleMass'
            | 'maxPitchRollAngle'
            | 'steerSpeed'
            | 'casterAngle'
            | 'wheels'
        >
    >;
export type ResolvedTrackedVehicleSettings = TrackedVehicleSettings &
    Required<
        Pick<
            TrackedVehicleSettings,
            | AlwaysResolved
            | 'vehicleHeight'
            | 'vehicleMass'
            | 'maxPitchRollAngle'
            | 'maxEngineTorque'
            | 'clutchStrength'
            | 'left'
            | 'right'
            | 'wheels'
        >
    >;
export type ResolvedVehicleSettings =
    | ResolvedFourWheelVehicleSettings
    | ResolvedTwoWheelVehicleSettings
    | ResolvedTrackedVehicleSettings;

export const defaultFourWheelVehicleSettings: ResolvedFourWheelVehicleSettings = {
    type: 'fourWheel',
    bodyPosition: [0, 4, 0],
    castType: 'cylinder',

    vehicleLength: 4.0,
    vehicleWidth: 1.8,
    vehicleHeight: 0.4,
    vehicleMass: 1500.0,
    maxPitchRollAngle: MathUtils.degToRad(60),

    fourWheelDrive: true,
    frontBackLimitedSlipRatio: 1.4,
    leftRightLimitedSlipRatio: 1.4,
    antiRollbar: true,

    maxEngineTorque: 500.0,
    clutchStrength: 10.0,

    splitEngineTorqueFront: 0.5,
    splitEngineTorqueRear: 0.5,

    wheels: {
        width: 0.3,
        radius: 0.5,
        wheelOffsetHorizontal: 1.4,
        wheelOffsetVertical: 0.18,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5,
        maxSteerAngle: MathUtils.degToRad(30),
        fl: { maxHandBrakeTorque: 0 },
        fr: { maxHandBrakeTorque: 0 },
        bl: { maxSteerAngle: 0 },
        br: { maxSteerAngle: 0 }
    }
};

export const defaultTwoWheelVehicleSettings: ResolvedTwoWheelVehicleSettings = {
    type: 'twoWheel',
    bodyPosition: [0, 4, 0],
    castType: 'cylinder',

    vehicleLength: 0.8,
    vehicleWidth: 0.4,
    vehicleHeight: 0.6,
    vehicleMass: 250,
    maxPitchRollAngle: MathUtils.degToRad(60),

    steerSpeed: 4,
    casterAngle: MathUtils.degToRad(30),

    wheels: {
        radius: 0.31,
        width: 0.05,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5,
        front: {
            suspensionFreq: 1.5,
            brakeTorque: 500.0,
            posZ: 0.75,
            maxSteerAngle: MathUtils.degToRad(30)
        },
        back: {
            suspensionFreq: 2.0,
            brakeTorque: 250.0,
            posZ: -0.75,
            maxSteerAngle: 0.0
        }
    }
};

export const defaultTrackedVehicleSettings: ResolvedTrackedVehicleSettings = {
    type: 'tracked',
    bodyPosition: [0, 4, 0],
    castType: 'cylinder',

    vehicleLength: 5.0,
    vehicleWidth: 2.6,
    vehicleHeight: 0.7,
    vehicleMass: 4000.0,
    maxPitchRollAngle: MathUtils.degToRad(60),

    maxEngineTorque: 2000.0,
    clutchStrength: 10.0,

    // jolt: `drivenWheel` indexes into the *track's own* `mWheels`, so 0 (the frontmost wheel of
    // each track) needs no knowledge of the other track's wheel count
    left: {
        drivenWheel: 0,
        inertia: 0.9,
        angularDamping: 0.5,
        maxBrakeTorque: 4000,
        differentialRatio: 6
    },
    right: {
        drivenWheel: 0,
        inertia: 0.9,
        angularDamping: 0.5,
        maxBrakeTorque: 4000,
        differentialRatio: 6
    },

    wheels: {
        count: 4,
        radius: 0.4,
        width: 0.4,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5,
        longitudinalFriction: 4,
        lateralFriction: 2.5
    }
};

/** the wheel names of each vehicle type, in constraint index order */
export const wheelOrderByType: Record<VehicleType, string[]> = {
    fourWheel: ['fl', 'fr', 'bl', 'br'],
    twoWheel: ['front', 'back'],
    // matches `defaultTrackedVehicleSettings.wheels.count` (4 per side); a vehicle built with a
    // different `wheels.count` has more (or fewer) wheels than this default table describes, so
    // `wheels`/`wheelObjects` positional injection only lines up 1:1 at the default count
    tracked: ['l0', 'l1', 'l2', 'l3', 'r0', 'r1', 'r2', 'r3']
};

const wheelOverrideKeys = ['fl', 'fr', 'bl', 'br', 'front', 'back'] as const;

/** shallow merge of the shared wheel settings plus a shallow merge of each per wheel override */
function mergeWheelSettings(
    defaults: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...defaults, ...overrides };
    for (const key of wheelOverrideKeys) {
        const base = defaults[key] as Record<string, unknown> | undefined;
        const override = overrides[key] as Record<string, unknown> | undefined;
        if (base || override) merged[key] = { ...base, ...override };
    }
    return merged;
}

/**
 * Merge user settings over the defaults for the requested type.
 *
 * The old `VehicleSystem.createVehicleSettings` merged the two wheeler defaults *over* the user's
 * settings, so anything a caller passed for a motorcycle (its mass, its wheels) was silently
 * thrown away.
 */
export function resolveVehicleSettings(settings: VehicleSettings = {}): ResolvedVehicleSettings {
    const type: VehicleType = settings.type ?? 'fourWheel';
    const asRecord = (value: unknown) => value as Record<string, unknown> | undefined;

    if (type === 'tracked') {
        const trackedSettings = settings as TrackedVehicleSettings;
        const defaults = defaultTrackedVehicleSettings;
        return {
            ...defaults,
            ...trackedSettings,
            type,
            wheels: mergeWheelSettings(asRecord(defaults.wheels), asRecord(trackedSettings.wheels)),
            left: { ...defaults.left, ...trackedSettings.left },
            right: { ...defaults.right, ...trackedSettings.right }
        } as unknown as ResolvedTrackedVehicleSettings;
    }

    const defaults =
        type === 'twoWheel' ? defaultTwoWheelVehicleSettings : defaultFourWheelVehicleSettings;
    return {
        ...defaults,
        ...settings,
        type,
        wheels: mergeWheelSettings(asRecord(defaults.wheels), asRecord(settings.wheels))
    } as unknown as ResolvedVehicleSettings;
}
