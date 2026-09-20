// The typed settings surface of the vehicle API (issue #10).
//
// Everything a vehicle can be configured with lives here: the jolt side (VehicleConstraintSettings,
// the controller, the suspension and the differentials) and our own layout helpers. The managers
// used to take `settings: any`, which meant none of this was discoverable and every typo was
// silently accepted.

import type * as THREE from 'three';
import { MathUtils } from 'three';

/** The vehicle flavours the library ships. `fourWheel` is the default. */
export type VehicleType = 'fourWheel' | 'twoWheel';

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

/** Anything `<Vehicle vehicleSettings={...}>` / `useVehicle({ settings })` accepts. */
export type VehicleSettings = FourWheelVehicleSettings | TwoWheelVehicleSettings;

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
export type ResolvedVehicleSettings =
    | ResolvedFourWheelVehicleSettings
    | ResolvedTwoWheelVehicleSettings;

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

/** the wheel names of each vehicle type, in constraint index order */
export const wheelOrderByType: Record<VehicleType, string[]> = {
    fourWheel: ['fl', 'fr', 'bl', 'br'],
    twoWheel: ['front', 'back']
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
    const defaults =
        type === 'twoWheel' ? defaultTwoWheelVehicleSettings : defaultFourWheelVehicleSettings;
    const asRecord = (value: unknown) => value as Record<string, unknown> | undefined;
    return {
        ...defaults,
        ...settings,
        type,
        wheels: mergeWheelSettings(asRecord(defaults.wheels), asRecord(settings.wheels))
    } as unknown as ResolvedVehicleSettings;
}
