// Issue #22: jolt-physics 1.1.0 ships several WASM build variants (wasm-compat, wasm,
// debug-wasm-compat, asm, the multithread flavours, ...), each exposed as the default export of
// its own entrypoint. `initJolt(factory)` is how `<Physics module={factory}>` selects one. These
// tests pin down the two contracts that make that safe:
//   - a factory is only ever invoked once; a later call with the *same* reference reuses the
//     module instead of spinning up a second one (the old code re-initialised - and leaked - on
//     every call, see raw.ts's history).
//   - swapping to a *different* factory while a Physics world already exists is refused rather
//     than silently reinitialising: every live body/shape/constraint points into the old
//     module's heap, so the old module has to stay alive as long as anything needs it.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { setDebug } from '../src/utils';

// This file's `Raw` module state is private to it (vitest isolates modules per file), so it is
// safe to drive `initJolt` through fake and real modules without touching any other test file.

afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
});

describe('initJolt: factory-based module selection', () => {
    test('calls the provided factory and installs its result as Raw.module', async () => {
        const fakeModule = { destroy: vi.fn() } as any;
        const factory = vi.fn(async () => fakeModule);

        await initJolt(factory);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(Raw.module).toBe(fakeModule);
    });

    test('a repeat call with the same factory reference reuses the module (no second init)', async () => {
        const fakeModule = { destroy: vi.fn() } as any;
        const factory = vi.fn(async () => fakeModule);

        await initJolt(factory);
        await initJolt(factory);
        await initJolt(factory);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(Raw.module).toBe(fakeModule);
    });
});

describe('initJolt: guards a module swap while a Physics world exists', () => {
    let ps: PhysicsSystem | undefined;

    beforeEach(async () => {
        // A real module is required here - PhysicsSystem's constructor calls straight into the
        // WASM API (ObjectLayerPairFilterTable, BroadPhaseLayerInterfaceTable, JoltInterface, ...)
        // to stand up a world, which a fake object can't satisfy.
        const real = (await import('jolt-physics')).default;
        await initJolt(real);
    });

    afterEach(() => {
        if (ps && !ps.destroyed) ps.destroy('raw-module-selection');
        ps = undefined;
    });

    test('a different factory is ignored (with a devWarn) once a world is mounted', async () => {
        ps = new PhysicsSystem('raw-module-selection');
        // sanity: constructing the world really did register an interface, which is the signal
        // initJolt uses to know a world is live.
        expect(Raw.joltInterfaces.size).toBeGreaterThan(0);

        const activeModule = Raw.module;
        const otherFactory = vi.fn(async () => ({ fake: true }) as any);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setDebug(true);

        await initJolt(otherFactory);

        expect(otherFactory).not.toHaveBeenCalled();
        expect(Raw.module).toBe(activeModule);
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('a different factory is allowed once every world has been destroyed', async () => {
        const p = new PhysicsSystem('raw-module-selection');
        p.destroy('raw-module-selection');
        expect(Raw.joltInterfaces.size).toBe(0);

        const otherFactory = vi.fn(async () => ({ fake: true }) as any);
        await initJolt(otherFactory);

        expect(otherFactory).toHaveBeenCalledTimes(1);
        expect(Raw.module).toEqual({ fake: true });

        // restore a real module so any later test in this describe block (or a shared afterEach)
        // never sees the fake object.
        const real = (await import('jolt-physics')).default;
        await initJolt(real);
    });

    test('the world itself is unaffected by a refused swap', () => {
        ps = new PhysicsSystem('raw-module-selection');
        const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 10));
        floor.position.set(0, -1, 0);
        ps.bodySystem.addBody(floor, { bodyType: 'static' });

        expect(() => {
            void initJolt(vi.fn(async () => ({ fake: true }) as any));
        }).not.toThrow();

        for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
        expect(ps.destroyed).toBe(false);
    });
});
