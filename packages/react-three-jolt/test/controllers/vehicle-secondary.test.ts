// Issue #41: the "secondary physics" layer - everything a vehicle needs to *look* and *sound*
// right that the constraint itself does not do. Body roll on the chassis object, easing of the
// rendered suspension travel and steering angle, per wheel slip and skid events, and the
// engine readout audio is driven from.
//
// None of it may touch the simulation and none of it may allocate per frame, which is what the
// allocation test at the bottom is for.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import type {
    VehicleEngineState,
    VehicleManager,
    VehicleSkidEvent
} from '../../src/controllers/systems/vehicles';
import { VehicleSystem } from '../../src/controllers/systems/vehicles';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('vehicle-secondary');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(600, 1, 600));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // build one up front so every lazily created singleton exists before anything is counted
    const warmup = new VehicleSystem(ps);
    warmup.addVehicle('warmup', at(-200));
    ps.onUpdate(1 / 60);
    warmup.destroy();
});

// vehicles are parked far apart: two chassis touching go through BodySystem's contact listener,
// which throws for a body it never registered - and the car body is made off the body interface
function at(z: number) {
    return { bodyPosition: [0, 3, z] as [number, number, number] };
}

// Everything the vehicle files allocate and free themselves. The tracker's defaults only cover
// the value types, so the settings objects a vehicle builds and destroys during construction
// would all be counted as "foreign" destroys. Same list as vehicle-destroy.test.ts.
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

/**
 * Skid thresholds that only the *lateral* slip can cross. A 500 Nm standing start spins the
 * wheels against a standing still contact patch, which is a slip ratio of several thousand for
 * a step or two, so there is no finite longitudinal threshold that excludes it.
 */
const LATERAL_ONLY = {
    longitudinalSlip: Number.POSITIVE_INFINITY,
    lateralSlip: 0.3,
    releaseTime: 0.1
};

const STEP = 1 / 60;
const step = (times: number) => {
    for (let i = 0; i < times; i++) ps.onUpdate(STEP);
};

//* Engine / audio readouts ===================================================================

test('driving forward reads out rpm, gear, speed and a wheel spin that keeps growing', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));
    const wheel = vehicle.getWheel('fl');
    assert.isDefined(wheel);

    // the readouts are flat before anything has happened
    step(1);
    assert.equal(vehicle.gear, 0, 'the gearbox started in gear');

    vehicle.move(new THREE.Vector2(0, 1));
    const spinAfterFirst: number[] = [];
    for (let i = 0; i < 120; i++) {
        ps.onUpdate(STEP);
        if (i % 30 === 29) spinAfterFirst.push(wheel!.spinAngle);
    }

    assert.isAbove(vehicle.rpm, 0, 'the engine never turned over');
    assert.isAtLeast(vehicle.gear, 1, 'the gearbox never engaged a forward gear');
    assert.isAbove(vehicle.speedKmh, 0, 'the vehicle never moved forward');
    assert.approximately(vehicle.speedKmh, vehicle.speed * 3.6, 1e-9);
    assert.equal(vehicle.throttle, 1, 'the throttle readout does not follow the driver input');

    // jolt wraps its own rotation angle into [0, 2pi); ours is accumulated, so it only grows
    assert.isAbove(spinAfterFirst[0], 0, 'the wheel never span');
    for (let i = 1; i < spinAfterFirst.length; i++) {
        assert.isAbove(
            spinAfterFirst[i],
            spinAfterFirst[i - 1],
            `the accumulated spin angle went backwards at sample ${i} (jolt's wrap leaked through)`
        );
    }
    assert.isAbove(spinAfterFirst.at(-1)!, Math.PI * 2, 'the spin angle is still wrapped');
    assert.isAbove(wheel!.spinVelocity, 0, 'the wheel has no angular velocity');
    assert.isTrue(wheel!.hasContact, 'the wheel lost the floor');
    assert.isAbove(wheel!.suspensionLength, 0, 'the suspension length was never read');

    system.destroy();
});

