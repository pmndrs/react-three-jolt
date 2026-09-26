// <Water> / useBuoyancy (issue #240): the React half of the buoyancy system. The physical
// behaviour (buoyancy > / < / = 1, mass independence, drag, wake-on-enter, ...) is covered
// against the raw `BuoyancySystem` in test/buoyancy.test.ts; this file is about the component
// lifecycle - registering/patching/removing the volume it owns as it mounts, re-renders and
// unmounts.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody, Water } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

const onlyBody = (system: PhysicsSystem): BodyState => {
    const bodies = [...system.bodySystem.dynamicBodies.values()];
    assert.lengthOf(bodies, 1, 'expected exactly one dynamic body');
    return bodies[0];
};

test('<Water> registers exactly one volume and removes it on unmount', async () => {
    let system: PhysicsSystem | undefined;
    const tree = (withWater: boolean) => (
        <Physics gravity={9.8}>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            {withWater ? (
                <Water position={[0, 0, 0]} size={[10, 10, 10]} surfaceHeight={2} buoyancy={1.5} />
            ) : null}
            <RigidBody position={[0, -3, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree(true));
    assert.isDefined(system);
    assert.equal(system!.getBuoyancySystem().volumeCount, 1);

    // a re-render must not register a second volume
    await renderer.update(tree(true));
    assert.equal(system!.getBuoyancySystem().volumeCount, 1, '<Water> re-registered on re-render');

    await renderer.update(tree(false));
    assert.equal(
        system!.getBuoyancySystem().volumeCount,
        0,
        'the volume survived <Water> unmounting'
    );

    await renderer.unmount();
});

test('<Water> floats a body and patches prop changes onto the same volume', async () => {
    let system: PhysicsSystem | undefined;
    const buoyancyValue = { current: 0.5 };
    const tree = () => (
        <Physics gravity={9.8}>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Water
                position={[0, 0, 0]}
                size={[10, 60, 10]}
                surfaceHeight={2}
                buoyancy={buoyancyValue.current}
            />
            <RigidBody position={[0, -3, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree());
    assert.isDefined(system);
    const body = onlyBody(system!);
    const start = body.position.y;

    // buoyancy 0.5 (< 1): the body should sink, not float
    for (let i = 0; i < 90; i++) system!.onUpdate(STEP);
    assert.isBelow(body.position.y, start - 1, 'buoyancy: 0.5 did not let the body sink');

    // now patch the same volume to be strongly buoyant and confirm it takes effect without a
    // remount (only one volume id has ever existed on this system)
    buoyancyValue.current = 2.5;
    await renderer.update(tree());
    assert.equal(system!.getBuoyancySystem().volumeCount, 1);

    const beforeRise = body.position.y;
    for (let i = 0; i < 180; i++) system!.onUpdate(STEP);
    assert.isAbove(
        body.position.y,
        beforeRise + 1,
        'updating buoyancy on the same <Water> did not take effect'
    );

    await renderer.unmount();
});
