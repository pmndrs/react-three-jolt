// Issue #140, the React half: `<VehicleFourWheel>` added a vehicle and never removed it, and the
// `onPreStep` remover it registered was thrown away. Mounting and unmounting therefore left the
// VehicleSystem's two step listeners (and the vehicle's whole constraint graph) behind every time.
//
// Issues #10/#26/#27, the React half: one `<Vehicle>` replaces `<VehicleFourWheel>`, and the
// chassis and the wheels can be the caller's own objects - synced by the manager, disposed only
// by whoever created them.

import { create } from '@react-three/test-renderer';
// React stays a *value* import: this package compiles JSX with the classic runtime, so the
// emitted `React.createElement` calls need it at runtime (an autofixer for eslint's
// @typescript-eslint/consistent-type-imports would offer to make it `import type` - don't).
import React, { act, useEffect } from 'react';
import * as THREE from 'three';
import { assert, test } from 'vitest';
import { TrackedVehicle } from '../../src/controllers/components/vehicle/TrackedVehicle';
import { Vehicle } from '../../src/controllers/components/vehicle/Vehicle';
import { VehicleFourWheel } from '../../src/controllers/components/vehicle/VehicleFourWheel';
import type { VehicleManager } from '../../src/controllers/systems/vehicles';
import { Physics, type PhysicsSystem, Raw, RigidBody, useJolt } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Step callbacks moved from the private `preStepListeners`/`postStepListeners` arrays onto the
// world Emitter (issue #187). `listenerCount` is the supported way to ask, and is still the
// whole point of these tests: that unsubscribing actually happened. The real PhysicsSystem also
// supplies `onUpdate`, which the vehicle-API tests drive directly.
type AnyPhysicsSystem = PhysicsSystem;

const stepListeners = (system: AnyPhysicsSystem) =>
    system.events.listenerCount('beforeStep') + system.events.listenerCount('afterStep');

const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

const Harness = ({
    show,
    onReady,
    children
}: {
    show: boolean;
    onReady: (system: AnyPhysicsSystem) => void;
    children?: React.ReactNode;
}) => {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem as unknown as AnyPhysicsSystem);
    }, [physicsSystem, onReady]);
    return show ? <group>{children}</group> : null;
};

test('mounting and unmounting <Vehicle> twice leaves no listeners behind', async () => {
    let system: AnyPhysicsSystem | undefined;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady}>
                <Vehicle position={[0, 4, 0]} />
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    assert.isDefined(system, 'Physics never mounted its children');

    const baseline = stepListeners(system!);

    for (let cycle = 0; cycle < 2; cycle++) {
        await renderer.update(tree(true));
        await settle(() => stepListeners(system!) > baseline);
        // the VehicleSystem registers one pre-step and one post-step listener
        assert.equal(
            stepListeners(system!),
            baseline + 2,
            `cycle ${cycle}: the vehicle system did not register its listeners`
        );

        await renderer.update(tree(false));
        assert.equal(
            stepListeners(system!),
            baseline,
            `cycle ${cycle}: the vehicle system's listeners outlived the component`
        );
    }

    await renderer.unmount();
});

test('the deprecated <VehicleFourWheel> alias still renders a four wheeled vehicle', async () => {
    let system: AnyPhysicsSystem | undefined;
    let vehicle: VehicleManager | null = null;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady}>
                <VehicleFourWheel
                    position={[0, 4, 40]}
                    onVehicle={(created) => {
                        if (created) vehicle = created;
                    }}
                />
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    await renderer.update(tree(true));
    await settle(() => vehicle !== null);

    assert.isNotNull(vehicle, '<VehicleFourWheel> never created a vehicle');
    // assigned from a React callback, so control flow analysis still has it as `null` here
    const created = vehicle as unknown as VehicleManager;
    assert.equal(created.settings.type, 'fourWheel');
    assert.equal(created.wheels.size, 4);

    await renderer.unmount();
});

