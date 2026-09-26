// Issue #246: a tank, driven by jolt's TrackedVehicleController. `vehicle-destroy.test.ts`
// already covers construct -> step -> destroy leak freedom for `'tracked'` alongside the other
// two types; this file is about the parts that are specific to a tracked vehicle - that it
// actually drives forward on flat ground, and that its skid-steer mixing turns it.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { TrackedVehicleManager } from '../../src/controllers/systems/vehicles/tracked-vehicle-manager';
import { VehicleSystem } from '../../src/controllers/systems/vehicles/vehicle-system';
import { initJolt, PhysicsSystem } from '../../src/index';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('tracked-vehicle');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

function at(z: number): { bodyPosition: [number, number, number] } {
    return { bodyPosition: [0, 4, z] };
}

test('a tracked vehicle drives forward on flat ground', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('tank', {
        type: 'tracked',
        ...at(-100)
    }) as TrackedVehicleManager;
    assert.equal(vehicle.settings.type, 'tracked');
    assert.instanceOf(vehicle, TrackedVehicleManager);
    // left track first, then right - both at the default wheel count
    assert.equal(vehicle.wheels.size, 8);
    assert.deepEqual(vehicle.wheelOrder, ['l0', 'l1', 'l2', 'l3', 'r0', 'r1', 'r2', 'r3']);

    const startZ = vehicle.position.z;
    vehicle.move(new THREE.Vector2(0, 1));
    for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);

    assert.isFinite(vehicle.position.x);
    assert.isFinite(vehicle.position.z);
    assert.isAbove(vehicle.speed, 0, 'the tank never got moving');
    // driving "forward" (+y move input) should carry the chassis a meaningful distance off its
    // start point - not just spin the tracks in place
    assert.isAbove(
        Math.abs(vehicle.position.z - startZ),
        1,
        `the tank barely moved (z ${startZ} -> ${vehicle.position.z})`
    );

    system.destroy();
});

test('leftRatio/rightRatio skid steering turns the vehicle', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('tank', {
        type: 'tracked',
        ...at(100)
    }) as TrackedVehicleManager;

    // forward + hard right should speed the left track up and slow (or reverse) the right one,
    // yawing the chassis about its own up axis - unlike straight-ahead driving, which should not
    const startYaw = vehicle.carBody.GetRotation().GetY();
    vehicle.move(new THREE.Vector2(1, 1));
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    const endYaw = vehicle.carBody.GetRotation().GetY();
    assert.notEqual(startYaw, endYaw, 'turning input never rotated the chassis at all');

    system.destroy();
});
