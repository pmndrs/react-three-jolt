// RagdollSystem (issue #251): builds a reusable `RagdollSettings` template from a synthetic
// `THREE.SkinnedMesh` (no assets - a 4 joint chain built in code, matching ragdoll-spike.test.ts's
// and skeleton-system.test.ts's rig) and spawns/destroys live `Jolt.Ragdoll` instances from it.
//
// Everything here runs against the real jolt-physics 1.1 WASM module, cross-checked against the
// hard rules docs/ragdolls.md's spike pinned down:
//  - a `RagdollSettings` template is reusable - `buildTemplate()` + `spawn()` are separate calls
//  - `Ragdoll.GetPose()` needs no `CalculateJointMatrices()` follow-up (see `captureStep`/`syncPoseNow`)
//  - `RemoveFromPhysicsSystem()` before `destroy()` is mandatory, every time
//  - `SetShape`/`mToParent`/`mSkeleton` transfer ownership on assignment; `Vec3`/`Quat` fields copy
//
// Every test that spawns a ragdoll gets its OWN `PhysicsSystem` and tears that world down before
// the next test runs - that part is still deliberate (keeps each test's heap assertions isolated),
// but tests are no longer restricted to spawning at most once. That restriction was working around
// a real bug (issue #275): `RagdollSettings` is itself a Jolt RefTarget with no AddRef/Release/
// GetRefCount exposed to JS, and destroying a spawned `Ragdoll` released the template's only
// reference to its own settings, silently freeing them and corrupting every later `spawn()` call
// on the same template - `GetBodyCount()` 0, `GetBodyID(0)` Jolt's invalid-body sentinel. Fixed in
// `RagdollSystem.buildTemplate()` (a permanent internal "keeper" Ragdoll instance holds that
// reference for the template's whole lifetime - see the module doc in
// src/systems/ragdoll-system.ts). "spawn -> destroy -> spawn again... 5 times" below is the
// regression test for that fix.

import * as THREE from 'three';
import { assert, test } from 'vitest';
import { Layer } from '../src/constants';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import type { RagdollTemplate } from '../src/systems/ragdoll-system';
import { installAllocTracker } from './jolt-alloc';

//* helpers ---------------------------------------------------------------------------------

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

/**
 * A fresh `PhysicsSystem`, warmed up exactly like ragdoll-spike.test.ts/skeleton-system.test.ts do
 * (absorbs the one-time ~96KB free-list settling cost a world's first Skeleton/RagdollPart/body/
 * constraint pays, so a test's own heap assertions can use the tight tolerance
 * `expectHeapRestored` uses everywhere else instead of a bespoke fudge factor) and given a static
 * floor. Callers must call `.destroy()` when done - see the module doc for why each test gets its
 * own world instead of sharing one across the file.
 */
async function newWarmedWorld(label: string): Promise<PhysicsSystem> {
    await initJolt();
    const ps = new PhysicsSystem(label);
    const jolt = Raw.module;
    const skeleton = new jolt.Skeleton();
    const name = new jolt.JPHString('warmup', 6);
    skeleton.AddJoint(name, -1);
    jolt.destroy(name);
    skeleton.CalculateParentJointIndices();
    const settings = new jolt.RagdollSettings();
    settings.mSkeleton = skeleton;
    settings.mParts.resize(1);
    const part = settings.mParts.at(0);
    part.SetShape(new jolt.CapsuleShape(0.3, 0.2));
    const position = new jolt.RVec3(0, 50, 0);
    part.mPosition = position;
    jolt.destroy(position);
    part.mRotation = jolt.Quat.prototype.sIdentity();
    part.mMotionType = jolt.EMotionType_Dynamic;
    part.mObjectLayer = Layer.RIG;
    settings.DisableParentChildCollisions();
    settings.CalculateBodyIndexToConstraintIndex();
    settings.CalculateConstraintIndexToBodyIdxPair();
    const ragdoll = settings.CreateRagdoll(0, 0, ps.joltPhysicsSystem);
    ragdoll.AddToPhysicsSystem(jolt.EActivation_Activate);
    ps.onUpdate(1 / 60);
    ragdoll.RemoveFromPhysicsSystem();
    jolt.destroy(ragdoll);
    jolt.destroy(settings);

    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });

    return ps;
}

const step = (ps: PhysicsSystem, frames = 60) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(1 / 60);
};

/**
 * A 4 joint chain, matching ragdoll-spike.test.ts/skeleton-system.test.ts's rig shape:
 * root -> spine -> {armL, armR}, high enough above the floor to fall onto it.
 */
