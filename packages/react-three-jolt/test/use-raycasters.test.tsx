// issue #192: useRaycaster/useAdvancedRaycaster/useMulticaster (hooks/use-raycasters.tsx) only
// destroyed their raycaster on unmount. Whenever the `useMemo` they build it in re-ran because a
// dep (here: `type`) changed, the old instance's Jolt allocations (RRayCast, RayCastSettings,
// filters, collector) were dropped on the floor and a brand new set allocated in their place -
// every type change leaked one raycaster's worth of native memory. useMouseRaycaster (#191)
// already tracked its previous instance and destroyed it before building the next one; this
// applies the same pattern to the three older hooks.
//
// This mounts <Physics> for real (see use-constraint.test.tsx for the pattern) and re-renders the
// harness with a different `type` prop twice via `renderer.update()`, which keeps the same
// PhysicsSystem alive across renders (see physics-props.test.ts's "gravity ... stays reactive"
// test) while forcing useRaycaster's memo to rebuild.
//
// The allocation tracker (test/jolt-alloc.ts) is scoped to the constructor names a Raycaster
// itself allocates, so it isn't tripped up by anything else <Physics>/PhysicsSystem might legally
// keep alive. The assertion is exact equality against "one raycaster's worth" measured while
// exactly one is alive - not just "did not grow" - so both a leak (extra allocations pile up) and
// a double-destroy (live count would undershoot, or the tracker would throw on a repeat destroy
// of the same wrapper) show up as failures.

import { create } from '@react-three/test-renderer';
import { act, useEffect } from 'react';
import { assert, beforeAll, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { useAdvancedRaycaster, useMulticaster, useRaycaster } from '../src/hooks/use-raycasters';
import { initJolt, Raw } from '../src/raw';
import { installAllocTracker } from './jolt-alloc';

// the allocation tracker needs a live Jolt module to wrap; <Physics> loads it lazily (via
// suspense) on first mount, so make sure it is already loaded before any test installs the
// tracker, the same way raycasters.test.ts/collider.test.ts do for their direct-PhysicsSystem
// tests.
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

// Everything a Raycaster's constructor allocates via `new Raw.module.X()` (see raycasters.ts).
// Deliberately narrow: these constructor names are only ever used by Raycaster/AdvancedRaycaster/
// Multicaster, so tracking them can't be confused by unrelated allocations elsewhere in
// <Physics>/PhysicsSystem the way tracking e.g. Vec3/RVec3 (used every frame for body poses)
// could be.
const RAYCASTER_TRACKED_TYPES = [
    'RRayCast',
    'RayCastSettings',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'BodyFilter',
    'ShapeFilter',
    'CastRayClosestHitCollisionCollector',
    'CastRayAnyHitCollisionCollector',
    'CastRayAllHitCollisionCollector'
];

type HarnessProps = {
    type: string;
    hook: 'useRaycaster' | 'useAdvancedRaycaster' | 'useMulticaster';
    onReady: () => void;
};

// Mounts whichever of the three hooks is under test with the given collector `type`. Re-rendering
// with a different `type` (via renderer.update()) changes useRaycaster's/etc.'s memo deps without
// remounting the component, which is exactly the "deps changed, not unmounted" case #192 covers.
const Harness = ({ type, hook, onReady }: HarnessProps) => {
    if (hook === 'useRaycaster') useRaycaster(undefined, undefined, type);
    else if (hook === 'useAdvancedRaycaster') useAdvancedRaycaster(undefined, undefined, type);
    else useMulticaster(undefined, undefined, type);

    useEffect(() => {
        onReady();
    });
    return null;
};

const runsFor = (hook: HarnessProps['hook']) => {
    test(`${hook} destroys the previous instance on every type change instead of leaking it (issue #192)`, async () => {
        let readyCount = 0;
        const tracker = installAllocTracker(Raw, { types: RAYCASTER_TRACKED_TYPES });
        try {
            const renderer = await create(
                <Physics>
                    <Harness type="closest" hook={hook} onReady={() => readyCount++} />
                </Physics>
            );
            await settle(() => readyCount > 0);
            assert.isAbove(readyCount, 0, 'Physics never mounted its children');

            // "one raycaster's worth" of tracked allocations, measured while exactly one is alive
            const oneRaycasterFootprint = tracker.live();
            assert.isAbove(
                oneRaycasterFootprint,
                0,
                'expected the hook to have allocated a raycaster'
            );

            await act(async () => {
                await renderer.update(
                    <Physics>
                        <Harness type="any" hook={hook} onReady={() => readyCount++} />
                    </Physics>
                );
            });
            assert.equal(
                tracker.live(),
                oneRaycasterFootprint,
                'switching type once should destroy the previous raycaster, not accumulate a second one'
            );

            await act(async () => {
                await renderer.update(
                    <Physics>
                        <Harness type="all" hook={hook} onReady={() => readyCount++} />
                    </Physics>
                );
            });
            assert.equal(
                tracker.live(),
                oneRaycasterFootprint,
                'switching type again should still leave exactly one raycaster worth of allocations alive'
            );

            await renderer.unmount();
            assert.equal(tracker.live(), 0, 'unmounting should free the final raycaster too');
        } finally {
            tracker.uninstall();
        }
    });
};

runsFor('useRaycaster');
runsFor('useAdvancedRaycaster');
runsFor('useMulticaster');
