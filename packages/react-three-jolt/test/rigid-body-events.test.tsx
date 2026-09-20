// The declarative surface: `<RigidBody on*>`, `<Physics on*>` and the hooks (issues #32, #21,
// #156). The React trees drive the real WASM module through @react-three/test-renderer, and the
// physics system is stepped by hand so the assertions are deterministic.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { CollisionEnterPayload, CollisionPayload } from '../src/systems/events';
import type { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** Captures the world so the test can step it by hand. */
function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

const Floor = (props: { isSensor?: boolean; [key: string]: unknown }) => (
    <RigidBody type="static" position={[0, -1, 0]} {...props}>
        <mesh>
            <boxGeometry args={[50, 1, 50]} />
        </mesh>
    </RigidBody>
);

test('<RigidBody onCollisionEnter> registers on the pass that creates the body', async () => {
    // The old effect's dep array read `rigidBodyRef.current`, a non-reactive mutable ref, so on
    // the render that created the body it had already run with `undefined` and never re-ran.
    // Nothing was ever registered.
    let system: PhysicsSystem | undefined;
    const enters: CollisionEnterPayload[] = [];
    const exits: CollisionPayload[] = [];

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <RigidBody
                position={[0, 1, 0]}
                onCollisionEnter={(e) =>
                    enters.push({ ...e, target: { ...e.target }, other: { ...e.other } } as never)
                }
                onCollisionExit={(e) =>
                    exits.push({ ...e, target: { ...e.target }, other: { ...e.other } })
                }
            >
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 40 && enters.length === 0; i++) system!.onUpdate(STEP);

    assert.equal(enters.length, 1, 'the prop never registered a listener');
    assert.isDefined(enters[0].target.body, 'the payload has no body for the subscriber');
    assert.isDefined(enters[0].other.body, 'the payload has no body for the floor');
    assert.equal(enters.length, 1);
    assert.equal(exits.length, 0);

    await renderer.unmount();
});

test('<Physics onCollisionEnter> fires once per pair', async () => {
    let system: PhysicsSystem | undefined;
    const world: CollisionPayload[] = [];
    let perBody = 0;

    const renderer = await create(
        <Physics
            onCollisionEnter={(e) =>
                world.push({ ...e, target: { ...e.target }, other: { ...e.other } })
            }
        >
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <RigidBody position={[0, 1, 0]} onCollisionEnter={() => perBody++}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 40 && world.length === 0; i++) system!.onUpdate(STEP);

    assert.equal(world.length, 1, 'the world handler did not fire exactly once per pair');
    assert.equal(perBody, 1, 'the per body handler did not fire');
    // the world payload's target is the lower handle, so a world wide counter is right without
    // dividing by two
    assert.isBelow(world[0].target.handle, world[0].other.handle);

    await renderer.unmount();
});

test('<RigidBody isSensor onSensorEnter/onSensorExit> and the rapier aliases', async () => {
    let system: PhysicsSystem | undefined;
    const log: string[] = [];
    const aliasLog: string[] = [];

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <RigidBody
                type="static"
                isSensor
                position={[0, 2, 0]}
                onSensorEnter={() => log.push('enter')}
                onSensorExit={() => log.push('exit')}
            >
                <mesh>
                    <boxGeometry args={[6, 1, 6]} />
                </mesh>
            </RigidBody>
            <RigidBody
                type="static"
                isSensor
                position={[0, 4, 0]}
                onIntersectionEnter={() => aliasLog.push('enter')}
                onIntersectionExit={() => aliasLog.push('exit')}
            >
                <mesh>
                    <boxGeometry args={[6, 1, 6]} />
                </mesh>
            </RigidBody>
            <RigidBody position={[0, 7, 0]}>
                <mesh>
                    <boxGeometry args={[0.5, 0.5, 0.5]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 180; i++) system!.onUpdate(STEP);

    assert.deepEqual(log, ['enter', 'exit'], 'the sensor prop did not report one enter/exit');
    assert.deepEqual(aliasLog, ['enter', 'exit'], 'the rapier compatible aliases did not fire');

    await renderer.unmount();
});

test('<RigidBody onSleep/onWake>', async () => {
    let system: PhysicsSystem | undefined;
    const log: string[] = [];

    const renderer = await create(
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <RigidBody
                position={[0, 0.5, 0]}
                onSleep={() => log.push('sleep')}
                onWake={() => log.push('wake')}
            >
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    assert.isDefined(system);
    for (let i = 0; i < 300 && !log.includes('sleep'); i++) system!.onUpdate(STEP);
    assert.deepEqual(log, ['sleep'], 'the body never reported sleeping');

    // and no phantom wake was delivered for the activation AddBody did on mount
    await renderer.unmount();
});

test('a handler prop that is removed stops firing, and re-renders do not stack listeners', async () => {
    let system: PhysicsSystem | undefined;
    let calls = 0;

    const tree = (withHandler: boolean) => (
        <Physics>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Floor />
            <RigidBody
                position={[0, 0.5, 0]}
                // a fresh inline arrow on every render
                onCollisionPersist={withHandler ? () => calls++ : undefined}
            >
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree(true));
    assert.isDefined(system);
    for (let i = 0; i < 30 && calls === 0; i++) system!.onUpdate(STEP);
    assert.isAbove(calls, 0, 'never fired');

    // re-render: an identity-keyed subscription would now be registered twice
    await renderer.update(tree(true));
    calls = 0;
    system!.onUpdate(STEP);
    assert.equal(calls, 1, 're-rendering stacked a second subscription');

    // and dropping the prop drops the subscription
    await renderer.update(tree(false));
    calls = 0;
    system!.onUpdate(STEP);
    assert.equal(calls, 0, 'removing the prop left the listener behind');

    await renderer.unmount();
});

test('<Physics module> can be toggled without breaking the hook order', async () => {
    // issue #137: `suspend()` used to be called inside an if/else on `module`, so toggling the
    // prop changed the number of hooks between renders.
    const renderer = await create(
        <Physics>
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );
    await renderer.update(
        <Physics module={undefined}>
            <RigidBody>
                <mesh>
                    <boxGeometry />
                </mesh>
            </RigidBody>
        </Physics>
    );
    await renderer.unmount();
});