const buildBoneChain = (originY = 10): THREE.Bone[] => {
    const root = new THREE.Bone();
    root.name = 'root';
    root.position.set(0, originY, 0);

    const spine = new THREE.Bone();
    spine.name = 'spine';
    spine.position.set(0, -1.2, 0); // local, relative to root
    root.add(spine);

    const armL = new THREE.Bone();
    armL.name = 'armL';
    armL.position.set(-0.6, -1, 0);
    spine.add(armL);

    const armR = new THREE.Bone();
    armR.name = 'armR';
    armR.position.set(0.6, -1, 0);
    spine.add(armR);

    return [root, spine, armL, armR];
};

/** A synthetic SkinnedMesh (no assets, no loader) wrapping a bone chain - issue #251's requirement. */
const buildSkinnedMesh = (bones: THREE.Bone[]): THREE.SkinnedMesh => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(bones[0]);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    return mesh;
};

const RAGDOLL_TYPES = [
    'JPHString',
    'Vec3',
    'RVec3',
    'Quat',
    'Skeleton',
    'RagdollSettings',
    'Ragdoll',
    'SkeletonPose',
    'CapsuleShape',
    'SwingTwistConstraintSettings',
    'HingeConstraintSettings',
    'FixedConstraintSettings'
];

//* tests -------------------------------------------------------------------------------------

test('buildTemplate builds one capsule + one swingTwist constraint per non-root joint, no leaks', async () => {
    const ps = await newWarmedWorld('ragdoll-buildTemplate');
    const spy = installAllocTracker(Raw, { types: RAGDOLL_TYPES, throwOnDoubleDestroy: false });
    const before = freeMemory();

    const mesh = buildSkinnedMesh(buildBoneChain(30));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton);

    assert.equal(template.joints.length, 4);
    assert.deepEqual(template.parentIndex, [-1, 0, 1, 1]);
    assert.equal(template.settings.mParts.size(), 4);
    assert.equal(template.settings.GetSkeleton().GetJointCount(), 4);

    template.destroy();

    // RagdollSettings' destructor cascades: mSkeleton, every part's CapsuleShape, and every
    // non-root part's SwingTwistConstraintSettings. None of those were destroyed separately -
    // exactly the ownership table in docs/ragdolls.md. `RagdollSettings` itself is ALSO in this
    // list now (issue #275): it's a Jolt RefTarget with no AddRef/Release/GetRefCount exposed to
    // JS, so `buildTemplate()` keeps it alive via an internal "keeper" Ragdoll instead of ever
    // calling `jolt.destroy(settings)` directly - destroying the keeper is what frees it, via
    // Jolt's own refcounting, not a direct destroy() call this tracker would see. `Ragdoll` (the
    // keeper) never appears here itself: it's built by `RagdollSettings.CreateRagdoll()`, not a
    // tracked `new jolt.Ragdoll()` call, so this proxy never sees its construction either.
    assert.deepEqual(
        spy
            .liveDetails()
            .map((d) => d.type)
            .sort(),
        [
            'CapsuleShape',
            'CapsuleShape',
            'CapsuleShape',
            'CapsuleShape',
            'RagdollSettings',
            'Skeleton',
            'SwingTwistConstraintSettings',
            'SwingTwistConstraintSettings',
            'SwingTwistConstraintSettings'
        ].sort(),
        'the set of cascade-owned objects changed - re-check the ownership claims'
    );
    spy.uninstall();
    assert.isAtLeast(
        freeMemory(),
        before - 64,
        'buildTemplate/destroy did not return the wasm heap'
    );

    ps.destroy();
});

test('per-part overrides in `parts` win over the defaults', async () => {
    const ps = await newWarmedWorld('ragdoll-part-overrides');
    const mesh = buildSkinnedMesh(buildBoneChain(6));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton, {
        layer: Layer.RIG,
        parts: {
            spine: { radius: 0.05, constraint: 'fixed' },
            armL: { constraint: 'none' }
        }
    });

    const spinePart = template.settings.mParts.at(1);
    const spineShape = Raw.module.castObject(spinePart.GetShape(), Raw.module.CapsuleShape);
    assert.approximately(spineShape.GetRadius(), 0.05, 1e-6);

    template.destroy();
    ps.destroy();
});

