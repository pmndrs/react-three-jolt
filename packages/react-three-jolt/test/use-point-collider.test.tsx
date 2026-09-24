// Issue #248: `useCollidePoint` - the hook wrapper around `PointCollider`, mirroring
// useRaycaster (use-raycasters.ts / test/use-raycasters.test.tsx) including its issue #192 fix:
// destroy the previous instance whenever a memo dep (here: `type`) changes, not just on unmount,
// so switching collector types doesn't leak one PointCollider's worth of native memory per
// switch.

import { create } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { useJolt } from '../src/hooks';
import { useCollidePoint } from '../src/hooks/use-point-collider';
import { initJolt, Raw } from '../src/raw';
import type { PointCollisionResult } from '../src/systems/queries/point-collider';
import { installAllocTracker } from './jolt-alloc';

beforeAll(async () => {
    await initJolt();
});

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

// Everything a PointCollider's constructor allocates via `new Raw.module.X()` (point-collider.ts).
const POINT_COLLIDER_TRACKED_TYPES = [
    'RVec3',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'BodyFilter',
    'ShapeFilter',
    'CollidePointClosestHitCollisionCollector',
    'CollidePointAnyHitCollisionCollector',
    'CollidePointAllHitCollisionCollector'
];

type HarnessProps = { type: 'closest' | 'any' | 'all'; onReady: () => void };

const Harness = ({ type, onReady }: HarnessProps) => {
    const { physicsSystem } = useJolt();
    const bodyCreated = React.useRef(false);
    if (!bodyCreated.current) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
        mesh.position.set(0, 0, 0);
        physicsSystem.bodySystem.addBody(mesh, { bodyType: 'static' });
        bodyCreated.current = true;
    }

    useCollidePoint([0, 0, 0], type);

    useEffect(() => {
        onReady();
    });
    return null;
};

test('useCollidePoint destroys the previous instance on every type change instead of leaking it', async () => {
    let readyCount = 0;
    const tracker = installAllocTracker(Raw, { types: POINT_COLLIDER_TRACKED_TYPES });
    try {
        const renderer = await create(
            <Physics>
                <Harness type="closest" onReady={() => readyCount++} />
            </Physics>
        );
        await settle(() => readyCount > 0);
        assert.isAbove(readyCount, 0, 'Physics never mounted its children');

        const oneColliderFootprint = tracker.live();
        assert.isAbove(oneColliderFootprint, 0, 'expected the hook to have allocated a collider');

        await act(async () => {
            await renderer.update(
                <Physics>
                    <Harness type="any" onReady={() => readyCount++} />
                </Physics>
            );
        });
        assert.equal(
            tracker.live(),
            oneColliderFootprint,
            'switching type once should destroy the previous collider, not accumulate a second one'
        );

        await act(async () => {
            await renderer.update(
                <Physics>
                    <Harness type="all" onReady={() => readyCount++} />
                </Physics>
            );
        });
        assert.equal(
            tracker.live(),
            oneColliderFootprint,
            'switching type again should still leave exactly one collider worth of allocations alive'
        );

        await renderer.unmount();
        assert.equal(tracker.live(), 0, 'unmounting should free the final collider too');
    } finally {
        tracker.uninstall();
    }
});

test('useCollidePoint finds a body at the given point', async () => {
    let result: PointCollisionResult | PointCollisionResult[] | false | undefined;

    const ProbeHarness = () => {
        const { physicsSystem } = useJolt();
        const bodyCreated = React.useRef(false);
        if (!bodyCreated.current) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
            mesh.position.set(0, 0, 0);
            physicsSystem.bodySystem.addBody(mesh, { bodyType: 'static' });
            bodyCreated.current = true;
        }

        const collider = useCollidePoint([0, 0, 0]);
        useEffect(() => {
            result = collider.cast();
        }, [collider]);
        return null;
    };

    const renderer = await create(
        <Physics>
            <ProbeHarness />
        </Physics>
    );
    await settle(() => result !== undefined);

    assert.notEqual(result, false, 'useCollidePoint did not find the body at the origin');

    await renderer.unmount();
});
