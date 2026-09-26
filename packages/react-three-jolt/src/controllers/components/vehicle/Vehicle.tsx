import { useThree } from '@react-three/fiber';
// React stays a *value* import: this package compiles JSX with the classic runtime, so the
// emitted `React.createElement` calls need it at runtime (an autofixer for eslint's
// @typescript-eslint/consistent-type-imports would offer to make it `import type` - don't).
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { isCommandVector, useCommand } from '../../../addons/index';
import { useConst } from '../../../index';
import type { Object3DSource, UseVehicleOptions, VehicleWheelOptions } from '../../hooks';
import { resolveObject3D, useVehicle } from '../../hooks';
import type {
    BodyRollSettings,
    SkidSettings,
    Vector,
    VehicleEngineListener,
    VehicleManager,
    VehicleSettings,
    VehicleSkidListener,
    VehicleType,
    WheelSmoothingSettings
} from '../../systems/vehicles/';

export type VehicleProps = {
    children?: React.ReactNode;
    /** 'fourWheel' (a car, the default) or 'twoWheel' (a motorcycle) */
    type?: VehicleType;
    /** the key the vehicle is registered under in its `VehicleSystem` */
    name?: string;
    position?: THREE.Vector3 | Vector;
    /**
     * The typed physics settings: chassis size and mass, cast type, engine, suspension,
     * differentials and anti roll bars. Merged over the defaults for the vehicle type.
     */
    vehicleSettings?: VehicleSettings;
    /**
     * Issue #26: your own chassis object (a GLTF scene, say). The manager syncs it instead of the
     * generated box and never disposes it. A ref is resolved after mount.
     */
    bodyObject?: Object3DSource;
    /**
     * Issue #27: per wheel settings in constraint order (fl, fr, bl, br / front, back), each with
     * an optional `object` the manager syncs (position *and* rotation, steering included).
     */
    wheels?: VehicleWheelOptions[];
    /** Issue #27: just the wheel objects, in constraint order. */
    wheelObjects?: Object3DSource[];
    /**
     * Treat the children as the chassis (the default when children are given and no `bodyObject`
     * is). The children's group is parented to the vehicle, so it follows the chassis body.
     */
    childrenAsChassis?: boolean;
    /** show the generated stand-in meshes (default true) */
    debug?: boolean;
    /** move the camera with the vehicle, as `<VehicleFourWheel>` always did (default true) */
    followCamera?: boolean;
    /** called with the manager whenever it is created, and with null when it goes away */
    onVehicle?: (vehicle: VehicleManager | null) => void;

    //* Secondary physics (issue #41) ---------------------------------------------------------
    /**
     * The chassis object's spring damped visual lean under acceleration. The physics body is
     * never tilted by this. `false` turns it off and hands the object's rotation back to you.
     * Changing the object live re-tunes the spring without rebuilding the vehicle.
     */
    bodyRoll?: BodyRollSettings | false;
    /** Easing of the rendered suspension travel and steering angle. `false` renders them raw. */
    wheelSmoothing?: WheelSmoothingSettings | false;
    /** When a wheel counts as skidding, and so when `onSkidStart`/`onSkidEnd` fire. */
    skid?: SkidSettings | false;
    /** a wheel started sliding - hook up tyre smoke, a skid mark, a screech */
    onSkidStart?: VehicleSkidListener;
    /** that wheel has had grip again for `skid.releaseTime` seconds */
    onSkidEnd?: VehicleSkidListener;
    /** the engine readout, once per physics step, for audio and instruments */
    onEngine?: VehicleEngineListener;
};

/**
 * One component for every kind of vehicle (issue #10). `<VehicleFourWheel>` is kept as a
 * deprecated alias for one release.
 *
 * ```tsx
 * <Vehicle type="fourWheel" position={[0, 25, 0]} vehicleSettings={{ vehicleMass: 900 }}>
 *     <primitive object={chassisGltf.scene} />
 * </Vehicle>
 * ```
 */
