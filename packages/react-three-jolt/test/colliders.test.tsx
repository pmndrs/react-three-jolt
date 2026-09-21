// Named collider components and `<RigidBody colliders>` - issue #155, against the real wasm
// module.
//
// The things worth proving here are the ones a type signature cannot: that each `args` tuple
// reaches Jolt as the right shape *at the right size* (rapier's args are half extents, this
// library's `<Shape>` props are not), that sibling colliders actually combine into one compound
// instead of the last one silently winning, that a collider's offset survives into the body's
// local bounds, and that mounting and unmounting all of that frees everything it allocated.
import { create } from '@react-three/test-renderer';
import type Jolt from 'jolt-physics';
import React from 'react';
import { preload } from 'suspend-react';
import { assert, beforeAll, describe, expect, test, vi } from 'vitest';
import { Physics } from '../src/components/Physics';
import { RigidBody } from '../src/components/RigidBody';
import {
    BallCollider,
    CapsuleCollider,
    ConeCollider,
    ConvexHullCollider,
    CuboidCollider,
    CylinderCollider,
    HeightfieldCollider,
    TrimeshCollider
} from '../src/components/shape/colliders';
import { useJolt } from '../src/hooks';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { PhysicsSystem } from '../src/systems/physics-system';
import { readCenterOfMass } from '../src/systems/shape-system';
import { setDebug } from '../src/utils';
import { installAllocTracker } from './jolt-alloc';

