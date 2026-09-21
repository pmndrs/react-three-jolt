import { devWarn } from '@react-three/jolt';
import React from 'react';
import { Vehicle, type VehicleProps } from './Vehicle';

/** @deprecated use `VehicleProps` (issue #10) */
export type VehicleFourWheelProps = VehicleProps;

let warned = false;

/**
 * @deprecated Renamed to `<Vehicle>` (issue #10). The old name keeps working for one release:
 * `<VehicleFourWheel />` is exactly `<Vehicle type="fourWheel" />`, and `<Vehicle type="twoWheel">`
 * replaces the `type` string this component used to take.
 */
export function VehicleFourWheel(props: VehicleFourWheelProps) {
    if (!warned) {
        warned = true;
        devWarn(
            'r3/jolt: <VehicleFourWheel> is deprecated, use <Vehicle type="fourWheel"> instead.'
        );
    }
    return <Vehicle {...props} />;
}
