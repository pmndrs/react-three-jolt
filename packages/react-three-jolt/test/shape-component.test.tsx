// <Shape> against the real wasm module (issues #107 and #151).
//
// The component used to run its shape-building effect with `[type]` as the only dependency, so
// changing `size`/`radius`/`height` did nothing, and it had no cleanup at all, so every shape it
// ever built - and every shape it replaced - leaked. These tests mount it for real, change a
// size prop, and check that the shape is replaced exactly once and that the old one is released.
//
// Reference counting is what makes "released" observable: the harness takes its own AddRef() on
// every shape <Shape> hands to the rigid body, so a shape the component released is still alive
// for the test to inspect, with a reference count of exactly 1 (ours).
import { create } from '@react-three/test-renderer';
import type Jolt from 'jolt-physics';
import React from 'react';
import { preload } from 'suspend-react';
import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { Physics } from '../src/components/Physics';
import { RigidBody, rigidBodyContext } from '../src/components/RigidBody';
import { Shape, type ShapeProps } from '../src/components/shape/Shape';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';

// <Physics> suspends on `suspend(() => initJolt(), ['jolt'])`; pre-resolving the load and
// seeding suspend-react's cache makes it mount synchronously inside act(). See heightfield.test.
beforeAll(async () => {
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Every shape the component published, each with one extra reference held by the test. */
type ShapeLog = {
    shapes: Jolt.Shape[];
    onShape: (shape: Jolt.Shape | undefined) => void;
    release: () => void;
};

const shapeLog = (): ShapeLog => {
    const shapes: Jolt.Shape[] = [];
    return {
        shapes,
        onShape: (shape) => {
            if (!shape || shapes[shapes.length - 1] === shape) return;
            // keep it alive past the component's own Release so the test can look at it
            shape.AddRef();
            shapes.push(shape);
        },
        release: () => {
            for (const shape of shapes) shape.Release();
            shapes.length = 0;
        }
    };
};

const Harness = ({
    log,
    onNotify,
    ...props
}: ShapeProps & { log: ShapeLog; onNotify?: () => void }) => (
    <rigidBodyContext.Provider
        value={
            {
                body: undefined,
                type: undefined,
                position: undefined,
                rotation: undefined,
                scale: undefined,
                quaternion: undefined,
                setActiveShape: log.onShape,
                notifyShapeChanged: onNotify
            } as any
        }
    >
        <Shape {...props} />
    </rigidBodyContext.Provider>
);

const boundsSize = (shape: Jolt.Shape) => {
    const box = shape.GetLocalBounds();
    return [
        box.mMax.GetX() - box.mMin.GetX(),
        box.mMax.GetY() - box.mMin.GetY(),
        box.mMax.GetZ() - box.mMin.GetZ()
    ];
};

describe('<Shape>', () => {
    test('changing a size prop replaces the shape exactly once and releases the old one', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log} size={[1, 1, 1]} />
            </Physics>
        );

        assert.equal(log.shapes.length, 1, '<Shape> never produced a shape');
        const first = log.shapes[0];
        assert.equal(first.GetSubType(), Raw.module.EShapeSubType_Box);
        expect(boundsSize(first).map(Math.round)).toEqual([1, 1, 1]);
        // the component's reference plus ours
        assert.equal(first.GetRefCount(), 2);

        await renderer.update(
            <Physics>
                <Harness log={log} size={[2, 4, 6]} />
            </Physics>
        );

        assert.equal(log.shapes.length, 2, 'the shape was not replaced exactly once');
        const second = log.shapes[1];
        expect(boundsSize(second).map(Math.round)).toEqual([2, 4, 6]);
        assert.equal(second.GetRefCount(), 2);
        // #151: the superseded shape used to be kept alive forever
        assert.equal(first.GetRefCount(), 1, 'the old shape was not released');

        await renderer.unmount();
        assert.equal(second.GetRefCount(), 1, 'unmounting did not release the current shape');
        log.release();
    });

    test('re-rendering with equal props does not rebuild the shape', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log} type="sphere" radius={2} />
            </Physics>
        );
        assert.equal(log.shapes[0].GetSubType(), Raw.module.EShapeSubType_Sphere);

        // a new array/object identity with the same values must not churn the shape
        await renderer.update(
            <Physics>
                <Harness log={log} type="sphere" radius={2} position={[0, 0, 0]} />
            </Physics>
        );
        assert.equal(log.shapes.length, 1, 'an unchanged <Shape> rebuilt its shape');

        await renderer.unmount();
        log.release();
    });

    test('changing the type rebuilds the shape', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log} type="box" size={[1, 1, 1]} />
            </Physics>
        );
        await renderer.update(
            <Physics>
                <Harness log={log} type="capsule" radius={0.5} height={2} />
            </Physics>
        );

        assert.equal(log.shapes.length, 2);
        assert.equal(log.shapes[1].GetSubType(), Raw.module.EShapeSubType_Capsule);
        assert.equal(log.shapes[0].GetRefCount(), 1, 'the box was not released');

        await renderer.unmount();
        log.release();
    });

    test('a scale prop wraps the shape in a ScaledShape, and changing it re-wraps once', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log} size={[1, 1, 1]} scale={[2, 2, 2]} />
            </Physics>
        );

        assert.equal(log.shapes.length, 1);
        const scaled = log.shapes[0];
        assert.equal(scaled.GetSubType(), Raw.module.EShapeSubType_Scaled);
        expect(boundsSize(scaled).map(Math.round)).toEqual([2, 2, 2]);

        await renderer.update(
            <Physics>
                <Harness log={log} size={[1, 1, 1]} scale={[4, 4, 4]} />
            </Physics>
        );

        assert.equal(log.shapes.length, 2, 'the scaled shape was not replaced exactly once');
        expect(boundsSize(log.shapes[1]).map(Math.round)).toEqual([4, 4, 4]);
        assert.equal(scaled.GetRefCount(), 1, 'the old ScaledShape was not released');

        await renderer.unmount();
        log.release();
    });

    test('nested <Shape>s become a compound, and a child prop change rebuilds it once', async () => {
        const log = shapeLog();
        const tree = (childSize: number[]) => (
            <Physics>
                <Harness log={log}>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={childSize} position={[0, -1, 0]} />
                </Harness>
            </Physics>
        );

        const renderer = await create(tree([1, 1, 1]));

        assert.equal(log.shapes.length, 1, 'the compound was built more than once');
        const compound = log.shapes[0];
        assert.equal(compound.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        assert.equal(
            Raw.module.castObject(compound, Raw.module.StaticCompoundShape).GetNumSubShapes(),
            2
        );

        await renderer.update(tree([3, 1, 1]));
        assert.equal(log.shapes.length, 2, 'a child change did not rebuild the compound');
        assert.isAbove(boundsSize(log.shapes[1])[0], boundsSize(compound)[0]);
        assert.equal(compound.GetRefCount(), 1, 'the old compound was not released');

        await renderer.unmount();
        log.release();
    });

    test('removing a child rebuilds the compound without it', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log}>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                </Harness>
            </Physics>
        );
        const compound = log.shapes[0];
        assert.equal(compound.GetSubType(), Raw.module.EShapeSubType_StaticCompound);

        await renderer.update(
            <Physics>
                <Harness log={log}>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                </Harness>
            </Physics>
        );

        assert.equal(log.shapes.length, 2, 'dropping a child did not rebuild the compound');
        // jolt collapses a single child compound into that child - here into a
        // RotatedTranslatedShape, because the remaining child sits at y = 1
        assert.equal(log.shapes[1].GetSubType(), Raw.module.EShapeSubType_RotatedTranslated);
        assert.equal(compound.GetRefCount(), 1, 'the old compound was not released');

        await renderer.unmount();
        log.release();
    });

    test('a StrictMode mount does not leave a second shape behind', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <React.StrictMode>
                    <Harness log={log} size={[1, 1, 1]} />
                </React.StrictMode>
            </Physics>
        );

        assert.equal(log.shapes.length, 1, 'StrictMode built the shape twice');
        const shape = log.shapes[0];
        assert.equal(shape.GetRefCount(), 2, 'the component owns more than one reference');

        await renderer.unmount();
        assert.equal(shape.GetRefCount(), 1, 'unmounting did not release the shape');
        log.release();
    });
});