test('spawn() builds a live ragdoll, registers one BodyState per part, and tears down safely', async () => {
    const ps = await newWarmedWorld('ragdoll-spawn-lifecycle');
    const mesh = buildSkinnedMesh(buildBoneChain(15));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton, { layer: Layer.RIG });
    const instance = ps.ragdollSystem.spawn(template);

    assert.equal(instance.ragdoll.GetBodyCount(), 4, 'spawn() did not build a working ragdoll');
    assert.equal(instance.bodyStates.length, 4);
    for (const state of instance.bodyStates) {
        assert.isTrue(ps.bodySystem.dynamicBodies.has(state.handle));
        assert.isFalse(state.disposed);
    }

    step(ps, 5);
    instance.destroy();

    for (const state of instance.bodyStates) {
        assert.isTrue(state.disposed, 'part BodyState was not disposed on instance.destroy()');
        assert.isFalse(
            ps.bodySystem.dynamicBodies.has(state.handle),
            'part body was not unregistered'
        );
        assert.isFalse(ps.bodySystem.bodies.has(state.handle));
    }

    // The world must still be steppable: if RemoveFromPhysicsSystem() had been skipped (or run
    // after destroy(ragdoll)), the very next Step() traps with an out-of-bounds wasm access - see
    // docs/ragdolls.md. This is the one assertion in this file that would surface that as a hard
    // failure rather than a byte-counting mismatch.
    assert.doesNotThrow(() => step(ps, 5), 'the world corrupted after tearing the ragdoll down');

    // spawn() again on the SAME template, after the previous instance was destroyed - issue #275's
    // regression case at the unit level (see "spawn -> destroy -> spawn again... 5 times" below
    // for the dedicated stress test).
    const instance2 = ps.ragdollSystem.spawn(template);
    assert.equal(
        instance2.ragdoll.GetBodyCount(),
        4,
        'respawning on the same template produced an empty ragdoll'
    );
    assert.equal(instance2.bodyStates.length, 4);
    step(ps, 5);
    instance2.destroy();
    assert.doesNotThrow(
        () => step(ps, 5),
        'the world corrupted after tearing the respawned ragdoll down'
    );

    template.destroy();
    ps.destroy();
});

