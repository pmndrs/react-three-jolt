// Issue #140, the React half: `<VehicleFourWheel>` added a vehicle and never removed it, and the
// `onPreStep` remover it registered was thrown away. Mounting and unmounting therefore left the
// VehicleSystem's two step listeners (and the vehicle's whole constraint graph) behind every time.

import { Physics, useJolt } from '@react-three/jolt';
import { create } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import { assert, test } from 'vitest';
import { VehicleFourWheel } from '../src/components/vehicle/VehicleFourWheel';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AnyPhysicsSystem = { preStepListeners: unknown[]; postStepListeners: unknown[] };

const stepListeners = (system: AnyPhysicsSystem) =>
    system.preStepListeners.length + system.postStepListeners.length;

const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

const Harness = ({
    show,
    onReady
}: {
    show: boolean;
    onReady: (system: AnyPhysicsSystem) => void;
}) => {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem as unknown as AnyPhysicsSystem);
    }, [physicsSystem, onReady]);
    return show ? <VehicleFourWheel /> : null;
};

test('mounting and unmounting <VehicleFourWheel> twice leaves no listeners behind', async () => {
    let system: AnyPhysicsSystem | undefined;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const tree = (show: boolean) => (
        <Physics>
            <Harness show={show} onReady={onReady} />
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    assert.isDefined(system, 'Physics never mounted its children');

    const baseline = stepListeners(system!);

    for (let cycle = 0; cycle < 2; cycle++) {
        await renderer.update(tree(true));
        await settle(() => stepListeners(system!) > baseline);
        // the VehicleSystem registers one pre-step and one post-step listener
        assert.equal(
            stepListeners(system!),
            baseline + 2,
            `cycle ${cycle}: the vehicle system did not register its listeners`
        );

        await renderer.update(tree(false));
        assert.equal(
            stepListeners(system!),
            baseline,
            `cycle ${cycle}: the vehicle system's listeners outlived the component`
        );
    }

    await renderer.unmount();
});