//* <Shape dynamic> - mutable compounds (issue #108) ========
// The point of `dynamic` is that a child mounting, unmounting or moving edits the compound the
// body already holds instead of building a new one: the shape object identity must NOT change,
// and jolt's own AddShape/RemoveShape/ModifyShape must be the things that ran.
const spyOnCompound = () => {
    const prototype = Raw.module.MutableCompoundShape.prototype as any;
    return {
        add: vi.spyOn(prototype, 'AddShape'),
        remove: vi.spyOn(prototype, 'RemoveShape'),
        modify: vi.spyOn(prototype, 'ModifyShape'),
        adjust: vi.spyOn(prototype, 'AdjustCenterOfMass'),
        restore: () => vi.restoreAllMocks()
    };
};

const subShapeCount = (shape: Jolt.Shape) =>
    Raw.module.castObject(shape, Raw.module.CompoundShape).GetNumSubShapes();

describe('<Shape dynamic>', () => {
    test('nested children build a MutableCompoundShape, not a static one', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log} dynamic>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                </Harness>
            </Physics>
        );

        assert.equal(log.shapes.length, 1);
        assert.equal(log.shapes[0].GetSubType(), Raw.module.EShapeSubType_MutableCompound);
        assert.equal(subShapeCount(log.shapes[0]), 2);

        await renderer.unmount();
        log.release();
    });

    test('adding a child edits the live compound instead of rebuilding it', async () => {
        const log = shapeLog();
        const notify = vi.fn();
        const renderer = await create(
            <Physics>
                <Harness log={log} onNotify={notify} dynamic>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                </Harness>
            </Physics>
        );
        const compound = log.shapes[0];
        const spies = spyOnCompound();

        try {
            await renderer.update(
                <Physics>
                    <Harness log={log} onNotify={notify} dynamic>
                        <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                        <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                        <Shape type="sphere" radius={0.5} position={[0, 4, 0]} />
                    </Harness>
                </Physics>
            );

            expect(spies.add).toHaveBeenCalledTimes(1);
            expect(spies.adjust).toHaveBeenCalled();
            assert.equal(log.shapes.length, 1, 'the compound was rebuilt instead of edited');
            assert.equal(subShapeCount(compound), 3, 'the new child never reached jolt');
            // the sphere sits 4 above the middle box: the compound is taller now
            assert.isAbove(boundsSize(compound)[1], 4);
            // the body has to be told, or it keeps the bounds it was created with
            expect(notify).toHaveBeenCalled();
        } finally {
            spies.restore();
        }

        await renderer.unmount();
        log.release();
    });

    test('removing a child edits the live compound instead of rebuilding it', async () => {
        const log = shapeLog();
        const notify = vi.fn();
        const tree = (withSecond: boolean) => (
            <Physics>
                <Harness log={log} onNotify={notify} dynamic>
                    <Shape key="a" size={[1, 1, 1]} position={[0, 1, 0]} />
                    {withSecond ? <Shape key="b" size={[1, 1, 1]} position={[0, -1, 0]} /> : null}
                    <Shape key="c" type="sphere" radius={0.5} position={[0, 4, 0]} />
                </Harness>
            </Physics>
        );
        const renderer = await create(tree(true));
        const compound = log.shapes[0];
        assert.equal(subShapeCount(compound), 3);
        const spies = spyOnCompound();

        try {
            await renderer.update(tree(false));

            expect(spies.remove).toHaveBeenCalledTimes(1);
            // jolt's indices close up behind a removal: the sphere was index 2 and is now 1
            expect(spies.remove).toHaveBeenCalledWith(1);
            assert.equal(log.shapes.length, 1, 'the compound was rebuilt instead of edited');
            assert.equal(subShapeCount(compound), 2);
            expect(notify).toHaveBeenCalled();
        } finally {
            spies.restore();
        }

        await renderer.unmount();
        log.release();
    });

    test('moving a child calls ModifyShape; resizing one still rebuilds', async () => {
        const log = shapeLog();
        const tree = (y: number, size: number[]) => (
            <Physics>
                <Harness log={log} dynamic>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={size} position={[0, y, 0]} />
                </Harness>
            </Physics>
        );
        const renderer = await create(tree(-1, [1, 1, 1]));
        const compound = log.shapes[0];
        const spies = spyOnCompound();

        try {
            // a pure move: same shape, new placement
            await renderer.update(tree(-4, [1, 1, 1]));
            expect(spies.modify).toHaveBeenCalledTimes(1);
            assert.equal(log.shapes.length, 1, 'a move rebuilt the compound');
            // 0.5 above the box at y = 1 down to 0.5 below the one now at y = -4
            assert.closeTo(boundsSize(compound)[1], 6, 0.1);

            // a different size is a different shape: that rebuilds
            await renderer.update(tree(-4, [2, 2, 2]));
            expect(spies.modify).toHaveBeenCalledTimes(1);
            assert.equal(log.shapes.length, 2, 'a resized child did not rebuild the compound');
            assert.equal(log.shapes[1].GetSubType(), Raw.module.EShapeSubType_MutableCompound);
        } finally {
            spies.restore();
        }

        await renderer.unmount();
        log.release();
    });

    test('a non dynamic compound still rebuilds when a child is added', async () => {
        const log = shapeLog();
        const renderer = await create(
            <Physics>
                <Harness log={log}>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                </Harness>
            </Physics>
        );
        assert.equal(log.shapes[0].GetSubType(), Raw.module.EShapeSubType_StaticCompound);

        await renderer.update(
            <Physics>
                <Harness log={log}>
                    <Shape size={[1, 1, 1]} position={[0, 1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, -1, 0]} />
                    <Shape size={[1, 1, 1]} position={[0, 3, 0]} />
                </Harness>
            </Physics>
        );
        assert.equal(log.shapes.length, 2, 'a static compound must be rebuilt');
        assert.equal(log.shapes[0].GetRefCount(), 1, 'the old compound was not released');

        await renderer.unmount();
        log.release();
    });
});

