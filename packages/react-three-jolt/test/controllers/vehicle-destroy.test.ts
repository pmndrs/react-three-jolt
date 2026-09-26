// Issue #140: neither `VehicleManager` nor `VehicleSystem` had a `destroy()`. Every vehicle
// leaked its VehicleConstraintSettings, controller settings, differentials, anti roll bars, the
// collision tester, the car body and the wheels' scratch vectors; its VehicleConstraintStepListener
// was constructed anonymously (so it could never be removed) and the
// VehicleConstraintCallbacksJS was a local `const` whose only JavaScript reference was dropped
// while Jolt kept calling into it.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import type { VehicleManager } from '../../src/controllers/systems/vehicles';
import { VehicleSystem } from '../../src/controllers/systems/vehicles';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

// Every class the vehicle files construct with `new Raw.module.*` that is ours to free.
// Deliberately absent, because they are owned by something else and are never destroyed here:
//   - `WheelSettingsWV` / `WheeledVehicleControllerSettings` / `MotorcycleControllerSettings`
//     (Ref<> members of the VehicleConstraintSettings, freed with it)
//   - `VehicleCollisionTesterCast*` / `VehicleCollisionTesterRay` (RefConst member of the
//     constraint, freed when the constraint's last reference goes)
//   - `BoxShapeSettings` (RefConst member of the OffsetCenterOfMass settings)
//   - `VehicleConstraint` itself, which is reference counted rather than destroyed
const TRACKED_TYPES = [
    'OffsetCenterOfMassShapeSettings',
    'BodyCreationSettings',
    'VehicleConstraintSettings',
    'VehicleDifferentialSettings',
    'VehicleAntiRollBar',
    'VehicleConstraintStepListener',
    'VehicleConstraintCallbacksJS',
    'Vec3',
    'RVec3',
    'Quat'
];

let ps: PhysicsSystem;

// Step callbacks moved from the private `preStepListeners`/`postStepListeners` arrays onto the
// world Emitter (issue #187). `listenerCount` is the supported way to ask, and is still the
// whole point of these tests: that unsubscribing actually happened.
const stepListeners = (system: PhysicsSystem) =>
    system.events.listenerCount('beforeStep') + system.events.listenerCount('afterStep');

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('vehicle-destroy');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // build one of each up front so every lazily created singleton exists before counting
    const warmup = new VehicleSystem(ps);
    warmup.addVehicle('car', at(-40));
    warmup.addVehicle('bike', { type: 'twoWheel', ...at(40) });
    warmup.destroy();
});

//* three objects the *user* owns: the manager must sync them and never dispose them (#26/#27)
type UserParts = {
    chassis: THREE.Mesh;
    wheels: THREE.Mesh[];
    disposed: string[];
};

function userParts(): UserParts {
    const disposed: string[] = [];
    const make = (name: string) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
        mesh.name = name;
        mesh.geometry.dispose = () => disposed.push(`${name}:geometry`);
        (mesh.material as THREE.Material).dispose = () => disposed.push(`${name}:material`);
        return mesh;
    };
    return {
        chassis: make('chassis'),
        wheels: [0, 1, 2, 3].map((index) => make(`wheel-${index}`)),
        disposed
    };
}

/** the world position jolt says a wheel is at, straight off the constraint */
function wheelWorldPosition(vehicle: VehicleManager, index: number) {
    const right = new Raw.module.Vec3(0, 1, 0);
    const up = new Raw.module.Vec3(1, 0, 0);
    try {
        // GetWheelWorldTransform returns a static temporary by value - never destroy it
        const translation = vehicle.constraint
            .GetWheelWorldTransform(index, right, up)
            .GetTranslation();
        return new THREE.Vector3(translation.GetX(), translation.GetY(), translation.GetZ());
    } finally {
        Raw.module.destroy(right);
        Raw.module.destroy(up);
    }
}