test('a passive ragdoll falls, lands on the floor, and reports onCollisionEnter per part', async () => {
    const ps = await newWarmedWorld('ragdoll-collision-events');
    const mesh = buildSkinnedMesh(buildBoneChain(5));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton); // default layer: MOVING
    const instance = ps.ragdollSystem.spawn(template);

    const enters: string[] = [];
    for (const state of instance.bodyStates) {
        state.on('collisionEnter', (e) => enters.push(e.target.object?.name ?? '?'));
    }

    const startY = instance.bodyStates.map((s) => s.position.y);
    step(ps, 120);

    instance.bodyStates.forEach((s, i) => {
        assert.isBelow(s.position.y, startY[i], `part ${i} did not fall`);
    });
    assert.isAbove(enters.length, 0, 'no part reported landing on the floor');
    // every part's proxy is named after its bone (see RagdollSystem.spawn)
    for (const name of enters) assert.isTrue(['root', 'spine', 'armL', 'armR'].includes(name));

    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('captureStep()/applyInterpolated() and syncPoseNow() agree with a direct GetPose()+writePoseToBones read', async () => {
    const ps = await newWarmedWorld('ragdoll-pose-sync');
    const mesh = buildSkinnedMesh(buildBoneChain(8));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton);
    const instance = ps.ragdollSystem.spawn(template);

    step(ps, 40); // let it fall into a non-trivial pose

    // captureStep() twice (mirrors two physics substeps) so applyInterpolated() has history, then
    // apply with alpha=1 - should land exactly on the pose the second captureStep() read, which is
    // what a direct syncPoseNow() read (also live) should agree with too.
    instance.captureStep();
    instance.captureStep();
    instance.applyInterpolated(1);

    const interpolated = instance.bones.map((b) => ({
        position: b.position.clone(),
        quaternion: b.quaternion.clone()
    }));

    instance.syncPoseNow();
    instance.bones.forEach((bone, i) => {
        assert.approximately(bone.position.x, interpolated[i].position.x, 1e-3, `bone ${i} x`);
        assert.approximately(bone.position.y, interpolated[i].position.y, 1e-3, `bone ${i} y`);
        assert.approximately(bone.position.z, interpolated[i].position.z, 1e-3, `bone ${i} z`);
        const dot = Math.abs(bone.quaternion.dot(interpolated[i].quaternion));
        assert.closeTo(dot, 1, 1e-3, `bone ${i} rotation`);
    });

    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('constraint: swingTwist (default) simulates without NaN', async () => {
    const ps = await newWarmedWorld('ragdoll-constraint-swingTwist');
    const mesh = buildSkinnedMesh(buildBoneChain(12));
    const template: RagdollTemplate = ps.ragdollSystem.buildTemplate(mesh.skeleton, {
        layer: Layer.RIG
    });
    const instance = ps.ragdollSystem.spawn(template);
    step(ps, 30);
    instance.bodyStates.forEach((state, i) => {
        const p = state.position;
        assert.isTrue(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
            `part ${i} went non-finite`
        );
    });
    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('constraint: hinge simulates without NaN', async () => {
    const ps = await newWarmedWorld('ragdoll-constraint-hinge');
    const mesh = buildSkinnedMesh(buildBoneChain(12));
    const template: RagdollTemplate = ps.ragdollSystem.buildTemplate(mesh.skeleton, {
        defaultConstraint: 'hinge',
        layer: Layer.RIG
    });
    const instance = ps.ragdollSystem.spawn(template);
    step(ps, 30);
    instance.bodyStates.forEach((state, i) => {
        const p = state.position;
        assert.isTrue(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
            `part ${i} went non-finite`
        );
    });
    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('constraint: fixed welds parts together (near-zero relative motion)', async () => {
    const ps = await newWarmedWorld('ragdoll-constraint-fixed');
    const mesh = buildSkinnedMesh(buildBoneChain(12));
    const template: RagdollTemplate = ps.ragdollSystem.buildTemplate(mesh.skeleton, {
        defaultConstraint: 'fixed',
        layer: Layer.RIG
    });
    const instance = ps.ragdollSystem.spawn(template);

    const restDistance = instance.bodyStates[0].position.distanceTo(
        instance.bodyStates[1].position
    );
    step(ps, 60);
    const liveDistance = instance.bodyStates[0].position.distanceTo(
        instance.bodyStates[1].position
    );
    assert.approximately(
        liveDistance,
        restDistance,
        0.05,
        'a fixed constraint should not allow the root/spine distance to change'
    );

    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('constraint: none builds a joint with no mToParent, and still simulates without NaN', async () => {
    const ps = await newWarmedWorld('ragdoll-constraint-none');
    const mesh = buildSkinnedMesh(buildBoneChain(12));
    const template: RagdollTemplate = ps.ragdollSystem.buildTemplate(mesh.skeleton, {
        defaultConstraint: 'none',
        layer: Layer.RIG
    });

    const instance = ps.ragdollSystem.spawn(template);
    assert.equal(instance.ragdoll.GetBodyCount(), 4);
    step(ps, 30);
    instance.bodyStates.forEach((state, i) => {
        const p = state.position;
        assert.isTrue(
            Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
            `part ${i} went non-finite`
        );
    });

    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('activate=false spawns a ragdoll that starts asleep', async () => {
    const ps = await newWarmedWorld('ragdoll-activate');
    const mesh = buildSkinnedMesh(buildBoneChain(9));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton, { layer: Layer.RIG });
    const instance = ps.ragdollSystem.spawn(template, { activation: 'deactivate' });

    assert.isFalse(instance.ragdoll.IsActive(), 'ragdoll should start inactive');
    instance.ragdoll.Activate();
    assert.isTrue(instance.ragdoll.IsActive());

    instance.destroy();
    template.destroy();
    ps.destroy();
});

test('spawn -> destroy -> spawn again on the same template and PhysicsSystem, 5 times (issue #275)', async () => {
    const ps = await newWarmedWorld('ragdoll-respawn-stress');
    const mesh = buildSkinnedMesh(buildBoneChain(20));
    const template = ps.ragdollSystem.buildTemplate(mesh.skeleton, { layer: Layer.RIG });

    // baseline is taken AFTER buildTemplate() (which now creates its own internal "keeper"
    // Ragdoll - see the module doc) so the keeper's one-time cost isn't mistaken for a per-cycle
    // leak, matching newWarmedWorld's own warmup rationale above.
    const before = freeMemory();

    for (let cycle = 1; cycle <= 5; cycle++) {
        const instance = ps.ragdollSystem.spawn(template);
        assert.equal(
            instance.ragdoll.GetBodyCount(),
            4,
            `cycle ${cycle}: spawn() produced an empty ragdoll - issue #275 regressed`
        );
        assert.notEqual(
            instance.ragdoll.GetBodyID(0).GetIndexAndSequenceNumber(),
            0,
            `cycle ${cycle}: body 0 is Jolt's invalid-body sentinel`
        );
        assert.equal(instance.bodyStates.length, 4);
        for (const state of instance.bodyStates) assert.isFalse(state.disposed);

        step(ps, 5);

        instance.destroy();
        for (const state of instance.bodyStates) assert.isTrue(state.disposed);
        assert.doesNotThrow(
            () => step(ps, 3),
            `cycle ${cycle}: the world corrupted after tearing the ragdoll down`
        );
    }

    template.destroy();

    assert.isAtLeast(
        freeMemory(),
        before - 128,
        '5 spawn/destroy cycles + template.destroy() did not return the wasm heap'
    );

    ps.destroy();
});