// `devWarn` is gated behind `setDebug`, which is what the warning assertions below need.
beforeAll(async () => {
    setDebug(true);
    await initJolt();
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

const bounds = (shape: Jolt.Shape) => {
    const box = shape.GetLocalBounds();
    return {
        min: [box.mMin.GetX(), box.mMin.GetY(), box.mMin.GetZ()],
        max: [box.mMax.GetX(), box.mMax.GetY(), box.mMax.GetZ()],
        size: [
            box.mMax.GetX() - box.mMin.GetX(),
            box.mMax.GetY() - box.mMin.GetY(),
            box.mMax.GetZ() - box.mMin.GetZ()
        ]
    };
};

/** Mount one collider as the whole body and hand back the shape Jolt ended up with. */
const shapeOf = async (children: React.ReactNode, props: Record<string, unknown> = {}) => {
    const ref = React.createRef<BodyState>();
    const renderer = await create(
        <Physics>
            <RigidBody ref={ref} type="static" colliders={false} {...props}>
                {children}
            </RigidBody>
        </Physics>
    );
    assert.isOk(ref.current, '<RigidBody> never produced a body');
    return { shape: ref.current!.body.GetShape(), body: ref.current!, renderer };
};

/** Captures the world so a test can step it by hand. */
function Capture({ onSystem }: { onSystem: (system: PhysicsSystem) => void }) {
    const { physicsSystem } = useJolt();
    React.useEffect(() => {
        onSystem(physicsSystem);
    }, [physicsSystem, onSystem]);
    return null;
}

//* One collider per shape type =============================================
describe('collider components', () => {
    test('<CuboidCollider args> are half extents', async () => {
        const { shape, renderer } = await shapeOf(<CuboidCollider args={[0.5, 1, 1.5]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Box);
        // args are halves, so the box is 1 x 2 x 3
        expect(bounds(shape).size.map((n) => Math.round(n * 100) / 100)).toEqual([1, 2, 3]);
        await renderer.unmount();
    });

    test('<BallCollider args={[radius]}>', async () => {
        const { shape, renderer } = await shapeOf(<BallCollider args={[0.75]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Sphere);
        assert.closeTo(bounds(shape).size[1], 1.5, 1e-4);
        await renderer.unmount();
    });

    test('<CapsuleCollider args={[halfHeight, radius]}>', async () => {
        const { shape, renderer } = await shapeOf(<CapsuleCollider args={[1, 0.25]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Capsule);
        // cylindrical section 2, plus a cap at each end
        assert.closeTo(bounds(shape).size[1], 2.5, 1e-4);
        assert.closeTo(bounds(shape).size[0], 0.5, 1e-4);
        await renderer.unmount();
    });

    test('<CylinderCollider args={[halfHeight, radius]}>', async () => {
        const { shape, renderer } = await shapeOf(<CylinderCollider args={[1, 0.5]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Cylinder);
        assert.closeTo(bounds(shape).size[1], 2, 1e-4);
        assert.closeTo(bounds(shape).size[0], 1, 1e-4);
        await renderer.unmount();
    });

    test('<ConeCollider> is a tapered cylinder with a zero top radius', async () => {
        const { shape, renderer } = await shapeOf(<ConeCollider args={[1, 0.5]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_TaperedCylinder);
        assert.closeTo(bounds(shape).size[1], 2, 1e-4);
        // the widest point is the base
        assert.closeTo(bounds(shape).size[0], 1, 1e-4);
        await renderer.unmount();
    });

    test('<ConvexHullCollider args={[points]}> takes a flat array or a typed array', async () => {
        const points = new Float32Array([
            -1, -1, -1, 1, -1, -1, -1, 1, -1, -1, -1, 1, 1, 1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1
        ]);
        const { shape, renderer } = await shapeOf(<ConvexHullCollider args={[points]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_ConvexHull);
        // a hull has a convex radius, so it is a touch larger than the 2x2x2 point cloud
        for (const n of bounds(shape).size) assert.closeTo(n, 2, 0.15);
        await renderer.unmount();
    });

    test('<TrimeshCollider args={[vertices, indices]}> on a static body', async () => {
        const vertices = [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1];
        const indices = [0, 1, 2, 0, 2, 3];
        const { shape, renderer } = await shapeOf(<TrimeshCollider args={[vertices, indices]} />);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Mesh);
        assert.closeTo(bounds(shape).size[0], 2, 0.1);
        await renderer.unmount();
    });

    test('<HeightfieldCollider args={[samples, size, scale]}>', async () => {
        const size = 4;
        const samples = new Array(size * size).fill(0).map((_, i) => (i % size) * 0.25);
        const { shape, renderer } = await shapeOf(
            <HeightfieldCollider args={[samples, size, [2, 1, 2]]} />
        );
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_HeightField);
        // `size` samples span `size - 1` segments of 2 units
        assert.closeTo(bounds(shape).size[0], (size - 1) * 2, 0.2);
        await renderer.unmount();
    });
});

//* <RigidBody colliders> ===================================================
describe('<RigidBody colliders>', () => {
    test('colliders={false} with two child colliders is a two child compound, no auto shape', async () => {
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} type="static" colliders={false}>
                    {/* a mesh that must NOT contribute a shape */}
                    <mesh>
                        <boxGeometry args={[10, 10, 10]} />
                    </mesh>
                    <CuboidCollider args={[0.5, 0.5, 0.5]} position={[-1, 0, 0]} />
                    <BallCollider args={[0.5]} position={[1, 0, 0]} />
                </RigidBody>
            </Physics>
        );

        const shape = ref.current!.body.GetShape();
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        const compound = Raw.module.castObject(shape, Raw.module.CompoundShape);
        assert.equal(compound.GetNumSubShapes(), 2, 'the 10x10x10 mesh leaked into the body');
        assert.equal(compound.GetSubShape(0).mShape.GetSubType(), Raw.module.EShapeSubType_Box);
        assert.equal(compound.GetSubShape(1).mShape.GetSubType(), Raw.module.EShapeSubType_Sphere);
        // the two colliders span x = -1.5 .. 1.5, nothing like the mesh's 10
        assert.closeTo(bounds(shape).size[0], 3, 0.05);

        // and the description the body kept matches the shape it built
        const descriptor = ref.current!.shapeDescriptor;
        assert.equal(descriptor?.type, 'staticCompound');
        assert.equal(
            descriptor?.type === 'staticCompound' ? descriptor.children.length : 0,
            2,
            'the body did not keep the description its shape was built from'
        );

        await renderer.unmount();
    });

    test('colliders="ball" forces a sphere for a box mesh', async () => {
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} type="static" colliders="ball">
                    <mesh>
                        <boxGeometry args={[2, 2, 2]} />
                    </mesh>
                </RigidBody>
            </Physics>
        );
        assert.equal(
            ref.current!.body.GetShape().GetSubType(),
            Raw.module.EShapeSubType_Sphere,
            'colliders="ball" did not reach the auto-shape path'
        );
        await renderer.unmount();
    });

    test('a mesh and a collider combine into one compound', async () => {
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} type="static">
                    <mesh>
                        <boxGeometry args={[1, 1, 1]} />
                    </mesh>
                    <BallCollider args={[0.5]} position={[0, 3, 0]} />
                </RigidBody>
            </Physics>
        );
        const shape = ref.current!.body.GetShape();
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        const compound = Raw.module.castObject(shape, Raw.module.CompoundShape);
        assert.equal(compound.GetNumSubShapes(), 2);
        // the mesh comes first, the collider second
        assert.equal(compound.GetSubShape(0).mShape.GetSubType(), Raw.module.EShapeSubType_Box);
        assert.equal(compound.GetSubShape(1).mShape.GetSubType(), Raw.module.EShapeSubType_Sphere);
        // the box reaches y = -0.5 and the ball y = 3.5: 4 tall, not 1
        // (`GetLocalBounds` on a compound is relative to its centre of mass, so the *size* is
        // the offset-independent thing to assert)
        assert.closeTo(bounds(shape).size[1], 4, 0.05);
        await renderer.unmount();
    });

    test("a collider's offset is honoured even when it is the only one", async () => {
        const { shape, renderer } = await shapeOf(
            <CuboidCollider args={[0.5, 0.5, 0.5]} position={[0, 2, 0]} />
        );
        // A *root* shape's transform is ignored by the pipeline (wrapping it would move the
        // centre of mass), so a lone offset collider has to become a one child compound - which
        // is exactly what puts its centre of mass 2 units up.
        // (jolt collapses a one child compound into a RotatedTranslatedShape, which is the same
        // thing said more cheaply - either way the child is no longer at the origin)
        assert.notEqual(shape.GetSubType(), Raw.module.EShapeSubType_Box, 'the offset was dropped');
        expect(readCenterOfMass(shape).map((n) => Math.round(n * 100) / 100)).toEqual([0, 2, 0]);
        await renderer.unmount();
    });

    test('two offset colliders are placed, not stacked at the origin', async () => {
        const { shape, renderer } = await shapeOf(
            <>
                <CuboidCollider args={[0.5, 0.5, 0.5]} position={[0, -2, 0]} />
                <CuboidCollider args={[0.5, 0.5, 0.5]} position={[0, 2, 0]} />
            </>
        );
        // 1 tall each, 4 apart: 5 in total, and `GetLocalBounds` is shifted off the origin
        const local = bounds(shape);
        assert.closeTo(local.size[1], 5, 0.05, 'the offsets were dropped');
        assert.closeTo(local.min[1], -2.5, 0.05);
        assert.closeTo(local.max[1], 2.5, 0.05);
        await renderer.unmount();
    });

    test('colliders={false} with no colliders warns instead of building a body', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} colliders={false}>
                    <mesh>
                        <boxGeometry args={[1, 1, 1]} />
                    </mesh>
                </RigidBody>
            </Physics>
        );
        assert.isNotOk(ref.current, 'a body was created from a mesh that was meant to be ignored');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        await renderer.unmount();
    });
});