test('onEngine dispatches the same readout the getters give, and unsubscribes', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));

    let calls = 0;
    let seen: VehicleEngineState | undefined;
    const snapshot = { rpm: 0, gear: 0, throttle: 0, speedKmh: 0 };
    const off = vehicle.onEngine((state) => {
        calls++;
        seen = state;
        snapshot.rpm = state.rpm;
        snapshot.gear = state.gear;
        snapshot.throttle = state.throttle;
        snapshot.speedKmh = state.speedKmh;
    });

    vehicle.move(new THREE.Vector2(0, 1));
    step(90);
    assert.equal(calls, 90, 'onEngine did not fire once per physics step');
    assert.approximately(snapshot.rpm, vehicle.rpm, 1e-6);
    assert.equal(snapshot.gear, vehicle.gear);
    assert.approximately(snapshot.speedKmh, vehicle.speedKmh, 1e-6);
    assert.equal(snapshot.throttle, 1);

    // the payload is pooled on purpose: the same object every time
    const pooled = seen;
    step(1);
    assert.equal(seen, pooled, 'the engine payload is not pooled - that is a per frame allocation');

    off();
    const callsAtUnsubscribe = calls;
    step(10);
    assert.equal(calls, callsAtUnsubscribe, 'the engine listener outlived its unsubscribe');

    system.destroy();
});

//* Slip and skid =============================================================================

test('a hard steer at speed slips the front wheels and fires one skidStart, then skidEnd', () => {
    const system = new VehicleSystem(ps);
    // the longitudinal threshold is put out of reach so this test is about the *lateral* slip
    // only: a 500 Nm standing start spins the wheels to a slip ratio of 3 all by itself
    const vehicle = system.addVehicle('car', {
        ...at(0),
        skid: LATERAL_ONLY
    });

    const started: string[] = [];
    const ended: string[] = [];
    let pooledStart: VehicleSkidEvent | undefined;
    const contact = new THREE.Vector3();
    vehicle.onSkidStart((event) => {
        started.push(event.name);
        pooledStart = pooledStart ?? event;
        assert.equal(event.wheel, vehicle.getWheel(event.name));
        assert.equal(event.index, vehicle.wheelOrder.indexOf(event.name));
        contact.copy(event.position);
    });
    vehicle.onSkidEnd((event) => ended.push(event.name));

    // get up to speed in a straight line: no lateral slip at all
    vehicle.move(new THREE.Vector2(0, 1));
    step(120);
    assert.equal(vehicle.getWheel('fl')!.lateralSlip, 0, 'the car slipped sideways going straight');
    assert.deepEqual(started, [], 'a straight line fired a skid');
    assert.isAbove(Math.abs(vehicle.getWheel('fl')!.slipRatio), 0, 'no longitudinal slip at all');

    // now throw it into a full lock turn
    vehicle.move(new THREE.Vector2(1, 1));
    step(90);

    const fl = vehicle.getWheel('fl')!;
    const fr = vehicle.getWheel('fr')!;
    assert.isAbove(Math.abs(fl.lateralSlip), 0, 'the front left wheel has no lateral slip');
    assert.isAbove(Math.abs(fr.lateralSlip), 0, 'the front right wheel has no lateral slip');
    assert.isTrue(fl.isSkidding, 'the front left wheel is not flagged as skidding');
    assert.isTrue(vehicle.skidding, 'the vehicle does not report that it is skidding');

    // one event per wheel, not one per frame
    assert.equal(
        started.filter((name) => name === 'fl').length,
        1,
        `skidStart fired ${started.filter((n) => n === 'fl').length} times for one skid: ${started}`
    );
    assert.include(started, 'fr');
    assert.deepEqual(ended, [], 'a skid ended while the car was still sliding');
    assert.notEqual(contact.lengthSq(), 0, 'the skid event carried no contact position');
    assert.isBelow(Math.abs(contact.y), 2, 'the contact position is not on the floor');

    // ... and stop. No lateral velocity means no lateral slip, so every skid ends.
    vehicle.move(new THREE.Vector2(0, 0));
    vehicle.setHandBrake(true);
    let guard = 0;
    while (vehicle.skidding && guard < 1200) {
        ps.onUpdate(STEP);
        guard++;
    }
    assert.isBelow(guard, 1200, 'the car never stopped skidding after the inputs were released');
    assert.isFalse(fl.isSkidding, 'the front left wheel is still skidding after stopping');
    assert.isFalse(vehicle.skidding);
    assert.include(ended, 'fl');
    // braking out of a slide can genuinely break traction again for a moment, so the count is
    // not exactly one - but it is a handful of transitions, not one per frame for 20 seconds
    assert.isBelow(ended.length, 20, `skidEnd is firing per frame: ${ended.length} events`);
    assert.isBelow(started.length, 20, `skidStart is firing per frame: ${started.length} events`);

    system.destroy();
});

