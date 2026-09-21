// <Attractor> / useAttractor (issue #159).
//
// Every test runs in zero gravity, so the only thing that can move a body is the attractor -
// there is no "it fell" confound. The world is stepped by hand, which also makes the
// per-substep contract testable: the assertions below are about 60 *substeps*, not 60 frames.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { assert, beforeAll, test } from 'vitest';
import { Attractor, Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';
import { joltScratch } from '../src/utils';
import { installAllocTracker } from './jolt-alloc';

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

/** The single dynamic body in the world. */
const onlyBody = (system: PhysicsSystem): BodyState => {
    const bodies = [...system.bodySystem.dynamicBodies.values()];
    assert.lengthOf(bodies, 1, 'expected exactly one dynamic body');
    return bodies[0];
};

/**
 * A 1m box `distance` metres along +X from an attractor at the origin. A default box is
 * ~1000kg, so `strength` is in newtons and the accelerations below are small on purpose.
 */
async function makeWorld(options: {
    distance: number;
    range?: number;
    strength?: number;
    enabled?: boolean;
    type?: 'static' | 'linear' | 'newtonian';
}) {
    let system: PhysicsSystem | undefined;
    const renderer = await create(
        <Physics gravity={0}>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            <Attractor
                position={[0, 0, 0]}
                range={options.range ?? 10}
                strength={options.strength ?? 5000}
                type={options.type ?? 'static'}
                enabled={options.enabled ?? true}
            />
            <RigidBody position={[options.distance, 0, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
    assert.isDefined(system);
    return { renderer, system: system!, body: onlyBody(system!) };
}

test('a static attractor pulls a body 5m away toward it', async () => {
    const { renderer, system, body } = await makeWorld({ distance: 5 });
    const startX = body.position.x;
    assert.closeTo(startX, 5, 1e-6);

    for (let i = 0; i < 60; i++) system.onUpdate(STEP);

    const end = body.position;
    assert.isBelow(end.x, startX - 0.1, 'the body did not move toward the attractor');
    assert.isAbove(end.x, 0, 'the body shot past the attractor');
    // the pull is along the line between them, so nothing else should have moved
    assert.closeTo(end.y, 0, 1e-3);
    assert.closeTo(end.z, 0, 1e-3);

    await renderer.unmount();
});

test('a body outside `range` is left alone', async () => {
    // 20m away from a range of 10: the same attractor that moved the body above.
    const { renderer, system, body } = await makeWorld({ distance: 20, range: 10 });
    const start = body.position.clone();

    for (let i = 0; i < 60; i++) system.onUpdate(STEP);

    const end = body.position;
    assert.closeTo(end.x, start.x, 1e-6, 'a body beyond `range` was attracted');
    assert.closeTo(end.y, start.y, 1e-6);
    assert.closeTo(end.z, start.z, 1e-6);

    await renderer.unmount();
});

test('enabled={false} is a no-op', async () => {
    const { renderer, system, body } = await makeWorld({ distance: 5, enabled: false });
    const start = body.position.clone();

    for (let i = 0; i < 60; i++) system.onUpdate(STEP);

    const end = body.position;
    assert.closeTo(end.x, start.x, 1e-6, 'a disabled attractor still applied force');
    assert.closeTo(end.y, start.y, 1e-6);
    assert.closeTo(end.z, start.z, 1e-6);

    await renderer.unmount();
});

test('unmounting the attractor removes its step subscription', async () => {
    let system: PhysicsSystem | undefined;
    const tree = (withAttractor: boolean) => (
        <Physics gravity={0}>
            <Capture
                onSystem={(s) => {
                    system = s;
                }}
            />
            {withAttractor ? <Attractor position={[0, 0, 0]} range={10} strength={5000} /> : null}
            <RigidBody position={[5, 0, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree(true));
    assert.isDefined(system);
    assert.equal(system!.events.listenerCount('beforeStep'), 1);

    // a re-render must not add a second subscription
    await renderer.update(tree(true));
    assert.equal(system!.events.listenerCount('beforeStep'), 1, 'the attractor resubscribed');

    await renderer.update(tree(false));
    assert.equal(
        system!.events.listenerCount('beforeStep'),
        0,
        'the subscription survived unmount'
    );

    const body = onlyBody(system!);
    const start = body.position.clone();
    for (let i = 0; i < 60; i++) system!.onUpdate(STEP);
    assert.closeTo(body.position.x, start.x, 1e-6, 'an unmounted attractor still pulled');

    await renderer.unmount();
});

test('the per-step path allocates nothing on the Jolt heap', async () => {
    const { renderer, system } = await makeWorld({
        distance: 5,
        type: 'newtonian',
        strength: 1e14
    });

    // warm everything up before the tracker is installed AND once after: the tracker swaps
    // Raw.module's identity, which rebuilds the shared joltScratch singletons exactly once.
    for (let i = 0; i < 5; i++) system.onUpdate(STEP);

    const alloc = installAllocTracker(Raw);
    try {
        joltScratch.vec3(0, 0, 0);
        system.onUpdate(STEP);
        const before = alloc.live();
        for (let i = 0; i < 200; i++) system.onUpdate(STEP);
        assert.equal(alloc.live(), before, 'the attractor leaks Jolt objects per step');
        assert.equal(alloc.foreignDestroys(), 0, 'something freed a Jolt owned temporary');
    } finally {
        alloc.uninstall();
    }

    await renderer.unmount();
});
