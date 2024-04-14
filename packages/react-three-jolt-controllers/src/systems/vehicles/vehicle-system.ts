import * as THREE from 'three';
/*
import type Jolt from 'jolt-physics';
import { Raw } from '../../raw';
import { vec3, quat } from '../../utils';
*/
import { PhysicsSystem } from '@react-three/jolt';
// import { WheelSettings } from './wheels';
import { VehicleFourWheelManager } from './VehicleManagerFourWheel';
import { VehicleManagerTwoWheels } from './VehicleManagerTwoWheels';

export class VehicleSystem {
    private physicsSystem;

    // default car settings
    defaultVehicleSettings = {
        type: 'fourWheel',
        bodyPosition: [0, 4, 0],
        castType: 'cylinder',

        vehicleLength: 4.0,
        vehicleWidth: 1.8,
        vehicleHeight: 0.4,
        fourWheelDrive: true,
        frontBackLimitedSlipRatio: 1.4,
        leftRightLimitedSlipRatio: 1.4,
        antiRollbar: true,

        vehicleMass: 1500.0,
        maxEngineTorque: 500.0,
        clutchStrength: 10.0,

        //ds additional settings
        splitEngineTorqueFront: 0.5,
        splitEngineTorqueRear: 0.5,
        // wheel settings
        wheels: {
            width: 0.3,
            radius: 0.5,
            wheelOffsetHorizontal: 1.4,
            wheelOffsetVertical: 0.18,
            suspensionMinLength: 0.3,
            suspensionMaxLength: 0.5,
            maxSteerAngle: THREE.MathUtils.degToRad(30),
            fl: {
                maxHandBrakeTorque: 0
            },
            fr: {
                maxHandBrakeTorque: 0
            },
            bl: {
                maxSteerAngle: 0
            },
            br: {
                maxSteerAngle: 0
            }
        }
    };

    defaultVehicleSettingsTwoWheels = {
        type: 'twoWheel',
        steerSpeed: 4,
        casterAngle: THREE.MathUtils.degToRad(30),
        maxPitchRollAngle: THREE.MathUtils.degToRad(60),
        vehicleLength: 0.8,
        vehicleWidth: 0.4,
        vehicleHeight: 0.6,
        vehicleMass: 250,
        wheels: {
            radius: 0.31,
            width: 0.05,

            suspensionMinLength: 0.3,
            suspensionMaxLength: 0.5,
            front: {
                suspensionFreq: 1.5,
                brakeTorque: 500.0,
                posZ: 0.75,
                maxSteerAngle: THREE.MathUtils.degToRad(30)
            },
            back: {
                suspensionFreq: 2.0,
                brakeTorque: 250.0,
                posZ: -0.75,
                maxSteerAngle: 0.0
            }
        }
    };

    vehicles = new Map();

    constructor(physicSystem: PhysicsSystem) {
        this.physicsSystem = physicSystem;
        this.attachToLoop();
    }

    //creates a new settings object by taking the default and input
    createVehicleSettings(settings: any) {
        const base = { ...this.defaultVehicleSettings, ...settings };
        if (base.type === 'twoWheel') {
            return mergeSettings(base, this.defaultVehicleSettingsTwoWheels);
        }
        return base;
    }
    addVehicle(name: string, settings?: any) {
        settings = this.createVehicleSettings(settings);
        let vehicle;
        console.log('adding vehicle', name, settings.type);
        switch (settings.type) {
            case 'twoWheel':
                vehicle = new VehicleManagerTwoWheels(this.physicsSystem, settings);
                break;
            default:
                vehicle = new VehicleFourWheelManager(this.physicsSystem, settings);
                break;
        }
        this.vehicles.set(name, vehicle);
        console.log('vehicle added, current list:', this.vehicles);
        return vehicle;
    }

    //* Control vehicles by name ========================
    getVehicle(name: string) {
        return this.vehicles.get(name);
    }
    setPosition(name: string, position: THREE.Vector3) {
        const vehicle = this.getVehicle(name);
        if (!vehicle) return;
        vehicle.setPosition(position);
    }

    //* Physics Loop ====================================

    private attachToLoop() {
        this.physicsSystem.addPreStepListener((deltaTime: number) =>
            this.prePhysicsUpdate(deltaTime)
        );
        this.physicsSystem.addPostStepListener((deltaTime: number) =>
            this.postPhysicsUpdate(deltaTime)
        );
    }

    prePhysicsUpdate(deltaTime: number) {
        this.vehicles.forEach((vehicle) => {
            vehicle.prePhysicsUpdate(deltaTime);
        });
    }
    postPhysicsUpdate(deltaTime: number) {
        this.vehicles.forEach((vehicle) => {
            vehicle.postPhysicsUpdate(deltaTime);
        });
    }
}

//utils
// take two settings objects, clone them, and then merge them
function mergeSettings(defaultSettings: any, settings: any) {
    return { ...defaultSettings, ...settings };
}
