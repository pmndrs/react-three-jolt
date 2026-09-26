// QA #305: prove the drag-to-grab mechanic (`apps/examples/src/shared/Grabber.tsx`) actually
// works against the real wasm module, not just "the geometry looks right" (the QA round's
// stated failure mode for last round's examples). `Grabber` creates a kinematic anchor at the
// point a dynamic body's mesh was clicked, joins the two with a `point` constraint - the same
// call `useConstraint('point', anchorRef, targetRef, options)` makes - and drags the anchor with
// `setKinematicTarget` every frame. This test reproduces exactly that with the library's public
// systems API (no React): build the same bodies and the same constraint, move the anchor 2m over
// a run of steps like a slow drag, and check the body actually came along on every single step
// (a point constraint is rigid, not a spring - it should never lag behind). It also checks that
// releasing the drag - constraint first, then the anchor body, the order `DragAnchor`'s unmount
// uses - leaves the wasm heap exactly as it found it.
//
// The `installAllocTracker` window below is deliberately narrow (`addConstraint`/
// `removeConstraint` only, matching `test/constraints.test.ts`) rather than wrapped around the
// whole drag loop: the tracker's proxy gives `Raw.module` a new identity, and
// `joltScratch`'s `ensureScratchModule` (see `src/utils/general.ts`) treats any module identity
// change as "Jolt was re-initialised", rebuilding its pooled Vec3/RVec3/Quat scratch - which
// `setKinematicTarget`'s step-loop path uses every frame. Tracking through the drag loop would
// therefore flag that one-time, by-design rebuild as a leak that has nothing to do with this
// feature. The wasm-heap check below (`expectHeapRestored`) covers the whole cycle instead.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';
import { expectHeapRestored, installAllocTracker } from './jolt-alloc';

const STEP = 1 / 60;

let ps: PhysicsSystem;

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

const box = (position: [number, number, number], size = 1) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.position.set(...position);
    return mesh;
};

const addBody = (position: [number, number, number], bodyType?: 'kinematic'): BodyState => {
    const handle = ps.bodySystem.addBody(box(position), bodyType ? { bodyType } : undefined);
    return ps.bodySystem.getBody(handle)!;
};

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-grab-305');
    // isolate the drag mechanic from gravity/sag - this test is about the anchor pulling the
    // body along, not the constraint's stiffness under load.
    ps.setGravity(0);
    // Stepping a world that actually has a body in it lazily grows Jolt's own internal per-step
    // working buffers (contact cache, job system) to whatever size a live body needs - a
    // permanent, by-design reservation for the lifetime of this `PhysicsSystem`/`JoltInterface`,
    // not something `removeBody` ever gives back. Pay that cost here, on a throwaway body, before
    // the heap baseline below - otherwise the real test's first step would look like it leaked
    // ~98KB it never touched.
    const warmup = addBody([1000, 1000, 0], 'kinematic');
    warmup.setKinematicTarget(warmup.position);
    ps.onUpdate(1 / 60);
    ps.bodySystem.removeBody(warmup.handle);
    ps.onUpdate(1 / 60);
});

test('dragging a body: a kinematic anchor + point constraint drags a dynamic body along (#305)', () => {
    const grabPoint: [number, number, number] = [5, 10, 0];
    const distanceToDrag = 2;
    const steps = 90;

    const baselineFree = freeMemory();

    const target = addBody(grabPoint);
    const anchor = addBody(grabPoint, 'kinematic');
    // Grabber marks the anchor a sensor so it never collides with the body it's dragging.
    anchor.isSensor = true;

    // the settings/temporaries `addConstraint` allocates and frees for a `point` constraint -
    // see `test/constraints.test.ts`, which tracks the same names for every constraint type.
    const TRACKED = ['Vec3', 'RVec3', 'PointConstraintSettings'];
    let spy = installAllocTracker(Raw, { types: TRACKED, throwOnDoubleDestroy: false });

    // body1 = anchor, body2 = the dragged body - the same order `useConstraint('point',
    // anchorRef, targetRef, options)` calls `addConstraint` with.
    const constraint = ps.constraintSystem.addConstraint('point', anchor, target, {
        point1: grabPoint
    });
    assert.deepEqual(spy.liveDetails(), [], 'addConstraint leaked wasm objects');
    assert.equal(ps.constraintSystem.constraints.size, 1);
    spy.uninstall();

    // drag the anchor along +x over `steps` frames, like `useFrame` re-aiming the kinematic
    // target at wherever the pointer now projects onto the drag plane every frame. Not tracked
    // (see the file header) - `setKinematicTarget` drives `joltScratch`, not fresh allocations.
    const dragTarget = new THREE.Vector3(...grabPoint);
    for (let i = 1; i <= steps; i++) {
        dragTarget.x = grabPoint[0] + (distanceToDrag * i) / steps;
        anchor.setKinematicTarget(dragTarget);
        ps.onUpdate(STEP);
        // the point constraint is rigid, not a spring: the grabbed body's point should stay
        // essentially coincident with the anchor on every single step, not just catch up by the
        // end.
        assert.closeTo(
            target.position.distanceTo(anchor.position),
            0,
            0.08,
            `body detached from the anchor at step ${i}`
        );
    }

    assert.closeTo(
        anchor.position.x,
        grabPoint[0] + distanceToDrag,
        1e-2,
        'anchor did not reach the drag target'
    );
    assert.closeTo(
        target.position.x,
        grabPoint[0] + distanceToDrag,
        0.1,
        'body did not follow the anchor'
    );

    // release: constraint first, then the anchor body - the order `DragAnchor`'s unmount uses,
    // since its own `useConstraint` cleanup fires before its child `<RigidBody>`'s (passive
    // effects clean up parent-before-child).
    spy = installAllocTracker(Raw, { types: TRACKED, throwOnDoubleDestroy: false });
    assert.isTrue(ps.constraintSystem.removeConstraint(constraint));
    assert.equal(ps.constraintSystem.constraints.size, 0);
    assert.deepEqual(spy.liveDetails(), [], 'removeConstraint leaked wasm objects');
    spy.uninstall();

    ps.bodySystem.removeBody(anchor.handle);
    ps.onUpdate(STEP);

    // freed of the constraint and the anchor, the body just sits where it was left (no gravity).
    assert.closeTo(
        target.position.x,
        grabPoint[0] + distanceToDrag,
        0.1,
        'body moved after release'
    );

    // and the dragged body itself, so the heap check below measures a world with nothing left
    // over from this test - not "the anchor and its constraint are gone" (checked above) plus
    // "there happens to still be a body alive that was never released".
    ps.bodySystem.removeBody(target.handle);
    ps.onUpdate(STEP);

    expectHeapRestored(baselineFree, freeMemory(), 64, 'grab/drag/release leaked WASM heap');
});
