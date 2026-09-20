// Issue #140: neither `VehicleManager` nor `VehicleSystem` had a `destroy()`. Every vehicle
// leaked its VehicleConstraintSettings, controller settings, differentials, anti roll bars, the
// collision tester, the car body and the wheels' scratch vectors; its VehicleConstraintStepListener
// was constructed anonymously (so it could never be removed) and the
// VehicleConstraintCallbacksJS was a local `const` whose only JavaScript reference was dropped
// while Jolt kept calling into it.

import { initJolt, PhysicsSystem, Raw } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { installAllocTracker } from '../../react-three-jolt/test/jolt-alloc';
import { VehicleSystem } from '../src/systems/vehicles';

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

// Vehicles are parked well apart on purpose: two chassis touching each other goes through
// `BodySystem`'s contact listener, which throws on a body that was not registered with it - and
// the car body is created straight off the body interface. That is a separate, pre-existing bug
// (see the audit's note on `VehicleManager.ts:91`), not something these tests are about.
function at(z: number) {
    return { bodyPosition: [0, 4, z] };
}

for (const type of ['fourWheel', 'twoWheel']) {
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