test('skid: false ends the skids that are running and stops detecting new ones', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', {
        ...at(0),
        skid: LATERAL_ONLY
    });
    const ended: string[] = [];
    vehicle.onSkidEnd((event) => ended.push(event.name));

    vehicle.move(new THREE.Vector2(0, 1));
    step(120);
    vehicle.move(new THREE.Vector2(1, 1));
    step(60);
    assert.isTrue(vehicle.skidding, 'the car never started skidding');

    vehicle.setSkid(false);
    assert.include(ended, 'fl', 'turning skid detection off left a skid hanging');
    assert.isFalse(vehicle.skidding);
    step(60);
    assert.isFalse(vehicle.skidding, 'a skid was detected while detection is off');

    system.destroy();
});

//* Body roll =================================================================================

test('the chassis object leans under acceleration and comes back level', () => {
    const system = new VehicleSystem(ps);
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 4));
    const vehicle = system.addVehicle('car', {
        ...at(0),
        bodyObject: chassis,
        // exaggerated so the test reads a signal rather than a rounding error
        bodyRoll: { maxAngle: 0.4, maxPitchAngle: 0.4, referenceAcceleration: 3, stiffness: 120 }
    });
    assert.equal(vehicle.bodyObject, chassis);

    // settle on the floor first
    step(60);
    const settled = Math.abs(vehicle.bodyPitchAngle);

    // hard acceleration pitches the nose up
    vehicle.move(new THREE.Vector2(0, 1));
    let peakPitch = 0;
    for (let i = 0; i < 90; i++) {
        ps.onUpdate(STEP);
        peakPitch = Math.max(peakPitch, Math.abs(vehicle.bodyPitchAngle));
    }
    assert.isAbove(peakPitch, settled + 0.02, 'the chassis never pitched under acceleration');
    assert.isAtMost(Math.abs(vehicle.bodyPitchAngle), 0.4 + 1e-9, 'the pitch broke maxPitchAngle');

    // a full lock turn rolls it sideways
    vehicle.move(new THREE.Vector2(1, 1));
    let peakRoll = 0;
    for (let i = 0; i < 90; i++) {
        ps.onUpdate(STEP);
        peakRoll = Math.max(peakRoll, Math.abs(vehicle.bodyRollAngle));
    }
    assert.isAbove(peakRoll, 0.02, 'the chassis never rolled through the corner');
    assert.isAtMost(Math.abs(vehicle.bodyRollAngle), 0.4 + 1e-9, 'the roll broke maxAngle');

    // the tilt is on the *object*, not on the body: the vehicle root still is the physics pose
    // (compared component-wise; Quaternion.angleTo runs acos near 1 and has a ~1e-3 noise floor)
    const rotation = vehicle.carBody.GetRotation();
    const bodyRotation = new THREE.Quaternion(
        rotation.GetX(),
        rotation.GetY(),
        rotation.GetZ(),
        rotation.GetW()
    );
    for (const axis of ['x', 'y', 'z', 'w'] as const) {
        assert.approximately(
            vehicle.threeObject.quaternion[axis],
            bodyRotation[axis],
            1e-9,
            `the vehicle root's ${axis} no longer matches the physics body`
        );
    }
    assert.isAbove(
        Math.abs(chassis.quaternion.z) + Math.abs(chassis.quaternion.x),
        1e-3,
        'the lean was never applied to the chassis object'
    );

    // stop, and it settles back to level
    vehicle.move(new THREE.Vector2(0, 0));
    vehicle.setHandBrake(true);
    step(300);
    assert.isBelow(Math.abs(vehicle.bodyRollAngle), 0.01, 'the body never came back level');
    assert.isBelow(Math.abs(vehicle.bodyPitchAngle), 0.01, 'the body never stopped pitching');

    system.destroy();
});