// Vehicles are parked well apart on purpose: two chassis touching each other goes through
// `BodySystem`'s contact listener, which throws on a body that was not registered with it - and
// the car body is created straight off the body interface. That is a separate, pre-existing bug
// (see the audit's note on `VehicleManager.ts:91`), not something these tests are about.
function at(z: number): { bodyPosition: [number, number, number] } {
    return { bodyPosition: [0, 4, z] };
}

for (const type of ['fourWheel', 'twoWheel'] as const) {
    test(`${type}: construct -> step -> destroy leaves no live jolt objects behind`, () => {
        const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
        try {
            // warm-up round under the tracked module (installing it rebuilds joltScratch)
            const warmup = new VehicleSystem(ps);
            warmup.addVehicle('warmup', { type, ...at(-20) });
            ps.onUpdate(1 / 60);
            warmup.destroy();
            const before = alloc.live();

            const system = new VehicleSystem(ps);
            const vehicle = system.addVehicle('v', { type, ...at(20) });
            vehicle.move(new THREE.Vector2(0, 1));
            for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
            system.destroy();

            assert.equal(
                alloc.live(),
                before,
                `the vehicle leaked ${alloc.live() - before} objects: ` +
                    JSON.stringify(alloc.liveByType())
            );
            assert.equal(alloc.foreignDestroys(), 0, 'the vehicle freed something it does not own');
        } finally {
            alloc.uninstall();
        }
    });
}

test('destroy() removes the car body from the simulation', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));
    const bodyID = vehicle.carBody.GetID();
    assert.isTrue(ps.bodyInterface.IsAdded(bodyID), 'the car body was never added');

    system.destroy();
    assert.isFalse(ps.bodyInterface.IsAdded(bodyID), 'the car body outlived the vehicle');
});

test('destroy() is idempotent for both the system and the vehicle', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));
    for (let i = 0; i < 3; i++) ps.onUpdate(1 / 60);

    vehicle.destroy();
    assert.doesNotThrow(() => vehicle.destroy());
    assert.doesNotThrow(() => system.destroy());
    assert.doesNotThrow(() => system.destroy());
});

test('destroy() removes the step listeners so stepping is a no-op afterwards', () => {
    const before = stepListeners(ps);
    const system = new VehicleSystem(ps);
    assert.equal(stepListeners(ps), before + 2, 'the system did not register its two listeners');

    const vehicle = system.addVehicle('car', at(0));
    let calls = 0;
    const realPreStep = vehicle.prePhysicsUpdate.bind(vehicle);
    vehicle.prePhysicsUpdate = (deltaTime: number) => {
        calls++;
        realPreStep(deltaTime);
    };
    ps.onUpdate(1 / 60);
    assert.isAbove(calls, 0, 'the listener never ran while the vehicle was alive');

    system.destroy();
    assert.equal(stepListeners(ps), before, 'the step listeners outlived the system');

    const callsAtDestroy = calls;
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.equal(calls, callsAtDestroy, 'a destroyed vehicle is still being stepped');
});

test('a vehicle still drives, and removeVehicle only takes the one it names', () => {
    const system = new VehicleSystem(ps);
    const car = system.addVehicle('car', at(-40));
    const bike = system.addVehicle('bike', { type: 'twoWheel', ...at(40) });
    car.move(new THREE.Vector2(0, 1));
    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
    assert.isFinite(car.position.x);
    assert.isFinite(bike.position.y);

    assert.isTrue(system.removeVehicle('car'));
    assert.isFalse(system.removeVehicle('car'));
    assert.isUndefined(system.getVehicle('car'));
    assert.isDefined(system.getVehicle('bike'));
    // the remaining vehicle keeps stepping
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.isFinite(bike.position.y);

    system.destroy();
});

//* Issues #26 and #27: injected chassis and wheel objects ====================================

