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
import { assert, beforeAll, describe, expect, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { RigidBodyContext } from '../src/components/RigidBody';
import { Shape, type ShapeProps } from '../src/components/shape/Shape';
import { initJolt, Raw } from '../src/raw';

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

const Harness = ({ log, ...props }: ShapeProps & { log: ShapeLog }) => (
    <RigidBodyContext.Provider
        value={
            {
                body: undefined,
                type: undefined,
                position: undefined,
                rotation: undefined,
                scale: undefined,
                quaternion: undefined,
                setActiveShape: log.onShape
            } as any
        }
    >
        <Shape {...props} />
    </RigidBodyContext.Provider>
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