describe('<Shape> geometry props', () => {
    test('a geometry prop is described once and survives a re-render', async () => {
        const log = shapeLog();
        const geometry = new THREE.IcosahedronGeometry(1, 1);
        const renderer = await create(
            <Physics>
                <Harness log={log} type="convex" geometry={geometry} />
            </Physics>
        );

        assert.equal(log.shapes[0].GetSubType(), Raw.module.EShapeSubType_ConvexHull);
        await renderer.update(
            <Physics>
                <Harness log={log} type="convex" geometry={geometry} />
            </Physics>
        );
        assert.equal(log.shapes.length, 1, 'the same geometry rebuilt the hull');

        await renderer.unmount();
        log.release();
    });
});

//* <RigidBody scale> (issue #40) ===========================
// This is the Scaler example (apps/examples/src/examples/Bodies/Scaler.tsx) as a test: a body
// whose `scale` prop changes over time has to re-wrap its shape, not stack wrappers, and a body
// created with a scale has to be the right size from the first frame.
describe('<RigidBody scale>', () => {
    const scaleOf = (body: BodyState) => {
        const shape = body.body.GetShape();
        if (shape.GetSubType() !== Raw.module.EShapeSubType_Scaled) return [1, 1, 1];
        const scaled = Raw.module.castObject(shape, Raw.module.ScaledShape).GetScale();
        return [scaled.GetX(), scaled.GetY(), scaled.GetZ()];
    };

    test('a scale prop is applied when the body is created and re-applied when it changes', async () => {
        const bodyRef = React.createRef<BodyState>();
        const tree = (scale: number[]) => (
            <Physics>
                <RigidBody ref={bodyRef} scale={scale}>
                    <mesh>
                        <sphereGeometry args={[1.3, 16, 16]} />
                    </mesh>
                </RigidBody>
            </Physics>
        );

        const renderer = await create(tree([1, 1, 1]));
        const body = bodyRef.current!;
        assert.isOk(body, '<RigidBody> never produced a body');
        // a scale of 1 must not wrap the shape for nothing
        assert.equal(body.body.GetShape().GetSubType(), Raw.module.EShapeSubType_Sphere);

        await renderer.update(tree([1.33, 1.33, 1.33]));
        expect(scaleOf(body).map((n) => Math.round(n * 100))).toEqual([133, 133, 133]);
        const wrapper = body.body.GetShape();

        // Scaler cycles through several scales: each one must re-wrap the *inner* sphere rather
        // than wrap the previous ScaledShape again
        await renderer.update(tree([1.8, 1.8, 1.8]));
        expect(scaleOf(body).map((n) => Math.round(n * 100))).toEqual([180, 180, 180]);
        const rescaled = Raw.module.castObject(body.body.GetShape(), Raw.module.ScaledShape);
        assert.equal(rescaled.GetInnerShape().GetSubType(), Raw.module.EShapeSubType_Sphere);
        assert.notStrictEqual(rescaled, wrapper);
        // and back to the start, the way Scaler's reset() does
        await renderer.update(tree([1, 1, 1]));
        expect(scaleOf(body).map(Math.round)).toEqual([1, 1, 1]);

        await renderer.unmount();
    });

    test('a scaled child mesh is described at its scaled size (issue #40)', async () => {
        const bodyRef = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={bodyRef}>
                    <mesh scale={[2, 2, 2]} position={[0, 1, 0]}>
                        <boxGeometry args={[1, 1, 1]} />
                    </mesh>
                    <mesh position={[0, -1, 0]}>
                        <boxGeometry args={[1, 1, 1]} />
                    </mesh>
                </RigidBody>
            </Physics>
        );

        const shape = bodyRef.current!.body.GetShape();
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        const compound = Raw.module.castObject(shape, Raw.module.StaticCompoundShape);
        const subTypes = [0, 1].map((i) => compound.GetSubShape(i).mShape.GetSubType());
        assert.include(subTypes, Raw.module.EShapeSubType_Scaled, 'the scaled mesh');
        // the scaled box reaches y = 2 and the plain one y = -1.5: 3.5 tall, not 2.5
        assert.closeTo(boundsSize(shape)[1], 3.5, 0.1);

        await renderer.unmount();
    });
});