test('<TrackedVehicle> renders a tracked vehicle with children as its chassis', async () => {
    let system: AnyPhysicsSystem | undefined;
    let vehicle: VehicleManager | null = null;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady}>
                <TrackedVehicle
                    position={[0, 4, 60]}
                    onVehicle={(created) => {
                        if (created) vehicle = created;
                    }}
                >
                    <mesh name="hull">
                        <boxGeometry args={[2.6, 0.7, 5]} />
                        <meshBasicMaterial />
                    </mesh>
                </TrackedVehicle>
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    await renderer.update(tree(true));
    await settle(() => vehicle !== null);

    assert.isNotNull(vehicle, '<TrackedVehicle> never created a vehicle');
    const created = vehicle as unknown as VehicleManager;
    assert.equal(created.settings.type, 'tracked');
    assert.equal(created.wheels.size, 8);
    const chassis = created.bodyObject;
    assert.isDefined(chassis, 'the children were not used as the chassis');
    assert.isDefined(chassis!.getObjectByName('hull'));

    await act(async () => {
        for (let i = 0; i < 10; i++) system!.onUpdate(1 / 60);
    });
    created.threeObject.updateMatrixWorld(true);
    assert.isBelow(
        chassis!.getWorldPosition(new THREE.Vector3()).distanceTo(created.position),
        1e-6
    );

    await renderer.unmount();
});

// Issues #26 and #27 -------------------------------------------------------------------------

type UserParts = { chassis: THREE.Mesh; wheels: THREE.Mesh[]; disposed: string[] };

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
        // by value: a static temporary, never to be destroyed
        const translation = vehicle.constraint
            .GetWheelWorldTransform(index, right, up)
            .GetTranslation();
        return new THREE.Vector3(translation.GetX(), translation.GetY(), translation.GetZ());
    } finally {
        Raw.module.destroy(right);
        Raw.module.destroy(up);
    }
}

// the same object graph is mounted twice: once to warm every lazily created jolt singleton up
// under the allocation tracker, once with the assertions
const tracked = [
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

test('<Vehicle> syncs an injected chassis and four wheel objects, and hands them back', async () => {
    let system: AnyPhysicsSystem | undefined;
    let vehicle: VehicleManager | null = null;
    let parts = userParts();

    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady}>
                <Vehicle
                    position={[0, 4, -40]}
                    bodyObject={parts.chassis}
                    wheelObjects={parts.wheels}
                    onVehicle={(created) => {
                        vehicle = created;
                    }}
                />
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    assert.isDefined(system, 'Physics never mounted its children');

    const alloc = installAllocTracker(Raw, { types: tracked });
    try {
        // warm-up cycle: joltScratch is rebuilt against the tracked module on first use
        await renderer.update(tree(true));
        await settle(() => vehicle !== null);
        await act(async () => {
            system!.onUpdate(1 / 60);
        });
        await renderer.update(tree(false));
        await settle(() => vehicle === null);
        const before = alloc.live();

        parts = userParts();
        await renderer.update(tree(true));
        await settle(() => vehicle !== null);
        assert.isNotNull(vehicle, '<Vehicle> never created a vehicle');
        const manager = vehicle as unknown as VehicleManager;

        // the injected objects replaced the generated ones outright
        assert.isUndefined(manager.debugObject, 'a chassis box was generated anyway');
        assert.equal(manager.bodyObject, parts.chassis);
        parts.wheels.forEach((wheel, index) => {
            assert.equal(manager.getWheelObject(index), wheel, `wheel ${index} was not injected`);
            assert.isUndefined(manager.getWheel(index)?.debugObject);
        });

        const startY = parts.chassis.getWorldPosition(new THREE.Vector3()).y;
        await act(async () => {
            for (let i = 0; i < 30; i++) system!.onUpdate(1 / 60);
        });

        manager.threeObject.updateMatrixWorld(true);
        parts.wheels.forEach((wheel, index) => {
            const expected = wheelWorldPosition(manager, index);
            const actual = wheel.getWorldPosition(new THREE.Vector3());
            assert.isBelow(
                actual.distanceTo(expected),
                1e-3,
                `wheel ${index} is at ${actual.toArray()} but jolt says ${expected.toArray()}`
            );
        });
        assert.isBelow(
            parts.chassis.getWorldPosition(new THREE.Vector3()).distanceTo(manager.position),
            1e-6,
            'the chassis object does not follow the body'
        );
        assert.notEqual(
            startY,
            parts.chassis.getWorldPosition(new THREE.Vector3()).y,
            'the vehicle never moved, so following it proves nothing'
        );

        await renderer.update(tree(false));
        await settle(() => vehicle === null);

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

    await renderer.unmount();
});

test('<Vehicle> uses its children as the chassis', async () => {
    let system: AnyPhysicsSystem | undefined;
    let vehicle: VehicleManager | null = null;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady}>
                <Vehicle
                    position={[0, 4, 80]}
                    onVehicle={(created) => {
                        vehicle = created;
                    }}
                >
                    <mesh name="chassis-child">
                        <boxGeometry args={[1.8, 0.4, 4]} />
                        <meshBasicMaterial />
                    </mesh>
                </Vehicle>
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    await renderer.update(tree(true));
    await settle(() => vehicle !== null);

    const manager = vehicle as unknown as VehicleManager;
    assert.isUndefined(manager.debugObject, 'the generated box was built even with children');
    const chassis = manager.bodyObject;
    assert.isDefined(chassis, 'the children were not used as the chassis');
    assert.equal(chassis!.parent, manager.threeObject);
    assert.isDefined(
        chassis!.getObjectByName('chassis-child'),
        'the children are not inside the chassis object'
    );

    await act(async () => {
        for (let i = 0; i < 10; i++) system!.onUpdate(1 / 60);
    });
    manager.threeObject.updateMatrixWorld(true);
    assert.isBelow(
        chassis!.getWorldPosition(new THREE.Vector3()).distanceTo(manager.position),
        1e-6
    );

    await renderer.unmount();
});

