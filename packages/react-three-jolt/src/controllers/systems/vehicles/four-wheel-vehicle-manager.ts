import type Jolt from 'jolt-physics';
import type { PhysicsSystem } from '../../../index';
import { VehicleManager } from './vehicle-manager';
import type {
    FourWheelVehicleSettings,
    ResolvedFourWheelVehicleSettings
} from './vehicle-settings';

/**
 * A car: four wheels driven by jolt's `WheeledVehicleController`. Everything it does lives in
 * `VehicleManager`, which builds a four wheeled vehicle by default.
 */
export class FourWheelVehicleManager extends VehicleManager {
    declare settings: ResolvedFourWheelVehicleSettings;
    declare controller: Jolt.WheeledVehicleController;

    constructor(physicsSystem: PhysicsSystem, settings: FourWheelVehicleSettings = {}) {
        super(physicsSystem, { ...settings, type: 'fourWheel' });
    }
}

/** @deprecated renamed to `FourWheelVehicleManager` (issue #10) */
export const VehicleFourWheelManager = FourWheelVehicleManager;
/** @deprecated renamed to `FourWheelVehicleManager` (issue #10) */
export type VehicleFourWheelManager = FourWheelVehicleManager;
