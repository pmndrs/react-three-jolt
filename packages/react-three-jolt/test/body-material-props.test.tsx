// Issue #198: `<RigidBody friction>` was declared in the props type and read by nothing, so the
// prop silently did nothing. Same story for the other physics material properties. These mount
// the real component against the real wasm module with @react-three/test-renderer.
import { create } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { Shape } from '../src/components/shape/Shape';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';

// <Physics> suspends on the (async) wasm load; pre-resolving it lets create() mount synchronously
// inside act(). See shape-component.test.tsx.
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function tree(props: Record<string, unknown>, ref: React.RefObject<BodyState | null>) {
    return (
        <Physics>
            <RigidBody ref={ref} position={[0, 5, 0]} {...props}>
                <mesh>
                    <boxGeometry args={[1, 1, 1]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
}

test('<RigidBody friction> reaches the body and stays reactive', async () => {
    const body = React.createRef<BodyState>();
    const renderer = await create(tree({ friction: 0.9 }, body));

    assert.isNotNull(body.current, '<RigidBody> never produced a body');
    assert.closeTo(body.current!.body.GetFriction(), 0.9, 1e-6, 'the friction prop was dropped');

    await renderer.update(tree({ friction: 0.1 }, body));
    assert.closeTo(body.current!.body.GetFriction(), 0.1, 1e-6, 'friction did not stay reactive');

    // 0 is a real value (ice), not "unset"
    await renderer.update(tree({ friction: 0 }, body));
    assert.closeTo(body.current!.body.GetFriction(), 0, 1e-6, 'friction={0} was treated as unset');

    await renderer.unmount();
});

test('<RigidBody restitution / damping / gravityFactor> reach the body', async () => {
    const body = React.createRef<BodyState>();
    const renderer = await create(
        tree(
            {
                restitution: 0.75,
                linearDamping: 0.3,
                angularDamping: 0.4,
                gravityFactor: 0
            },
            body
        )
    );

    const state = body.current!;
    assert.closeTo(state.body.GetRestitution(), 0.75, 1e-6, 'the restitution prop was dropped');
    assert.closeTo(state.linearDamping, 0.3, 1e-6, 'the linearDamping prop was dropped');
    assert.closeTo(state.angularDamping, 0.4, 1e-6, 'the angularDamping prop was dropped');
    assert.closeTo(state.gravityFactor, 0, 1e-6, 'the gravityFactor prop was dropped');

    await renderer.update(tree({ restitution: 0.2, gravityFactor: 2 }, body));
    assert.closeTo(state.body.GetRestitution(), 0.2, 1e-6, 'restitution did not stay reactive');
    assert.closeTo(state.gravityFactor, 2, 1e-6, 'gravityFactor did not stay reactive');

    await renderer.unmount();
});

test('the material props reach a body created behind a <Shape> child', async () => {
    // A <RigidBody> with <Shape> children has no body at all on the first pass - it waits for the
    // shape to mount. The old effect was keyed on the (non-reactive) ref, so it ran once, before
    // the body existed, and never again: every property it set was dropped on the floor.
    const body = React.createRef<BodyState>();
    const renderer = await create(
        <Physics>
            <RigidBody ref={body} position={[0, 5, 0]} friction={0.8} restitution={0.5}>
                <Shape type="sphere" radius={1} />
            </RigidBody>
        </Physics>
    );

    assert.isNotNull(body.current, 'the <Shape> body was never created');
    assert.closeTo(body.current!.body.GetFriction(), 0.8, 1e-6, 'friction never reached the body');
    assert.closeTo(body.current!.body.GetRestitution(), 0.5, 1e-6);

    await renderer.unmount();
});
