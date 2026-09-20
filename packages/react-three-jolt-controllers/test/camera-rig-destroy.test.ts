// Issue #139: `CameraRigManager.destroy()` never touched its `CameraBoom`, so the boom's
// Raycaster, Shapecaster and ShapeCollider (~25 wasm objects) leaked with every rig, its
// rig-point bodies stayed in the simulation, and `detachFromLoop()` called
// `removeStepListener(this.handleUpdate)` - a *different* function object than the inline arrow
// that had been registered - so the removal silently did nothing and the rig kept stepping.

import { initJolt, PhysicsSystem, Raw } from '@react-three/jolt';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { installAllocTracker } from '../../react-three-jolt/test/jolt-alloc';
import { CameraRigManager } from '../src/systems/camera-rig/camera-rig-system';

// Everything the rig, the boom and the core query helpers allocate with `new Raw.module.*`.
// Two families are deliberately absent:
//  - shape classes (`SphereShape`), which are reference counted and given back with `Release()`
//    rather than `destroy()`, which the tracker cannot see;
//  - `BodyCreationSettings`, which `BodySystem` frees through the `Raw.module` reference it
//    captured at construction time, i.e. before the tracker swapped in its proxy.
const TRACKED_TYPES = [
    'RRayCast',
    'RayCastSettings',
    'RShapeCast',
    'ShapeCastSettings',
    'CollideShapeSettings',
    'BodyFilter',
    'ShapeFilter',
    'DefaultBroadPhaseLayerFilter',
    'DefaultObjectLayerFilter',
    'CastRayClosestHitCollisionCollector',
    'CastRayAllHitCollisionCollector',
    'CastShapeClosestHitCollisionCollector',
    'CastShapeAllHitCollisionCollector',
    'CollideShapeClosestHitCollisionCollector',
    'CollideShapeAllHitCollisionCollector',
    // the rig points go through BodySystem.addBody, whose shape settings are destroyed inside
    // the tracked window - listing them keeps `foreignDestroys()` meaningful
    'BoxShapeSettings',
    'BodyID',
    'SubShapeID',
    'Vec3',
    'RVec3',
    'Quat',
    'RMat44'
];

let ps: PhysicsSystem;

const stepListenerCount = (system: PhysicsSystem) =>
    ((system as unknown as { preStepListeners: unknown[] }).preStepListeners ?? []).length;

const newScene = () => new THREE.Scene();

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('camera-rig-destroy');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
    // build one rig up front so every lazily created singleton exists before anything is counted
    new CameraRigManager(newScene(), ps).destroy();
});

test('construct -> step -> destroy leaves no live jolt objects behind', () => {
    const alloc = installAllocTracker(Raw, { types: TRACKED_TYPES });
    try {
        // warm-up round under the tracked module (it swaps Raw.module, rebuilding joltScratch)
        const warmup = new CameraRigManager(newScene(), ps);
        warmup.createRigPoint('warmup');
        ps.onUpdate(1 / 60);
        warmup.destroy();
        const before = alloc.live();

        const rig = new CameraRigManager(newScene(), ps);
        rig.createRigPoint('follow');
        rig.setActiveCamera('main');
        for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
        rig.destroy();

        assert.equal(
            alloc.live(),
            before,
            `the rig leaked ${alloc.live() - before} objects: ${JSON.stringify(alloc.liveByType())}`
        );
        assert.equal(alloc.foreignDestroys(), 0, 'the rig freed something it does not own');
    } finally {
        alloc.uninstall();
    }
});

test('destroy() removes the rig-point bodies from the simulation', () => {
    const rig = new CameraRigManager(newScene(), ps);
    const point = rig.createRigPoint('point');
    assert.isDefined(ps.bodySystem.getBody(point.handle), 'the rig point was never registered');

    rig.destroy();
    assert.isUndefined(ps.bodySystem.getBody(point.handle), 'the rig point outlived the rig');
});

test('destroy() is idempotent', () => {
    const rig = new CameraRigManager(newScene(), ps);
    rig.createRigPoint('point');
    for (let i = 0; i < 3; i++) ps.onUpdate(1 / 60);
    rig.destroy();
    assert.doesNotThrow(() => rig.destroy());
    assert.doesNotThrow(() => rig.destroy());
});

test('destroy() removes the pre-step listener so stepping is a no-op afterwards', () => {
    const before = stepListenerCount(ps);
    const rig = new CameraRigManager(newScene(), ps);
    assert.equal(stepListenerCount(ps), before + 1, 'the rig did not register a listener');

    let calls = 0;
    const counted = rig as unknown as { updateSpaces: () => void };
    const realUpdateSpaces = counted.updateSpaces.bind(rig);
    counted.updateSpaces = () => {
        calls++;
        realUpdateSpaces();
    };
    ps.onUpdate(1 / 60);
    assert.isAbove(calls, 0, 'the listener never ran while the rig was alive');

    rig.destroy();
    assert.equal(stepListenerCount(ps), before, 'the pre-step listener was not removed');

    const callsAtDestroy = calls;
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.equal(calls, callsAtDestroy, 'a destroyed rig is still being stepped');
});

test('the boom keeps casting while the rig is alive and stops once destroyed', () => {
    const rig = new CameraRigManager(newScene(), ps);
    rig.setActiveCamera('main');
    rig.attach(
        ps.bodySystem.getBody(
            ps.bodySystem.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
        )!
    );
    for (let i = 0; i < 10; i++) ps.onUpdate(1 / 60);
    assert.isFinite(rig.controls.currentDistance);

    rig.destroy();
    // the boom's queries are freed, so a stray frame update must not touch them
    assert.doesNotThrow(() => rig.controls.handleFrameUpdate());
});
