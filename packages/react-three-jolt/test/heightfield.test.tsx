// Regression coverage for #152: <Heightfield>'s image-loading effect used to be a bare async
// function with no cancellation, so a superseded (or post-unmount) load could still win the race
// and create/leak a jolt body. We mock the actual heightmap loader (`applyHeightmapToPlane`) so
// we can resolve loads in an arbitrary order deterministically, and drei's `useTexture` so the
// display-texture path never needs a real network/image load in this environment. Everything
// downstream of the mock -- the cancellation guard and the real `BodySystem.addHeightfield` /
// `removeBody` calls -- runs for real against the real jolt-physics wasm module.
import { create, waitFor } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import type * as THREE from 'three';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Heightfield } from '../src/components/Heightfield';
import { Physics } from '../src/components/Physics';
import { useJolt } from '../src/hooks';
import { initJolt } from '../src/raw';
import type { BodySystem } from '../src/systems/body-system';
import { setDebug } from '../src/utils';

vi.mock('@react-three/drei', () => ({
    useTexture: vi.fn(() => ({}))
}));

// Only the image loader is mocked. The rest of the module is real, because the shape pipeline
// imports `getValidatedHeightfieldSampleCount` from here to check the grid it is handed.
vi.mock('../src/heightfield/generators', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/heightfield/generators')>()),
    applyHeightmapToPlane: vi.fn()
}));

import { applyHeightmapToPlane } from '../src/heightfield/generators';

const mockApplyHeightmapToPlane = vi.mocked(applyHeightmapToPlane);

// <Physics> suspends on `suspend(() => initJolt(), ['jolt'])` while the real jolt-physics wasm
// module loads. @react-three/test-renderer's `create()` only flushes synchronous/microtask work
// inside its `act()` call, not a genuinely-async first load, so a cold load here would resolve
// *after* create() already returned (observed as "a suspended resource finished loading...not
// wrapped in act(...)" and a `<Physics>` that never finishes mounting). Pre-resolving the load
// and seeding suspend-react's cache under the same key before any test renders means `suspend()`
// always finds an already-resolved entry and returns synchronously instead of throwing.
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function totalBodyCount(bodySystem: BodySystem) {
    return (
        bodySystem.dynamicBodies.size +
        bodySystem.staticBodies.size +
        bodySystem.kinematicBodies.size
    );
}

// Grabs the live BodySystem out of the Physics context so the tests can assert on real body
// counts without reaching into Heightfield internals.
function BodySystemCapture({ onReady }: { onReady: (bodySystem: BodySystem) => void }) {
    const { bodySystem } = useJolt();
    React.useEffect(() => {
        onReady(bodySystem);
    }, [bodySystem, onReady]);
    return null;
}

beforeEach(() => {
    mockApplyHeightmapToPlane.mockReset();
});

test('a superseded load never creates a body: only the latest url wins, exactly one body exists', async () => {
    let bodySystem: BodySystem | undefined;
    const captureBodySystem = (bs: BodySystem) => {
        bodySystem = bs;
    };

    const first = deferred<void>();
    const second = deferred<void>();
    mockApplyHeightmapToPlane.mockImplementationOnce(() => first.promise);
    mockApplyHeightmapToPlane.mockImplementationOnce(() => second.promise);

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield url="/heightmaps/a.png" size={64} />
        </Physics>
    );

    await waitFor(() => !!bodySystem);
    expect(bodySystem).toBeDefined();

    // Spy on the real body-creation call so we can tell "only the latest url won" apart from the
    // pre-fix bug, which also nets out to a body count of 1 -- it just removes-then-recreates a
    // *second* body from whichever load happens to resolve last (see #152). The fix must call
    // addHeightfield exactly once: the cancelled load's `.then` must never reach it at all.
    const addHeightfieldSpy = vi.spyOn(bodySystem!, 'addHeightfield');

    // change the url before the first load resolves -- this is the race from #152
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield url="/heightmaps/b.png" size={64} />
        </Physics>
    );

    expect(mockApplyHeightmapToPlane).toHaveBeenCalledTimes(2);

    // resolve out of order: the superseded (a.png) load finishes LAST
    second.resolve();
    await waitFor(() => totalBodyCount(bodySystem!) === 1);
    first.resolve();
    // give the (already-cancelled) first load's `.then` a chance to run, in case it wrongly
    // creates a second body
    await Promise.resolve();
    await Promise.resolve();

    expect(totalBodyCount(bodySystem!)).toBe(1);
    expect(addHeightfieldSpy).toHaveBeenCalledTimes(1);

    // dropping the component removes the body it owns (same cleanup path a url change or
    // unmount takes)
    const removeBodySpy = vi.spyOn(bodySystem!, 'removeBody');
    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
        </Physics>
    );
    expect(removeBodySpy).toHaveBeenCalledTimes(1);
    expect(totalBodyCount(bodySystem!)).toBe(0);

    await renderer.unmount();
});