//* Sensor policy ===========================================================
describe('a sensor collider', () => {
    test('makes the whole body a sensor when every collider asks for it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} type="static" colliders={false}>
                    <BallCollider args={[1]} sensor position={[-2, 0, 0]} />
                    <CuboidCollider args={[1, 1, 1]} sensor position={[2, 0, 0]} />
                </RigidBody>
            </Physics>
        );
        assert.isTrue(ref.current!.body.IsSensor(), 'the body was not made a sensor');
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        await renderer.unmount();
    });

    test('a mix of sensor and solid colliders is refused', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            create(
                <Physics>
                    <RigidBody type="static" colliders={false}>
                        <BallCollider args={[1]} sensor position={[-2, 0, 0]} />
                        <CuboidCollider args={[1, 1, 1]} position={[2, 0, 0]} />
                    </RigidBody>
                </Physics>
            )
        ).rejects.toThrow(/no per-sub-shape sensors/);
        error.mockRestore();
    });
});

//* Per sub shape events ====================================================
describe('collider events (issue #13)', () => {
    const STEP = 1 / 60;

    test('a <CuboidCollider onCollisionEnter> only fires for its own sub shape', async () => {
        let system: PhysicsSystem | undefined;
        const fired: string[] = [];

        const renderer = await create(
            <Physics>
                <Capture
                    onSystem={(s) => {
                        system = s;
                    }}
                />
                {/* a floor in two halves; only the right one is landed on */}
                <RigidBody type="static" position={[0, -1, 0]} colliders={false}>
                    <CuboidCollider
                        args={[4, 0.5, 4]}
                        position={[-6, 0, 0]}
                        name="left"
                        onCollisionEnter={() => fired.push('left')}
                    />
                    <CuboidCollider
                        args={[4, 0.5, 4]}
                        position={[6, 0, 0]}
                        name="right"
                        onCollisionEnter={() => fired.push('right')}
                    />
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
        assert.deepEqual(fired, ['right'], 'the wrong collider (or both) heard the contact');

        await renderer.unmount();
    });
});

//* Memory ==================================================================
describe('collider memory', () => {
    test('the compound a body composes out of its colliders is released on unmount', async () => {
        // The compound `<RigidBody>` builds is an extra shape on top of the children's own, so
        // this is the test that would catch it being dropped on the floor. Reference counting is
        // what makes "released" observable: the test takes its own reference, so a shape the
        // component let go of is still there to look at, with a count of exactly 1 (ours).
        const ref = React.createRef<BodyState>();
        const renderer = await create(
            <Physics>
                <RigidBody ref={ref} type="static" colliders={false}>
                    <CuboidCollider args={[0.5, 0.5, 0.5]} position={[-1, 0, 0]} />
                    <BallCollider args={[0.5]} position={[1, 0, 0]} />
                </RigidBody>
            </Physics>
        );
        const compound = ref.current!.body.GetShape();
        compound.AddRef();
        assert.isAbove(compound.GetRefCount(), 1, 'the body is not holding its own shape');

        await renderer.unmount();
        assert.equal(
            compound.GetRefCount(),
            1,
            'the compound <RigidBody> built out of its colliders was never released'
        );
        compound.Release();
    });

    test('mounting and unmounting colliders is allocation net-zero', async () => {
        const tree = (withColliders: boolean) => (
            <Physics>
                <RigidBody type="static" colliders={false}>
                    {withColliders ? (
                        <>
                            <CuboidCollider args={[0.5, 0.5, 0.5]} position={[-1, 0, 0]} />
                            <BallCollider args={[0.5]} position={[1, 0, 0]} />
                            <CapsuleCollider args={[0.5, 0.25]} position={[0, 2, 0]} />
                        </>
                    ) : (
                        <CuboidCollider args={[0.1, 0.1, 0.1]} />
                    )}
                </RigidBody>
            </Physics>
        );

        // warm up before the tracker is installed AND once after: installing swaps Raw.module's
        // identity, which rebuilds the shared joltScratch singletons exactly once.
        const warmup = await create(tree(true));
        await warmup.unmount();

        // The leaf settings a compound is built from (`BoxShapeSettings` and friends inside a
        // `StaticCompoundShapeSettings`) are deliberately not tracked: `AddShape` takes a
        // reference and C++ frees them along with the compound settings, without ever passing
        // through `jolt.destroy`, so the tracker could never see them released. Everything
        // listed here is allocated *and* freed from JS and has to net out to zero.
        const alloc = installAllocTracker(Raw, {
            types: [
                'Vec3',
                'RVec3',
                'Quat',
                'Mat44',
                'RMat44',
                'SubShapeID',
                'StaticCompoundShapeSettings',
                'BodyCreationSettings',
                'ShapeRefC'
            ]
        });
        try {
            const warm = await create(tree(true));
            await warm.unmount();

            const before = alloc.live();
            for (let i = 0; i < 3; i++) {
                const renderer = await create(tree(false));
                await renderer.update(tree(true));
                await renderer.unmount();
            }
            assert.equal(
                alloc.live(),
                before,
                `leaked ${alloc.live() - before}: ${JSON.stringify(alloc.liveByType())}`
            );
        } finally {
            alloc.uninstall();
        }
    });
});
