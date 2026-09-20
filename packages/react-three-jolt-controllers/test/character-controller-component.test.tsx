// Issue #138, the React half: `<CharacterController>`'s unmount effect already called
// `destroy()`, but `destroy()` was a stub and the pre-step listener it registered was an inline
// arrow that `removeStepListener` (identity based) could never find. Mounting and unmounting the
// component therefore left one dead listener per mount stepping a freed CharacterVirtual.

import { Physics, useJolt } from '@react-three/jolt';
import { create } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import { assert, test } from 'vitest';
import { CharacterController } from '../src/components/CharacterController';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AnyPhysicsSystem = { preStepListeners: unknown[]; postStepListeners: unknown[] };

const stepListeners = (system: AnyPhysicsSystem) =>
    system.preStepListeners.length + system.postStepListeners.length;

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
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
    return show ? <CharacterController /> : null;
};

test('mounting and unmounting <CharacterController> twice leaves no listeners behind', async () => {
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
        assert.equal(
            stepListeners(system!),
            baseline + 1,
            `cycle ${cycle}: the controller did not register exactly one step listener`
        );

        await renderer.update(tree(false));
        assert.equal(
            stepListeners(system!),
            baseline,
            `cycle ${cycle}: the controller's step listener outlived the component`
        );
    }

    await renderer.unmount();
});
