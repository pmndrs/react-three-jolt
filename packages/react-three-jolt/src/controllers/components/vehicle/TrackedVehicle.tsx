import React from 'react';
import { Vehicle, type VehicleProps } from './Vehicle';

/** `<TrackedVehicle>` takes every prop `<Vehicle>` does, minus `type` (fixed to `'tracked'`). */
export type TrackedVehicleProps = Omit<VehicleProps, 'type'>;

/**
 * A tank: `<Vehicle type="tracked">` under a name of its own (issue #246). Children become the
 * chassis exactly as they do for `<Vehicle>`, and wheel refs (`wheels`/`wheelObjects`) are synced
 * in constraint order - left track front-to-back, then right track front-to-back
 * (`wheelOrderByType.tracked`, `['l0', 'l1', 'l2', 'l3', 'r0', 'r1', 'r2', 'r3']` at the default
 * wheel count).
 *
 * ```tsx
 * <TrackedVehicle position={[0, 4, 0]} vehicleSettings={{ vehicleMass: 6000 }}>
 *     <primitive object={hullGltf.scene} />
 * </TrackedVehicle>
 * ```
 */
export function TrackedVehicle(props: TrackedVehicleProps) {
    return <Vehicle {...props} type="tracked" />;
}