export function Vehicle(props: VehicleProps) {
    const {
        type = 'fourWheel',
        name,
        position,
        vehicleSettings,
        bodyObject,
        wheels,
        wheelObjects,
        childrenAsChassis,
        debug,
        followCamera = true,
        onVehicle,
        bodyRoll,
        wheelSmoothing,
        skid,
        onSkidStart,
        onSkidEnd,
        onEngine,
        children
    } = props;

    const { camera, controls } = useThree();
    const oldPosition = useConst(new THREE.Vector3());
    // the children are rendered into this group; it doubles as the chassis object when the
    // caller puts their model inside <Vehicle> rather than passing `bodyObject`
    const childrenRef = useRef<THREE.Group>(null);
    const useChildren = childrenAsChassis ?? (!bodyObject && !!children);

    const options: UseVehicleOptions = {
        name,
        type,
        position,
        settings: vehicleSettings,
        bodyObject: bodyObject ?? (useChildren ? childrenRef : undefined),
        wheels,
        wheelObjects,
        debug,
        bodyRoll,
        wheelSmoothing,
        skid
    };
    const vehicle = useVehicle(options);

    // the event props are read through a ref so a fresh inline arrow every render does not
    // resubscribe the manager's emitter on every render (issue #41 / #187)
    const handlers = useRef({ onSkidStart, onSkidEnd, onEngine });
    handlers.current = { onSkidStart, onSkidEnd, onEngine };

    // hand the manager to the caller (and take it back on teardown)
    useEffect(() => {
        onVehicle?.(vehicle);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- onVehicle is a callback prop
    }, [vehicle]);

    //* Props triggering the class ========================
    // the chassis object can be swapped at any time; null puts the generated box back
    useEffect(() => {
        if (!vehicle) return;
        const object = resolveObject3D(bodyObject ?? (useChildren ? childrenRef : undefined));
        vehicle.setBodyObject(object);
    }, [vehicle, bodyObject, useChildren]);

    // the same for the wheels: whatever is resolvable now is injected (issue #27)
    useEffect(() => {
        if (!vehicle) return;
        const objects = wheels
            ? wheels.map((wheel) => resolveObject3D(wheel.object))
            : wheelObjects?.map(resolveObject3D);
        if (objects) vehicle.setWheelObjects(objects);
    }, [vehicle, wheels, wheelObjects]);

    useEffect(() => {
        if (!vehicle || debug === undefined) return;
        vehicle.debug = debug;
    }, [vehicle, debug]);

    //* Secondary physics (issue #41) =====================================================
    // all three are live: a debug panel can re-tune the roll spring, the wheel easing and the
    // skid thresholds without rebuilding the vehicle
    const roll = bodyRoll === false ? false : bodyRoll;
    useEffect(() => {
        if (!vehicle || roll === undefined) return;
        vehicle.setBodyRoll(roll);
    }, [vehicle, roll]);
    useEffect(() => {
        if (!vehicle || wheelSmoothing === undefined) return;
        vehicle.setWheelSmoothing(wheelSmoothing);
    }, [vehicle, wheelSmoothing]);
    useEffect(() => {
        if (!vehicle || skid === undefined) return;
        vehicle.setSkid(skid);
    }, [vehicle, skid]);

    // one subscription per event for the vehicle's lifetime; the ref above keeps the latest prop
    useEffect(() => {
        if (!vehicle) return;
        const offs = [
            vehicle.onSkidStart((event) => handlers.current.onSkidStart?.(event)),
            vehicle.onSkidEnd((event) => handlers.current.onSkidEnd?.(event)),
            vehicle.onEngine((state) => handlers.current.onEngine?.(state))
        ];
        return () => {
            for (const off of offs) off();
        };
    }, [vehicle]);

    // trigger position change
    const [px, py, pz] = Array.isArray(position)
        ? position
        : [position?.x, position?.y, position?.z];
    useEffect(() => {
        if (!vehicle || px === undefined || py === undefined || pz === undefined) return;
        vehicle.setPosition([px, py, pz]);
    }, [vehicle, px, py, pz]);

    //* Camera ============================================
    useEffect(() => {
        if (!vehicle || !followCamera) return;
        // move the camera on update
        camera.position.set(-4, 4, 0);
        camera.lookAt(vehicle.position);
        oldPosition.copy(vehicle.position);
        // onPreStep returns its own remover - dropping it left the listener (and the closure over
        // `controls`) attached for the lifetime of the vehicle
        return vehicle.onPreStep(() => {
            const bodyPosition = vehicle.position;
            // r3f types `controls` as `unknown`; orbit/camera controls all expose a `target`
            const orbitControls = controls as { target?: THREE.Vector3 } | null | undefined;
            if (orbitControls) {
                orbitControls.target = bodyPosition.clone();
            }
            camera.position.add(bodyPosition.clone().sub(oldPosition));
            oldPosition.copy(bodyPosition);
        });
    }, [vehicle, controls, camera, followCamera, oldPosition]);

    //* Input =============================================
    useCommand(
        'move',
        (info) => {
            // bound with `{ asVector: true }`, so the value is the two axis kind
            if (!isCommandVector(info.value)) return;
            vehicle?.move(new THREE.Vector3(info.value.x, info.value.y, 0));
        },
        () => {
            vehicle?.move(new THREE.Vector3(0, 0, 0));
        },
        { asVector: true, inverted: { y: true } }
    );

    return <group ref={childrenRef}>{children}</group>;
}