test('bodyRoll: false never touches the chassis object, and setBodyRoll(false) levels it', () => {
    const system = new VehicleSystem(ps);
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 4));
    chassis.rotation.set(0, 0.5, 0);
    const own = chassis.quaternion.clone();
    const vehicle = system.addVehicle('car', { ...at(0), bodyObject: chassis, bodyRoll: false });

    vehicle.move(new THREE.Vector2(1, 1));
    step(120);
    assert.equal(vehicle.bodyRollAngle, 0);
    assert.isBelow(chassis.quaternion.angleTo(own), 1e-6, 'bodyRoll: false rotated the chassis');

    // switching it on, then off again, hands the object back level
    vehicle.setBodyRoll({ maxAngle: 0.4, referenceAcceleration: 3 });
    step(60);
    assert.isAbove(Math.abs(vehicle.bodyRollAngle), 1e-4, 'setBodyRoll did not turn it on');
    vehicle.setBodyRoll(false);
    assert.equal(vehicle.bodyRollAngle, 0);
    assert.isBelow(chassis.quaternion.angleTo(new THREE.Quaternion()), 1e-6);

    system.destroy();
});

//* Wheel smoothing ===========================================================================

test('the rendered steering angle eases towards jolt, and is exactly jolt when turned off', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', {
        ...at(0),
        wheelSmoothing: { suspension: 0.15, steering: 0.2 }
    });
    const wheel = vehicle.getWheel('fl')!;

    vehicle.move(new THREE.Vector2(0, 1));
    step(90);
    // full lock, all at once: jolt applies it in a single step, the render must not
    vehicle.move(new THREE.Vector2(1, 1));
    step(2);

    assert.notEqual(wheel.rawSteerAngle, 0, 'jolt never steered');
    assert.isBelow(
        Math.abs(wheel.steerAngle),
        Math.abs(wheel.rawSteerAngle),
        'the rendered steering angle did not lag jolt at all'
    );

    // the pre-multiplied delta has to be the same thing as rebuilding the transform for the
    // eased angle, so ask jolt for exactly that and compare
    const expected = joltWheelQuaternion(vehicle, 0, wheel.steerAngle);
    assert.isBelow(
        expected.angleTo(wheel.threeObject.quaternion),
        1e-5,
        'the eased wheel rotation is not the transform jolt would build for that steer angle'
    );

    // and it converges once the input stops moving
    step(120);
    assert.approximately(wheel.steerAngle, wheel.rawSteerAngle, 1e-3);

    system.destroy();

    // with smoothing off the rendered transform is jolt's, to the bit
    const raw = new VehicleSystem(ps);
    const rawVehicle = raw.addVehicle('car', { ...at(0), wheelSmoothing: false });
    const rawWheel = rawVehicle.getWheel('fl')!;
    rawVehicle.move(new THREE.Vector2(1, 1));
    step(90);
    assert.equal(rawWheel.steerAngle, rawWheel.rawSteerAngle);
    assert.isBelow(
        joltWheelQuaternion(rawVehicle, 0, rawWheel.rawSteerAngle).angleTo(
            rawWheel.threeObject.quaternion
        ),
        1e-6
    );
    raw.destroy();
});

test('the rendered suspension travel lags the solver', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('eased', {
        ...at(0),
        wheelSmoothing: { suspension: 0.4, steering: 0 }
    });
    const wheel = vehicle.getWheel('fl')!;

    // the vehicle is dropped onto the floor: the suspension compresses in a couple of steps and
    // the eased wheel has to visibly trail jolt's own answer through that transient
    let maxLag = 0;
    for (let i = 0; i < 90; i++) {
        ps.onUpdate(STEP);
        maxLag = Math.max(maxLag, Math.abs(wheel.threeObject.position.y - joltWheelY(vehicle, 0)));
    }
    assert.isAbove(maxLag, 1e-3, 'the eased wheel tracked the solver exactly');

    // and it converges once the suspension is at rest
    step(240);
    assert.approximately(
        wheel.threeObject.position.y,
        joltWheelY(vehicle, 0),
        1e-3,
        'the eased wheel never converged on the solver'
    );

    system.destroy();

    // with smoothing off the rendered position is jolt's, to the bit
    const rawSystem = new VehicleSystem(ps);
    const raw = rawSystem.addVehicle('raw', { ...at(120), wheelSmoothing: false });
    for (let i = 0; i < 90; i++) {
        ps.onUpdate(STEP);
        assert.equal(raw.getWheel('fl')!.threeObject.position.y, joltWheelY(raw, 0));
    }
    rawSystem.destroy();
});

