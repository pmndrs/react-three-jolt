// <SoftBody> (issue #243), mounted through @react-three/test-renderer against the real
// jolt-physics wasm module - the component wiring on top of the system-level behavior already
// covered in soft-body.test.ts.
import { create } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import { assert, beforeAll, expect, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { SoftBody } from '../src/components/SoftBody';
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

test('<SoftBody> creates a body from its mesh child and the ref resolves to a SoftBodyState', async () => {
    const ref = React.createRef<SoftBodyState | undefined>();
    let system: PhysicsSystem | undefined;

    const renderer = await create(
        <Physics>
            <Capture onSystem={(s) => (system = s)} />
            <SoftBody ref={ref} pressure={500}>
                <mesh position={[0, 5, 0]}>
                    <sphereGeometry args={[1, 8, 6]} />
                </mesh>
            </SoftBody>
        </Physics>
    );

    assert.isOk(ref.current, '<SoftBody> never produced a SoftBodyState');
    assert.isOk(system, 'the world never mounted');
    expect(system!.softBodySystem.bodies.size).toBe(1);
    expect(ref.current!.object.geometry.index).not.toBeNull();

    for (let i = 0; i < 30; i++) system!.onUpdate(1 / 60);
    expect(ref.current!.object.position.y).toBeLessThan(5);

    await renderer.unmount();
    // <Physics> defers world teardown to a microtask so children clean up first
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(system!.softBodySystem.bodies.size).toBe(0);
    expect(system!.destroyed).toBe(true);
});

test('unmounting frees the WASM heap the soft body used', async () => {
    const jolt = Raw.module;
    const before = jolt.JoltInterface.prototype.sGetFreeMemory();

    const renderer = await create(
        <Physics>
            <SoftBody pressure={500}>
                <mesh position={[0, 5, 0]}>
                    <sphereGeometry args={[1, 8, 6]} />
                </mesh>
            </SoftBody>
        </Physics>
    );
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = jolt.JoltInterface.prototype.sGetFreeMemory();
    assert.isAtLeast(after, before - 256, `leaked ${before - after} bytes of WASM heap`);
});