/** Captures the world so a test can step it by hand. */
function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

describe('<Shape> scoped events (issue #13)', () => {
    const STEP = 1 / 60;

    test('a child <Shape> only hears about contacts on its own sub shape', async () => {
        let system: PhysicsSystem | undefined;
        const fired: string[] = [];
        const seen: { index: number; userData: number; name?: string }[] = [];

        const renderer = await create(
            <Physics>
                <Capture
                    onSystem={(s) => {
                        system = s;
                    }}
                />
                {/* a floor in two halves, as one compound: only the right one is landed on */}
                <RigidBody type="static" position={[0, -1, 0]}>
                    <Shape>
                        <Shape
                            name="left"
                            size={[8, 1, 8]}
                            position={[-6, 0, 0]}
                            onCollisionEnter={() => fired.push('left')}
                        />
                        <Shape
                            name="right"
                            size={[8, 1, 8]}
                            position={[6, 0, 0]}
                            onCollisionEnter={(e) => {
                                fired.push('right');
                                seen.push({
                                    index: e.targetSubShape.index,
                                    userData: e.targetSubShape.userData,
                                    name: e.targetSubShape.descriptor?.name
                                });
                            }}
                        />
                    </Shape>
                </RigidBody>
                <RigidBody position={[6, 2, 0]}>
                    <mesh>
                        <boxGeometry args={[1, 1, 1]} />
                    </mesh>
                </RigidBody>
            </Physics>
        );

        assert.isDefined(system);
        for (let i = 0; i < 60 && fired.length === 0; i++) system!.onUpdate(STEP);

        assert.deepEqual(fired, ['right'], 'the wrong <Shape> (or both) heard the contact');
        assert.equal(seen[0].index, 1, 'the sub shape index did not come back');
        assert.equal(seen[0].name, 'right', 'the descriptor did not come back');
        assert.notEqual(seen[0].userData, 0, 'no user data was auto assigned');

        await renderer.unmount();
    });

    test('an explicit userData is stamped, and nothing is stamped without one', async () => {
        const bodyRef = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={bodyRef} type="static">
                    <Shape>
                        <Shape size={[1, 1, 1]} position={[-1, 0, 0]} userData={4242} />
                        <Shape size={[1, 1, 1]} position={[1, 0, 0]} />
                    </Shape>
                </RigidBody>
            </Physics>
        );

        const shape = bodyRef.current!.body.GetShape();
        const compound = Raw.module.castObject(shape, Raw.module.CompoundShape);
        assert.equal(compound.GetSubShape(0).mShape.GetUserData(), 4242);
        // a <Shape> with neither userData nor handlers stays at jolt's default
        assert.equal(compound.GetSubShape(1).mShape.GetUserData(), 0);
        // and the body kept the description its shape was built from
        const descriptor = bodyRef.current!.shapeDescriptor;
        assert.equal(descriptor?.type, 'staticCompound');
        assert.equal(
            descriptor?.type === 'staticCompound' ? descriptor.children.length : 0,
            2,
            'the body did not keep the description its shape was built from'
        );

        await renderer.unmount();
    });
});