test('rejected loads are reported once and never create a body', async () => {
    let bodySystem: BodySystem | undefined;
    const captureBodySystem = (bs: BodySystem) => {
        bodySystem = bs;
    };
    // <Heightfield> reports the failure through `devWarn`, which stays silent until a consumer
    // opts in with `setDebug(true)` - so the spy only sees anything with debug output enabled.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDebug(true);

    const failing = deferred<void>();
    mockApplyHeightmapToPlane.mockImplementationOnce(() => failing.promise);

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield url="/heightmaps/broken.png" size={64} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);

    failing.reject(new Error('failed to decode'));
    await waitFor(() => warnSpy.mock.calls.length > 0);

    expect(totalBodyCount(bodySystem!)).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    setDebug(false);
    warnSpy.mockRestore();
    await renderer.unmount();
});

test('unmounting mid-load creates no body and does not warn', async () => {
    let bodySystem: BodySystem | undefined;
    const captureBodySystem = (bs: BodySystem) => {
        bodySystem = bs;
    };
    // debug output ON, so "does not warn" means the abort guard really suppressed the report
    // rather than `devWarn` simply being gated off.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDebug(true);

    const pending = deferred<void>();
    mockApplyHeightmapToPlane.mockImplementationOnce(() => pending.promise);

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield url="/heightmaps/c.png" size={64} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);

    await renderer.unmount();
    // resolve after unmount -- the stale load must not touch bodySystem at all
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(totalBodyCount(bodySystem!)).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();

    setDebug(false);
    warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Generation (#45): `samples` and `generator` need no image, no loader and no await - the
// body exists as soon as the component has mounted.
test('a generated heightfield creates its body synchronously, without loading anything', async () => {
    let bodySystem: BodySystem | undefined;
    const captureBodySystem = (bs: BodySystem) => {
        bodySystem = bs;
    };
    const { generateHeightfield } = await import('../src/heightfield');
    const { samples } = generateHeightfield({ size: 16, seed: 3 });

    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield samples={samples} size={16} scale={[2, 10, 2]} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);

    expect(totalBodyCount(bodySystem!)).toBe(1);
    // the image loader was never involved
    expect(mockApplyHeightmapToPlane).not.toHaveBeenCalled();

    await renderer.update(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
        </Physics>
    );
    expect(totalBodyCount(bodySystem!)).toBe(0);
    await renderer.unmount();
});

test('a generator callback fills the mesh the physics body is built from', async () => {
    let bodySystem: BodySystem | undefined;
    const captureBodySystem = (bs: BodySystem) => {
        bodySystem = bs;
    };
    // a ramp: height rises with z
    const renderer = await create(
        <Physics>
            <BodySystemCapture onReady={captureBodySystem} />
            <Heightfield generator={(_x, z) => z * 0.5} size={16} />
        </Physics>
    );
    await waitFor(() => !!bodySystem);
    expect(totalBodyCount(bodySystem!)).toBe(1);

    const [field] = [...bodySystem!.staticBodies.values()];
    const geometry = (field.object as THREE.Mesh).geometry;
    const positions = geometry.attributes.position.array as Float32Array;
    // first vertex is the -z corner (z = -7.5), last is the +z one
    expect(positions[1]).toBeCloseTo(-7.5 * 0.5, 4);
    expect(positions[positions.length - 2]).toBeCloseTo(7.5 * 0.5, 4);

    await renderer.unmount();
});