/** the local y jolt's own wheel transform puts the wheel at this instant */
function joltWheelY(vehicle: VehicleManager, index: number) {
    const state = vehicle.getWheel(index)!;
    return vehicle.constraint
        .GetWheelLocalTransform(index, state.wheelRight, state.wheelUp)
        .GetTranslation()
        .GetY();
}

/** the wheel rotation jolt itself builds for `steerAngle`, for comparing against the eased one */
function joltWheelQuaternion(vehicle: VehicleManager, index: number, steerAngle: number) {
    const state = vehicle.getWheel(index)!;
    const joltWheel = vehicle.constraint.GetWheel(index);
    const previous = joltWheel.GetSteerAngle();
    joltWheel.SetSteerAngle(steerAngle);
    try {
        const rotation = vehicle.constraint
            .GetWheelLocalTransform(index, state.wheelRight, state.wheelUp)
            .GetRotation()
            .GetQuaternion();
        return new THREE.Quaternion(
            rotation.GetX(),
            rotation.GetY(),
            rotation.GetZ(),
            rotation.GetW()
        );
    } finally {
        joltWheel.SetSteerAngle(previous);
    }
}

//* Memory ====================================================================================

test('every readout subscribed, 200 steps, not one wasm allocation', () => {
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        // installing the tracker swaps Raw.module, which rebuilds the joltScratch singletons -
        // warm everything up under the tracked module before counting
        const warmup = new VehicleSystem(ps);
        const warmVehicle = warmup.addVehicle('warmup', at(-120));
        warmVehicle.onEngine(() => {});
        warmVehicle.onSkidStart(() => {});
        warmVehicle.onSkidEnd(() => {});
        warmVehicle.move(new THREE.Vector2(1, 1));
        step(10);
        warmup.destroy();

        const baseline = alloc.live();
        const system = new VehicleSystem(ps);
        const vehicle = system.addVehicle('car', at(0));
        let engineCalls = 0;
        let skids = 0;
        vehicle.onEngine((state) => {
            engineCalls++;
            void state.rpm;
        });
        vehicle.onSkidStart(() => skids++);
        vehicle.onSkidEnd(() => skids++);

        vehicle.move(new THREE.Vector2(0, 1));
        step(60);
        const before = alloc.live();
        const allocatedBefore = alloc.allocated();

        // accelerate, corner, brake: every branch of the presentational layer runs
        step(80);
        vehicle.move(new THREE.Vector2(1, 1));
        step(80);
        vehicle.move(new THREE.Vector2(0, 0));
        vehicle.setHandBrake(true);
        step(40);

        assert.isAbove(engineCalls, 200, 'the engine readout stopped firing');
        assert.isAbove(skids, 0, 'no skid ever fired, so the skid path was never exercised');
        assert.equal(
            alloc.allocated() - allocatedBefore,
            0,
            `200 steps allocated ${alloc.allocated() - allocatedBefore} jolt objects: ` +
                JSON.stringify(alloc.liveByType())
        );
        assert.equal(alloc.live(), before, 'the frame loop leaked');
        assert.equal(alloc.foreignDestroys(), 0, 'something freed a jolt value return');

        // ... and the whole thing goes away again
        system.destroy();
        assert.equal(
            alloc.live(),
            baseline,
            `destroy() left ${alloc.live() - baseline} objects behind: ` +
                JSON.stringify(alloc.liveByType())
        );
        assert.equal(alloc.foreignDestroys(), 0);
    } finally {
        alloc.uninstall();
    }
});

test('destroy() silences the readouts rather than throwing', () => {
    const system = new VehicleSystem(ps);
    const vehicle = system.addVehicle('car', at(0));
    let calls = 0;
    vehicle.onEngine(() => calls++);
    vehicle.move(new THREE.Vector2(0, 1));
    step(30);
    assert.isAbove(calls, 0);

    system.destroy();
    const callsAtDestroy = calls;
    step(30);
    assert.equal(calls, callsAtDestroy, 'a destroyed vehicle is still emitting');
    // the getters degrade to zeroes instead of reaching into freed memory
    assert.equal(vehicle.rpm, 0);
    assert.equal(vehicle.gear, 0);
    assert.equal(vehicle.speed, 0);
    assert.equal(vehicle.speedKmh, 0);
    assert.isFalse(vehicle.skidding);
    assert.doesNotThrow(() => vehicle.postPhysicsUpdate(STEP));
});
