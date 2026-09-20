import type { PhysicsSystem } from '@react-three/jolt';
import type * as THREE from 'three';
import { FourWheelVehicleManager } from './four-wheel-vehicle-manager';
import { TwoWheelVehicleManager } from './two-wheel-vehicle-manager';
import type { VehicleManager } from './vehicle-manager';
import {
    defaultFourWheelVehicleSettings,
    defaultTwoWheelVehicleSettings,
    type ResolvedVehicleSettings,
    resolveVehicleSettings,
    type VehicleSettings
} from './vehicle-settings';

/**
 * Owns the vehicles of one scene and steps them with the physics loop. One system can hold any
 * number of vehicles, of either type, addressed by name.
 */
export class VehicleSystem {
    private physicsSystem: PhysicsSystem;

    /** the defaults a four wheeled vehicle is built from (see `vehicle-settings.ts`) */
    defaultVehicleSettings = defaultFourWheelVehicleSettings;
    /** the defaults a two wheeled vehicle is built from */
    defaultVehicleSettingsTwoWheels = defaultTwoWheelVehicleSettings;

    vehicles = new Map<string, VehicleManager>();

    private destroyed = false;

    // The functions handed to the physics system. Subscribing now returns an unsubscribe
    // (issue #187) rather than matching by identity, but these stay hoisted so `attachToLoop`
    // does not build a fresh closure on every reattach (issue #140).
    private readonly handlePreStep = (deltaTime: number) => this.prePhysicsUpdate(deltaTime);
    private readonly handlePostStep = (deltaTime: number) => this.postPhysicsUpdate(deltaTime);

    constructor(physicSystem: PhysicsSystem) {
        this.physicsSystem = physicSystem;
        this.attachToLoop();
        // so a world that is torn down takes every vehicle with it (issue #162)
        this.unregisterFromWorld = physicSystem.registerDisposable(this);
    }

    /** Drops this system from the physics system's disposables. Replaced in the constructor. */
    private unregisterFromWorld: () => void = () => {};

    /**
     * Detach from the loop and destroy every vehicle this system created (issue #140).
     * Idempotent.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.unregisterFromWorld();
        this.detachFromLoop();
        this.vehicles.forEach((vehicle) => vehicle.destroy());
        this.vehicles.clear();
    }

    /** Destroy a single vehicle and forget it. Returns true when there was one to remove. */
    removeVehicle(name: string) {
        const vehicle = this.vehicles.get(name);
        if (!vehicle) return false;
        vehicle.destroy();
        this.vehicles.delete(name);
        return true;
    }

    /** merge the caller's settings over the defaults for the requested vehicle type */
    createVehicleSettings(settings?: VehicleSettings): ResolvedVehicleSettings {
        return resolveVehicleSettings(settings);
    }

    addVehicle(name: string, settings?: VehicleSettings): VehicleManager {
        const resolved = this.createVehicleSettings(settings);
        const vehicle =
            resolved.type === 'twoWheel'
                ? new TwoWheelVehicleManager(this.physicsSystem, resolved)
                : new FourWheelVehicleManager(this.physicsSystem, resolved);
        this.vehicles.set(name, vehicle);
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

    /** Unsubscribes for the two loop callbacks; inline arrows could never be removed before. */
    private loopUnsubscribes: (() => void)[] = [];

    private attachToLoop() {
        this.detachFromLoop();
        this.loopUnsubscribes = [
            this.physicsSystem.onBeforeStep(this.handlePreStep),
            this.physicsSystem.onAfterStep(this.handlePostStep)
        ];
    }

    /** Stop stepping the vehicles. Call before dropping the system. */
    detachFromLoop() {
        for (const off of this.loopUnsubscribes) off();
        this.loopUnsubscribes = [];
    }

    prePhysicsUpdate(deltaTime: number) {
        if (this.destroyed) return;
        this.vehicles.forEach((vehicle) => {
            vehicle.prePhysicsUpdate(deltaTime);
        });
    }
    postPhysicsUpdate(deltaTime: number) {
        if (this.destroyed) return;
        this.vehicles.forEach((vehicle) => {
            vehicle.postPhysicsUpdate(deltaTime);
        });
    }
}