test('an injected chassis and wheels are synced, and nothing generated is left behind', () => {
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        // warm-up round under the tracked module (installing it rebuilds joltScratch)
        const warmParts = userParts();
        const warmup = new VehicleSystem(ps);
        warmup.addVehicle('warmup', {
            ...at(-20),
            bodyObject: warmParts.chassis,
            wheelObjects: warmParts.wheels
        });
        ps.onUpdate(1 / 60);
        warmup.destroy();
        const before = alloc.live();

        const parts = userParts();
        const system = new VehicleSystem(ps);
        const vehicle = system.addVehicle('v', {
            ...at(20),
            bodyObject: parts.chassis,
            wheelObjects: parts.wheels
        });

        // nothing was generated only to be thrown away
        assert.isUndefined(vehicle.debugObject, 'a chassis box was generated anyway');
        assert.equal(vehicle.bodyObject, parts.chassis);
        assert.equal(parts.chassis.parent, vehicle.threeObject);
        vehicle.wheels.forEach((wheel, name) => {
            assert.isUndefined(wheel.debugObject, `wheel ${name} generated a cylinder anyway`);
        });
        parts.wheels.forEach((wheel, index) => {
            assert.equal(vehicle.getWheelObject(index), wheel);
        });

        vehicle.move(new THREE.Vector2(0, 1));
        for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);

        // the wheel objects follow the constraint
        vehicle.threeObject.updateMatrixWorld(true);
        parts.wheels.forEach((wheel, index) => {
            const expected = wheelWorldPosition(vehicle, index);
            const actual = wheel.getWorldPosition(new THREE.Vector3());
            assert.isBelow(
                actual.distanceTo(expected),
                1e-3,
                `wheel ${index} is at ${actual.toArray()} but jolt says ${expected.toArray()}`
            );
        });
        assert.isBelow(
            parts.chassis.getWorldPosition(new THREE.Vector3()).distanceTo(vehicle.position),
            1e-6,
            'the chassis object does not follow the body'
        );

        system.destroy();

        assert.equal(
            alloc.live(),
            before,
            `the vehicle leaked ${alloc.live() - before} objects: ` +
                JSON.stringify(alloc.liveByType())
        );
        assert.equal(alloc.foreignDestroys(), 0, 'the vehicle freed something it does not own');
        assert.deepEqual(parts.disposed, [], 'the manager disposed objects it did not create');
        assert.isNull(parts.chassis.parent, 'the chassis was not handed back');
        parts.wheels.forEach((wheel, index) => {
            assert.isNull(wheel.parent, `wheel ${index} was not handed back`);
        });
    } finally {
        alloc.uninstall();
    }
});

test('objects can be injected (and taken back) after the vehicle was built', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));
    const parts = userParts();

    // the vehicle generated its own meshes ...
    const generatedChassis = vehicle.debugObject;
    const generatedWheel = vehicle.getWheel('fl')?.debugObject;
    assert.isDefined(generatedChassis);
    assert.isDefined(generatedWheel);
    const generatedDisposed: string[] = [];
    generatedChassis!.geometry.dispose = () => generatedDisposed.push('chassis');
    generatedWheel!.geometry.dispose = () => generatedDisposed.push('wheel');

    // ... and swaps them for the user's, disposing only what it made itself
    vehicle.setBodyObject(parts.chassis);
    vehicle.setWheelObject('fl', parts.wheels[0]);
    assert.deepEqual(generatedDisposed.sort(), ['chassis', 'wheel']);
    assert.isUndefined(vehicle.debugObject);
    assert.equal(vehicle.bodyObject, parts.chassis);
    assert.equal(vehicle.getWheelObject('fl'), parts.wheels[0]);

    for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);
    vehicle.threeObject.updateMatrixWorld(true);
    assert.isBelow(
        parts.wheels[0]
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(wheelWorldPosition(vehicle, 0)),
        1e-3
    );

    // passing null hands the object back and puts the generated mesh in its place
    vehicle.setBodyObject(null);
    vehicle.setWheelObject(0, null);
    assert.isNull(parts.chassis.parent);
    assert.isNull(parts.wheels[0].parent);
    assert.isDefined(vehicle.debugObject);
    assert.isDefined(vehicle.getWheel(0)?.debugObject);
    assert.deepEqual(parts.disposed, []);

    system.destroy();
});
