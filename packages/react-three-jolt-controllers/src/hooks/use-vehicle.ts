import { useThree } from '@react-three/fiber';
import { useConst, useJolt } from '@react-three/jolt';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { VehicleManager } from '../systems/vehicles/vehicle-manager';
import type {
    Vector,
    VehicleSettings,
    VehicleType,
    WheelSettings
} from '../systems/vehicles/vehicle-settings';
import { wheelOrderByType } from '../systems/vehicles/vehicle-settings';
import { VehicleSystem } from '../systems/vehicles/vehicle-system';

/**
 * Anything that can stand in for a three object in props: the object itself, or a ref to it (so
 * `<Vehicle bodyObject={gltfRef}>` works with an object that only exists after the first render).
 */
export type Object3DSource = THREE.Object3D | RefObject<THREE.Object3D | null> | null | undefined;

/** Resolve an `Object3DSource` to the object, or null when there isn't one (yet). */
export function resolveObject3D(source: Object3DSource): THREE.Object3D | null {
    if (!source) return null;
    if ((source as THREE.Object3D).isObject3D) return source as THREE.Object3D;
    return (source as RefObject<THREE.Object3D | null>).current ?? null;
}

/** One wheel of a vehicle, including the object the manager should sync for it (issue #27). */
export interface VehicleWheelOptions extends Omit<WheelSettings, 'object'> {
    maxSteerAngle?: number;
    maxBrakeTorque?: number;
    maxHandBrakeTorque?: number;
    /** the user's wheel object. The manager syncs it and never disposes it. */
    object?: Object3DSource;
}

export interface UseVehicleOptions {
    /** the key the vehicle is registered under; defaults to 'car' / 'bike' */
    name?: string;
    type?: VehicleType;
    /** the typed physics settings: constraint, controller, suspension, differentials */
    settings?: VehicleSettings;
    /** where the chassis body is created (and moved to when it changes) */
    position?: THREE.Vector3 | Vector;
    /** issue #26: the caller's chassis object, synced instead of the generated box */
    bodyObject?: Object3DSource;
    /** issue #27: per wheel settings, in constraint order, each with an optional object */
    wheels?: VehicleWheelOptions[];
    /** issue #27: just the wheel objects, in constraint order */
    wheelObjects?: Object3DSource[];
    /** show the generated stand-in meshes (default true) */
    debug?: boolean;
    /** add the vehicle's three object to the scene (default true) */
    addToScene?: boolean;
}

const defaultNames: Record<VehicleType, string> = { fourWheel: 'car', twoWheel: 'bike' };

const readPosition = (position?: THREE.Vector3 | Vector): Vector | undefined => {
    if (!position) return undefined;
    if (Array.isArray(position)) return [position[0], position[1], position[2]];
    return [position.x, position.y, position.z];
};

/**
 * Fold the hook's options into the settings object a manager is constructed from: the per wheel
 * settings are merged into `settings.wheels.<corner>` and every object source is resolved, so a
 * vehicle is built with the caller's chassis and wheels in place rather than generating meshes
 * only to throw them away.
 */
export function buildVehicleSettings(
    type: VehicleType,
    options: UseVehicleOptions
): VehicleSettings {
    // built as a record so the per corner merge doesn't have to satisfy the discriminated union
    const settings: Record<string, unknown> = { ...(options.settings ?? {}), type };
    const position = readPosition(options.position);
    if (position) settings.bodyPosition = position;

    const order = wheelOrderByType[type];
    if (options.wheels?.length) {
        const wheels: Record<string, unknown> = { ...(settings.wheels as object | undefined) };
        options.wheels.forEach((wheel, index) => {
            const corner = order[index];
            if (!corner) return;
            const { object, ...rest } = wheel;
            wheels[corner] = {
                ...(wheels[corner] as object | undefined),
                ...rest,
                object: resolveObject3D(object)
            };
        });
        settings.wheels = wheels;
    }
    if (options.wheelObjects?.length) {
        settings.wheelObjects = options.wheelObjects.map(resolveObject3D);
    }
    const bodyObject = resolveObject3D(options.bodyObject);
    if (bodyObject) settings.bodyObject = bodyObject;
    return settings as VehicleSettings;
}

/**
 * Create a vehicle and get its manager back for imperative use (issue #10).
 *
 * ```tsx
 * const vehicle = useVehicle({ type: 'fourWheel', position: [0, 25, 0] });
 * useEffect(() => vehicle?.onPostStep(() => console.log(vehicle.position)), [vehicle]);
 * ```
 *
 * The manager is created after mount, so the hook returns `null` on the first render. The
 * vehicle, its `VehicleSystem` and everything they own are destroyed when the component unmounts.
 * Settings are read when the vehicle is built: change `name` or `type` to rebuild it, and use the
 * manager's own setters (`setPosition`, `setBodyObject`, `setWheelObject`) for live changes.
 */
export function useVehicle(options: UseVehicleOptions = {}): VehicleManager | null {
    const { physicsSystem } = useJolt();
    const scene = useThree((state) => state.scene);
    const vehicleSystem = useConst(() => new VehicleSystem(physicsSystem));
    const [vehicle, setVehicle] = useState<VehicleManager | null>(null);

    // the options are read when the vehicle is created, not on every render
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const type: VehicleType = options.type ?? 'fourWheel';
    const name = options.name ?? defaultNames[type];
    const addToScene = options.addToScene ?? true;

    useEffect(() => {
        const current = optionsRef.current;
        const created = vehicleSystem.addVehicle(name, buildVehicleSettings(type, current));
        if (current.debug !== undefined) created.debug = current.debug;
        if (addToScene) scene.add(created.threeObject);
        setVehicle(created);
        // the vehicle owns a VehicleConstraint, its step listener, the callbacks jolt calls into
        // and the chassis body; none of it used to be released (issue #140)
        return () => {
            vehicleSystem.removeVehicle(name);
            setVehicle(null);
        };
    }, [vehicleSystem, scene, name, type, addToScene]);

    // the whole system (and with it its own step listeners) goes when the component does
    useEffect(() => () => vehicleSystem.destroy(), [vehicleSystem]);

    return vehicle;
}
