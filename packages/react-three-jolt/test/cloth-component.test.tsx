// <Cloth> / <Balloon> (issue #244), mounted through @react-three/test-renderer against the real
// jolt-physics wasm module - the component wiring on top of the system-level behavior already
// covered in test/cloth.test.ts and test/soft-body.test.ts.
import { create } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import { assert, beforeAll, expect, test } from 'vitest';
import { Balloon } from '../src/components/Balloon';
import { Cloth } from '../src/components/Cloth';
import { Physics } from '../src/components/Physics';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { PhysicsSystem } from '../src/systems/physics-system';
import type { SoftBodyState } from '../src/systems/soft-body-system';

beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

test('<Cloth> builds a soft body from a generated plane, pinned="top" by default', async () => {
    const ref = React.createRef<SoftBodyState | undefined>();
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture onSystem={(s) => (system = s)} />
            <Cloth
                ref={ref}
                width={2}
                height={2}
                segmentsX={4}
                segmentsY={4}
                position={[0, 5, 0]}
            />
        </Physics>
    );

    assert.isOk(ref.current, '<Cloth> never produced a SoftBodyState');
    assert.isOk(system, 'the world never mounted');
    expect(system!.softBodySystem.bodies.size).toBe(1);
    // a 4-segment plane has 5*5 = 25 vertices
    expect(ref.current!.vertexCount).toBe(25);

    for (let i = 0; i < 30; i++) system!.onUpdate(1 / 60);
    // pinned at the top, unaffected by anything else here - the object itself still exists and
    // didn't error out simulating
    expect(ref.current!.disposed).toBe(false);

    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(system!.softBodySystem.bodies.size).toBe(0);
});

test('<Cloth pinned="corners"> mounts and simulates without error', async () => {
    const ref = React.createRef<SoftBodyState | undefined>();
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture onSystem={(s) => (system = s)} />
            <Cloth ref={ref} width={2} height={2} segmentsX={4} segmentsY={4} pinned="corners" />
        </Physics>
    );

    assert.isOk(ref.current);
    // The exact "which vertices got pinned" behavior for 'corners' is covered against the raw
    // system in test/cloth.test.ts; this just exercises the prop end to end through the
    // component and confirms it doesn't error out simulating.
    for (let i = 0; i < 10; i++) system!.onUpdate(1 / 60);
    expect(ref.current!.disposed).toBe(false);

    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
});

test('<Cloth pinned={[0]}> accepts an explicit index array', async () => {
    const ref = React.createRef<SoftBodyState | undefined>();

    const renderer = await create(
        <Physics>
            <Cloth ref={ref} width={2} height={2} segmentsX={2} segmentsY={2} pinned={[0]} />
        </Physics>
    );

    assert.isOk(ref.current);
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
});

test('<Balloon> builds a pressurized sphere soft body and it falls under gravity', async () => {
    const ref = React.createRef<SoftBodyState | undefined>();
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture onSystem={(s) => (system = s)} />
            <Balloon
                ref={ref}
                radius={1}
                widthSegments={8}
                heightSegments={6}
                position={[0, 5, 0]}
            />
        </Physics>
    );

    assert.isOk(ref.current, '<Balloon> never produced a SoftBodyState');
    assert.isOk(system);
    expect(system!.softBodySystem.bodies.size).toBe(1);

    for (let i = 0; i < 30; i++) system!.onUpdate(1 / 60);
    expect(ref.current!.object.position.y).toBeLessThan(5);

    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(system!.softBodySystem.bodies.size).toBe(0);
});

test('unmounting <Cloth>/<Balloon> frees the WASM heap they used', async () => {
    const jolt = Raw.module;
    const before = jolt.JoltInterface.prototype.sGetFreeMemory();

    const renderer = await create(
        <Physics>
            <Cloth width={2} height={2} segmentsX={4} segmentsY={4} position={[0, 5, 0]} />
            <Balloon radius={0.5} widthSegments={8} heightSegments={6} position={[3, 5, 0]} />
        </Physics>
    );
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = jolt.JoltInterface.prototype.sGetFreeMemory();
    assert.isAtLeast(after, before - 256, `leaked ${before - after} bytes of WASM heap`);
});
