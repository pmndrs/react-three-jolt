// The `<Physics debug>` wireframe collider overlay (issue #158).
//
// Two halves: the React lifecycle (does the overlay follow the bodies, and does unmounting give
// everything back), and the renderer itself driven directly, because `update()` only runs from
// `useFrame` and stepping it by hand is what makes the allocation assertions deterministic.

import { useThree } from '@react-three/fiber';
import { create } from '@react-three/test-renderer';
import React from 'react';
import * as THREE from 'three';
import { assert, beforeAll, test, vi } from 'vitest';
import { Physics, RigidBody } from '../src';
import { initJolt, Raw } from '../src/raw';
import { DebugRenderer } from '../src/systems/debug-renderer';
import { PhysicsSystem } from '../src/systems/physics-system';
import { joltScratch } from '../src/utils';
import { installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

/** The overlay lives in the three.js scene, not in the React tree, so it is found by name. */
function SceneCapture({ onScene }: { onScene: (scene: THREE.Scene) => void }) {
    const scene = useThree((state) => state.scene);
    React.useEffect(() => {
        onScene(scene);
    }, [scene, onScene]);
    return null;
}

const Box = ({ x }: { x: number }) => (
    <RigidBody position={[x, 0, 0]}>
        <mesh>
            <boxGeometry args={[1, 1, 1]} />
        </mesh>
    </RigidBody>
);

const overlayOf = (scene: THREE.Scene): THREE.Object3D => {
    const overlay = scene.getObjectByName('jolt-debug');
    assert.isDefined(overlay, '<Physics debug> did not add a debug overlay to the scene');
    return overlay!;
};

test('<Physics debug> draws one wireframe per body, and drops it again with the body', async () => {
    let scene: THREE.Scene | undefined;
    const tree = (count: number) => (
        <Physics debug>
            <SceneCapture
                onScene={(s) => {
                    scene = s;
                }}
            />
            {Array.from({ length: count }, (_, i) => (
                <Box key={i} x={i * 3} />
            ))}
        </Physics>
    );

    const renderer = await create(tree(3));
    assert.isDefined(scene);
    const overlay = overlayOf(scene!);
    assert.lengthOf(overlay.children, 3, 'expected one wireframe per body');
    for (const child of overlay.children)
        assert.instanceOf(child, THREE.LineSegments, 'the overlay is not wireframes');

    // removing a body takes its wireframe with it
    await renderer.update(tree(2));
    assert.lengthOf(overlay.children, 2, 'a removed body left its wireframe behind');

    await renderer.unmount();
});

test('unmounting disposes every geometry the overlay built', async () => {
    let scene: THREE.Scene | undefined;
    const renderer = await create(
        <Physics debug>
            <SceneCapture
                onScene={(s) => {
                    scene = s;
                }}
            />
            <Box x={0} />
            {/* a different shape, so this one cannot share the box's cached geometry */}
            <RigidBody position={[4, 0, 0]}>
                <mesh>
                    <sphereGeometry args={[1, 8, 8]} />
                </mesh>
            </RigidBody>
        </Physics>
    );
    assert.isDefined(scene);
    const overlay = overlayOf(scene!);
    assert.lengthOf(overlay.children, 2);

    const spies = overlay.children.map((child) =>
        vi.spyOn((child as THREE.LineSegments).geometry, 'dispose')
    );

    await renderer.unmount();

    for (const spy of spies) assert.equal(spy.mock.calls.length, 1, 'a geometry was not disposed');
    assert.lengthOf(overlay.children, 0, 'the overlay kept its children after unmount');
});

test('the overlay backfills bodies that already exist, and shares geometry between them', () => {
    const ps = new PhysicsSystem('debug-backfill');
    try {
        // One Jolt shape handed to all three bodies - which is the normal case for anything
        // instanced, and exactly what the pointer keyed geometry cache exists for.
        const first = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        const firstState = ps.bodySystem.getBody(ps.bodySystem.addBody(first))!;
        const shape = firstState.body.GetShape();
        for (let i = 1; i < 3; i++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            mesh.position.set(i * 3, 0, 0);
            ps.bodySystem.addBody(mesh, { shape });
        }
        // created after the bodies: turning debug on mid-flight has to show what is already there
        const debug = new DebugRenderer(ps);
        try {
            assert.lengthOf(debug.object.children, 3, 'existing bodies were not backfilled');
            const geometries = new Set(
                debug.object.children.map((child) => (child as THREE.LineSegments).geometry)
            );
            assert.equal(geometries.size, 1, 'identical shapes did not share one geometry');

            // and a body added afterwards joins on its own
            const extra = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8));
            extra.position.set(0, 10, 0);
            const handle = ps.bodySystem.addBody(extra);
            assert.lengthOf(debug.object.children, 4, 'a new body did not join the overlay');

            ps.bodySystem.removeBody(handle);
            assert.lengthOf(debug.object.children, 3, 'a removed body stayed in the overlay');
        } finally {
            debug.dispose();
        }
    } finally {
        ps.destroy('debug-backfill');
    }
});

