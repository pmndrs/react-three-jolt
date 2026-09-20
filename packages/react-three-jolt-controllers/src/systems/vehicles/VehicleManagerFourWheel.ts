/*
import * as THREE from 'three';
import type Jolt from 'jolt-physics';
import { Raw } from '../../raw';
import { vec3, quat } from '../../utils';
*/
import { PhysicsSystem } from '@react-three/jolt';
import { VehicleManager } from './VehicleManager';
import {
    VehicleFourWheelSettings
    // WheelState,
    //createWheelSettings
} from './wheels';
/*
const FL_WHEEL = 0;
const FR_WHEEL = 1;
const BL_WHEEL = 2;
const BR_WHEEL = 3;
*/
export class VehicleFourWheelManager extends VehicleManager {
    constructor(physicsSystem: PhysicsSystem, settings: VehicleFourWheelSettings) {
        super(physicsSystem, settings);
    }
}
