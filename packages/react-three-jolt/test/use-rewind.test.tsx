// useRewind (issue #247): a ring buffer of PhysicsSystem.saveState() snapshots recorded from
// onAfterStep, with rewind(n) restoring `n` recorded frames back and dropping (and freeing)
// whatever was recorded after the frame it restored to.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { useJolt } from '../src/hooks';
import type { UseRewindApi } from '../src/hooks/use-rewind';
import { useRewind } from '../src/hooks/use-rewind';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** Captures the world and the hook's API so the test can drive steps and call `rewind` by hand. */
function Capture({
    onSystem,
    onApi
}: {
    onSystem: (system: PhysicsSystem) => void;
    onApi: (api: UseRewindApi) => void;
}) {
    const { physicsSystem } = useJolt();
    const api = useRewind({ frames: 5, interval: 1 });
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    React.useEffect(() => {
        onApi(api);
    });
    return null;
}

function scene(onSystem: (s: PhysicsSystem) => void, onApi: (a: UseRewindApi) => void) {
    return (
        <Physics gravity={9.81}>
            <Capture onSystem={onSystem} onApi={onApi} />
            <RigidBody position={[0, 10, 0]}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
}

test('useRewind records one snapshot per step, caps at `frames`, and rewind(n) restores that recorded frame', async () => {
    let system: PhysicsSystem | undefined;
    let api: UseRewindApi | undefined;

    const renderer = await create(
        scene(
            (s) => (system = s),
            (a) => (api = a)
        )
    );
    assert.isDefined(system);
    assert.isDefined(api);

    const box = system!.bodySystem.bodies.values().next().value as BodyState;
    assert.isDefined(box, 'test setup: no body registered');

    // 10 steps recorded into a 5 frame ring buffer - the earliest 5 are evicted as they go
    const yAfterStep: number[] = [];
    for (let i = 0; i < 10; i++) {
        system!.onUpdate(STEP);
        yAfterStep.push(box.position.y);
    }
    assert.equal(api!.getFrameCount(), 5, 'the ring buffer did not cap at `frames`');

    // rewind(1): the most recently recorded frame, i.e. right after step 10
    assert.isTrue(api!.rewind(1));
    assert.closeTo(box.position.y, yAfterStep[9], 1e-4, 'rewind(1) did not land on step 10');

    // rewind(5): the oldest frame still buffered - steps 1-5 were evicted, so this is step 6.
    // Buffered again from the rewind(1) restore's own recording notwithstanding, the buffer's
    // contents at this point are still exactly the snapshots after steps 6..10.
    assert.isTrue(api!.rewind(5));
    assert.closeTo(box.position.y, yAfterStep[5], 1e-4, 'rewind(5) did not land on step 6');

    // rewind(5) drops everything recorded after step 6, keeping only that one snapshot - so
    // asking to go back further than what's left now fails cleanly rather than throwing.
    assert.equal(
        api!.getFrameCount(),
        1,
        'rewind() did not drop the frames after the one restored to'
    );
    assert.isFalse(api!.rewind(2), 'rewinding past the buffered history should fail, not throw');

    await renderer.unmount();
});

test('useRewind.clear() frees every buffered snapshot, and so does unmounting', async () => {
    const alloc = installAllocTracker(Raw, {
        types: ['StateRecorderImpl'],
        throwOnDoubleDestroy: true
    });
    try {
        const before = alloc.live();
        let system: PhysicsSystem | undefined;
        let api: UseRewindApi | undefined;

        const renderer = await create(
            scene(
                (s) => (system = s),
                (a) => (api = a)
            )
        );
        assert.isDefined(system);
        assert.isDefined(api);

        for (let i = 0; i < 8; i++) system!.onUpdate(STEP);
        assert.isAbove(alloc.live(), before, 'test setup: nothing was recorded');

        api!.clear();
        assert.equal(alloc.live(), before, 'clear() left buffered snapshots undestroyed');
        assert.equal(api!.getFrameCount(), 0);

        for (let i = 0; i < 3; i++) system!.onUpdate(STEP);
        assert.isAbove(alloc.live(), before, 'test setup: recording did not resume after clear()');

        await renderer.unmount();
        assert.equal(alloc.live(), before, 'unmounting left buffered snapshots undestroyed');
    } finally {
        alloc.uninstall();
    }
});