test('the overlay follows body poses without touching the simulation', () => {
    const ps = new PhysicsSystem('debug-poses');
    try {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(0, 10, 0);
        const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
        const debug = new DebugRenderer(ps);
        try {
            for (let i = 0; i < 30; i++) {
                ps.onUpdate(STEP);
                debug.update();
            }
            // the body fell, so the wireframe has to have fallen with it
            const lines = debug.object.children[0] as THREE.LineSegments;
            const drawn = new THREE.Vector3().setFromMatrixPosition(lines.matrix);
            assert.isBelow(state.position.y, 10, 'the body did not fall; nothing was measured');
            assert.closeTo(drawn.y, state.position.y, 0.2, 'the wireframe did not follow the body');
        } finally {
            debug.dispose();
        }
    } finally {
        ps.destroy('debug-poses');
    }
});

test('a shape edited in place invalidates the cached geometry', () => {
    const ps = new PhysicsSystem('debug-shape-changed');
    try {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
        const debug = new DebugRenderer(ps);
        try {
            const lines = debug.object.children[0] as THREE.LineSegments;
            debug.update();
            const original = lines.geometry;
            const disposed = vi.spyOn(original, 'dispose');

            // A mutable compound edit keeps the same shape pointer, so the pointer check in
            // `update()` cannot see it - the world's `shapeChanged` event is the only signal.
            state.notifyShapeChanged();
            debug.update();
            assert.notStrictEqual(
                lines.geometry,
                original,
                'an in-place shape edit left the stale geometry in place'
            );
            assert.equal(disposed.mock.calls.length, 1, 'the stale geometry was not disposed');
        } finally {
            debug.dispose();
        }
    } finally {
        ps.destroy('debug-shape-changed');
    }
});

test('the overlay retains no Jolt allocations, per frame or over its lifetime', () => {
    const ps = new PhysicsSystem('debug-alloc');
    try {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(0, 5, 0);
        ps.bodySystem.addBody(mesh);
        // warm every path once before the tracker swaps Raw.module's identity
        const warm = new DebugRenderer(ps);
        ps.onUpdate(STEP);
        warm.update();
        warm.dispose();

        const alloc = installAllocTracker(Raw);
        try {
            joltScratch.vec3(0, 0, 0);
            ps.onUpdate(STEP);
            const before = alloc.live();

            const debug = new DebugRenderer(ps);
            // building the wireframes allocates (a scale vector, the triangle context); all of it
            // has to be handed back before the constructor returns
            assert.equal(alloc.live(), before, 'building the overlay leaked Jolt objects');

            const afterBuild = alloc.live();
            // `createMeshFromShape` destroys a `ShapeGetTriangles`, which is a real allocation
            // the tracker does not intercept, so the build shows up as a foreign destroy. The
            // per-frame path must not add any: that would mean a value return was being freed.
            const foreignAfterBuild = alloc.foreignDestroys();
            for (let i = 0; i < 200; i++) {
                ps.onUpdate(STEP);
                debug.update();
            }
            assert.equal(alloc.live(), afterBuild, 'the overlay leaks Jolt objects per frame');
            assert.equal(
                alloc.foreignDestroys(),
                foreignAfterBuild,
                'the per-frame path freed a Jolt owned temporary'
            );

            debug.dispose();
            assert.equal(alloc.live(), before, 'disposing the overlay left Jolt objects behind');
        } finally {
            alloc.uninstall();
        }
    } finally {
        ps.destroy('debug-alloc');
    }
});
