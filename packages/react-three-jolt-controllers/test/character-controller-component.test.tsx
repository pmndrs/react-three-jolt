// Issue #138, the React half: `<CharacterController>`'s unmount effect already called
// `destroy()`, but `destroy()` was a stub and the pre-step listener it registered was an inline
// arrow that `removeStepListener` (identity based) could never find. Mounting and unmounting the
// component therefore left one dead listener per mount stepping a freed CharacterVirtual.

import { Physics, type PhysicsSystem, Raw, RigidBody, useJolt } from '@react-three/jolt';
import { create } from '@react-three/test-renderer';
import React, { act, useEffect } from 'react';
import { assert, test } from 'vitest';
import { CharacterController } from '../src/components/CharacterController';
import type { CharacterControllerSystem } from '../src/systems/character-controller';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Step callbacks moved from the private `preStepListeners`/`postStepListeners` arrays onto the
// world Emitter (issue #187). `listenerCount` is the supported way to ask, and is still the
// whole point of these tests: that unsubscribing actually happened.
type AnyPhysicsSystem = PhysicsSystem;

const stepListeners = (system: AnyPhysicsSystem) =>
    system.events.listenerCount('beforeStep') + system.events.listenerCount('afterStep');

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

const Harness = ({
    show,
    onReady,
    ...props
}: {
    show: boolean;
    onReady: (system: AnyPhysicsSystem) => void;
    [key: string]: unknown;
}) => {
    const { physicsSystem } = useJolt();
    useEffect(() => {
        onReady(physicsSystem as unknown as AnyPhysicsSystem);
    }, [physicsSystem, onReady]);
    return show ? <CharacterController {...props} /> : null;
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

// Issues #79/#80: the event props are effects keyed on the controller instance, so they have to
// register on the pass that creates it - the same trap `<RigidBody on*>` fell into (#32).
test('<CharacterController onGround onLand> registers and unregisters with the component', async () => {
    let system: AnyPhysicsSystem | undefined;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const log: string[] = [];
    // the controller spawns at the origin, so it needs something under it to land on
    const tree = (show: boolean) => (
        <Physics>
            <RigidBody type="static" position={[0, -2, 0]}>
                <mesh>
                    <boxGeometry args={[200, 1, 200]} />
                </mesh>
            </RigidBody>
            <Harness
                show={show}
                onReady={onReady}
                onGround={() => log.push('ground')}
                onLand={() => log.push('land')}
                onMove={() => log.push('move')}
            />
        </Physics>
    );

    const renderer = await create(tree(false));
    await settle(() => system !== undefined);
    assert.isDefined(system);

    await renderer.update(tree(true));
    await settle(() => stepListeners(system!) > 0);

    await act(async () => {
        for (let i = 0; i < 200 && !log.includes('land'); i++) system!.onUpdate(1 / 60);
    });
    assert.include(log, 'ground', 'onGround never fired');
    assert.include(log, 'land', 'onLand never fired');

    const before = log.length;
    await renderer.update(tree(false));
    await act(async () => {
        for (let i = 0; i < 60; i++) system!.onUpdate(1 / 60);
    });
    assert.equal(log.length, before, 'a handler outlived the component');

    await renderer.unmount();
});

// Issue #212: `radius`/`height`/`position` were accepted but `setCapsule` was commented out and
// `position` only ever offset the rendered child object3D relative to the character, never the
// actual `CharacterVirtual`. All three now reach the real Jolt object.
test('<CharacterController radius height position> reach the CharacterVirtual', async () => {
    let system: AnyPhysicsSystem | undefined;
    const onReady = (s: AnyPhysicsSystem) => {
        system = s;
    };
    const ccRef = React.createRef<CharacterControllerSystem>();

    const Harness2 = ({
        onReady: ready,
        ...props
    }: {
        onReady: (system: AnyPhysicsSystem) => void;
        [key: string]: unknown;
    }) => {
        const { physicsSystem } = useJolt();
        useEffect(() => {
            ready(physicsSystem as unknown as AnyPhysicsSystem);
        }, [physicsSystem, ready]);
        return <CharacterController ref={ccRef} {...props} />;
    };

    const renderer = await create(
        <Physics>
            <Harness2 onReady={onReady} radius={0.6} height={1.8} position={[3, 7, -2]} />
        </Physics>
    );
    await settle(() => system !== undefined && ccRef.current !== null);
    assert.isDefined(system, 'Physics never mounted its children');
    assert.isNotNull(ccRef.current, 'the ref was never assigned');

    const cc = ccRef.current!;
    // capsule dimensions reached setCapsule()
    assert.equal(cc.characterRadiusStanding, 0.6, 'radius never reached the capsule');
    assert.equal(cc.characterHeightStanding, 1.8, 'height never reached the capsule');

    // the shape actually set on the CharacterVirtual is a capsule of that radius/half-height,
    // wrapped in a RotatedTranslatedShape so the character's origin sits at its feet
    const outer = Raw.module.castObject(cc.shape, Raw.module.RotatedTranslatedShape);
    const inner = Raw.module.castObject(outer.GetInnerShape(), Raw.module.CapsuleShape);
    assert.closeTo(inner.GetRadius(), 0.6, 1e-5, 'the capsule shape radius does not match');
    assert.closeTo(
        inner.GetHalfHeightOfCylinder(),
        0.9, // setCapsule() passes 0.5 * height as CapsuleShapeSettings' half-height-of-cylinder
        1e-5,
        'the capsule shape height does not match'
    );

    // position reached the CharacterVirtual, not just a local offset on the child object3D
    assert.closeTo(cc.position.x, 3, 1e-5, 'position.x never reached the character');
    assert.closeTo(cc.position.y, 7, 1e-5, 'position.y never reached the character');
    assert.closeTo(cc.position.z, -2, 1e-5, 'position.z never reached the character');

    await renderer.unmount();
});