// Issue #41: the secondary physics props. They are all live - a debug panel re-tunes them
// without rebuilding the vehicle - and the three event props subscribe exactly once.
test('<Vehicle> wires the secondary physics props, live, and unsubscribes on unmount', async () => {
    let system: AnyPhysicsSystem | undefined;
    let vehicle: VehicleManager | null = null;
    let engineCalls = 0;
    let lastRpm = 0;
    let maxAngle = 0.4;

    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean, rollMax: number | false) => (
        <Physics>
            {/* the vehicle has to be on something: in free fall the only acceleration is
                straight down the chassis' own up axis, which is neither roll nor pitch */}
            <RigidBody position={[0, -1, 0]} type="static">
                <mesh>
                    <boxGeometry args={[400, 1, 400]} />
                </mesh>
            </RigidBody>
            <Harness show={show} onReady={onReady}>
                <Vehicle
                    position={[0, 4, 0]}
                    bodyRoll={
                        rollMax === false
                            ? false
                            : {
                                  maxAngle: rollMax,
                                  maxPitchAngle: rollMax,
                                  referenceAcceleration: 3
                              }
                    }
                    wheelSmoothing={{ suspension: 0.2, steering: 0.2 }}
                    skid={{ lateralSlip: 0.3 }}
                    onEngine={(state) => {
                        engineCalls++;
                        lastRpm = state.rpm;
                    }}
                    onVehicle={(created) => {
                        vehicle = created;
                    }}
                />
            </Harness>
        </Physics>
    );

    const renderer = await create(tree(false, maxAngle));
    await settle(() => system !== undefined);
    await renderer.update(tree(true, maxAngle));
    await settle(() => vehicle !== null);
    const manager = vehicle as unknown as VehicleManager;
    assert.isNotNull(vehicle, '<Vehicle> never created a vehicle');

    manager.move(new THREE.Vector2(0, 1));
    await act(async () => {
        for (let i = 0; i < 90; i++) system!.onUpdate(1 / 60);
    });

    assert.isAbove(engineCalls, 0, 'onEngine never fired');
    assert.isAbove(lastRpm, 0, 'onEngine reported no rpm');
    assert.isAbove(manager.speed, 0, 'the vehicle never drove off');
    assert.isAbove(Math.abs(manager.bodyPitchAngle), 1e-4, 'bodyRoll did not reach the manager');

    // re-rendering with a tighter limit re-tunes the spring rather than rebuilding the vehicle
    maxAngle = 0.01;
    await renderer.update(tree(true, maxAngle));
    await act(async () => {
        for (let i = 0; i < 60; i++) system!.onUpdate(1 / 60);
    });
    assert.equal(vehicle, manager, 'changing bodyRoll rebuilt the whole vehicle');
    assert.isAtMost(Math.abs(manager.bodyPitchAngle), 0.01 + 1e-9, 'the new maxAngle was ignored');

    // ... and false hands the chassis object's rotation back
    await renderer.update(tree(true, false));
    assert.equal(manager.bodyRollAngle, 0);

    const callsBeforeUnmount = engineCalls;
    await renderer.update(tree(false, false));
    await act(async () => {
        for (let i = 0; i < 10; i++) system!.onUpdate(1 / 60);
    });
    assert.equal(engineCalls, callsBeforeUnmount, 'onEngine outlived the component');

    await renderer.unmount();
});
