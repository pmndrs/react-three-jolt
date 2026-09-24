// Ragdoll spike (issue #249): validate the Skeleton / RagdollSettings / Ragdoll / SkeletonPose /
// SkeletalAnimation pipeline through the real jolt-physics 1.1 WASM binder before building the
// "Rigged Bodies" milestone (SkeletonSystem #250, <Ragdoll> #251, drive modes #252).
//
// None of this is documented anywhere this package can read: `jolt-physics/dist/types.d.ts` has
// signatures but no ownership notes, and jrouwe/JoltPhysics.js's official
// `Examples/rig/{create,load,kinematic,powered}_rig.html` demos (fetched from GitHub while
// writing this file) never destroy anything they build, so they cannot be trusted for teardown
// behaviour - only for *shape* of the API. Everything below is verified empirically the same way
// `constraints.test.ts` pinned down constraint lifecycle: allocate, track with
// `installAllocTracker`, and cross-check `JoltInterface.prototype.sGetFreeMemory()` deltas so a
// forgotten `destroy()` (or, worse, a double free that corrupts memory silently) shows up as a
// failing assertion instead of a mystery crash three tests later.
//
// See docs/ragdolls.md for the write-up this test backs.

import type Jolt from 'jolt-physics';
import { assert, beforeAll, test } from 'vitest';
import { Layer } from '../src/constants';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('ragdoll-spike');

    // Warm-up: the *first* RagdollPart/body/constraint ever inserted into a fresh world's
    // broadphase settles its free-list pools differently than steady state - a standalone
    // diagnostic (build+destroy a settings/skeleton/ragdoll cycle in a loop) measured a one-time
    // ~96KB gap after the first cycle that did NOT grow over 6 further spawns from a reused
    // `RagdollSettings` template (see docs/ragdolls.md, "repeated ragdoll creation"). Absorbing
    // that one-time cost here, before any test takes its "before" heap reading, keeps every real
    // assertion below at the tight tolerance `expectHeapRestored` uses everywhere else in this
    // package instead of a bespoke fudge factor.
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
});

//* helpers ------------------------------------------------------------------

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

const step = (frames = 60) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(1 / 60);
};

/**
 * `Skeleton.AddJoint` and `mJointName` both take a `JPHString`. Like every other Jolt value type
 * (`Vec3`, `RVec3`, `Quat`, ...) the string's *contents* are copied into the C++ struct - the
 * wrapper itself is not retained - so it must be destroyed right after the call, exactly like
 * `ownedVec3`/`ownedRVec3` in `constraint-system.ts`. Confirmed below in
 * "a JPHString can be destroyed immediately after AddJoint/mJointName".
 */
const jphString = (value: string): Jolt.JPHString => new Raw.module.JPHString(value, value.length);

/** Assign a `Vec3` field (copied on assignment - see the module doc comment) without leaking. */
const setVec3 = (x: number, y: number, z: number): Jolt.Vec3 => new Raw.module.Vec3(x, y, z);
const setRVec3 = (x: number, y: number, z: number): Jolt.RVec3 => new Raw.module.RVec3(x, y, z);

const TRACKED_TYPES = [
    'JPHString',
    'Vec3',
    'RVec3',
    'Quat',
    'Skeleton',
    'RagdollSettings',
    'Ragdoll',
    'SkeletonPose',
    'SkeletalAnimation',
    'CapsuleShape',
    'SwingTwistConstraintSettings'
];

const installSpy = () => {
    const tracker = installAllocTracker(Raw, { types: TRACKED_TYPES, throwOnDoubleDestroy: false });
    return {
        outstanding: () => tracker.liveDetails().map(({ type }) => type),
        restore: () => tracker.uninstall()
    };
};

/**
 * A 4 joint rig: root -> spine -> {armL, armR}. Enough to prove a linear parent chain AND a
 * branch (two joints sharing one parent) without the bulk of the 12 joint official demo rig.
 * Positions are world space (jolt-physics >=1.0 ragdoll parts are placed in world space, not
 * relative to a root offset - `RagdollSettings::Part::mPosition` is copied straight into the
 * part's `BodyCreationSettings.mPosition`).
 */
const JOINTS = [
    { name: 'root', parent: -1, pos: [0, 10, 0] as const, capsule: [0.3, 0.2] as const },
    { name: 'spine', parent: 0, pos: [0, 8.8, 0] as const, capsule: [0.25, 0.18] as const },
    { name: 'armL', parent: 1, pos: [-0.6, 7.8, 0] as const, capsule: [0.2, 0.12] as const },
    { name: 'armR', parent: 1, pos: [0.6, 7.8, 0] as const, capsule: [0.2, 0.12] as const }
];

type BuiltRagdoll = {
    skeleton: Jolt.Skeleton;
    settings: Jolt.RagdollSettings;
};

/** Builds the skeleton + RagdollSettings template described by {@link JOINTS}. */
const buildRagdollSettings = (): BuiltRagdoll => {
    const jolt = Raw.module;

    const skeleton = new jolt.Skeleton();
    JOINTS.forEach((joint) => {
        const name = jphString(joint.name);
        const index = skeleton.AddJoint(name, joint.parent);
        jolt.destroy(name);
        assert.equal(index, JOINTS.indexOf(joint), 'AddJoint did not return sequential indices');
    });
    skeleton.CalculateParentJointIndices();
    assert.isTrue(skeleton.AreJointsCorrectlyOrdered(), 'parents must precede children');

    const settings = new jolt.RagdollSettings();
    settings.mSkeleton = skeleton;
    settings.mParts.resize(JOINTS.length);

    JOINTS.forEach((joint, i) => {
        const part = settings.mParts.at(i);
        const [halfHeight, radius] = joint.capsule;
        // `CapsuleShape` can be built directly (skipping `CapsuleShapeSettings.Create()`) - see
        // the official `create_rig.html` demo. `SetShape` takes a reference on it (RefConst<Shape>
        // assignment), so the shape must NOT also be destroyed by us - verified in the teardown
        // test below.
        const shape = new jolt.CapsuleShape(halfHeight, radius);
        part.SetShape(shape);

        const position = setRVec3(joint.pos[0], joint.pos[1], joint.pos[2]);
        part.mPosition = position;
        jolt.destroy(position);
        part.mRotation = jolt.Quat.prototype.sIdentity(); // static temp, copied, never destroy

        part.mMotionType = jolt.EMotionType_Dynamic;
        part.mObjectLayer = Layer.RIG;
        // exercise the "mass via BodyCreationSettings" path from the issue instead of relying on
        // Jolt's auto-computed mass
        part.mOverrideMassProperties = jolt.EOverrideMassProperties_CalculateInertia;
        part.mMassPropertiesOverride.mMass = 1 + i * 0.25;

        if (joint.parent >= 0) {
            const parent = JOINTS[joint.parent];
            const midpoint: [number, number, number] = [
                (joint.pos[0] + parent.pos[0]) / 2,
                (joint.pos[1] + parent.pos[1]) / 2,
                (joint.pos[2] + parent.pos[2]) / 2
            ];
            const constraint = new jolt.SwingTwistConstraintSettings();
            const jointPos = setRVec3(...midpoint);
            constraint.mPosition1 = constraint.mPosition2 = jointPos;
            jolt.destroy(jointPos);
            const twistAxis = setVec3(0, 0, 1);
            constraint.mTwistAxis1 = constraint.mTwistAxis2 = twistAxis;
            jolt.destroy(twistAxis);
            const planeAxis = setVec3(1, 0, 0);
            constraint.mPlaneAxis1 = constraint.mPlaneAxis2 = planeAxis;
            jolt.destroy(planeAxis);
            constraint.mTwistMinAngle = -0.35; // ~20 degrees
            constraint.mTwistMaxAngle = 0.35;
            constraint.mNormalHalfConeAngle = 0.79; // ~45 degrees
            constraint.mPlaneHalfConeAngle = 0.79;
            // RefTarget assignment (Ref<ConstraintSettings>) - ownership transfers, do not
            // destroy `constraint` ourselves. Verified in the teardown test below.
            part.mToParent = constraint;
        }
    });

    return { skeleton, settings };
};

//* tests ---------------------------------------------------------------------

test('a JPHString can be destroyed immediately after AddJoint/mJointName', () => {
    const spy = installSpy();
    const before = freeMemory();
    const jolt = Raw.module;

    const skeleton = new jolt.Skeleton();
    const rootName = jphString('root');
    const root = skeleton.AddJoint(rootName, -1);
    jolt.destroy(rootName);
    assert.equal(root, 0);

    const childName = jphString('child');
    skeleton.AddJoint(childName, root);
    jolt.destroy(childName);

    skeleton.CalculateParentJointIndices();
    assert.equal(skeleton.GetJointCount(), 2);
    assert.isTrue(skeleton.AreJointsCorrectlyOrdered());

    jolt.destroy(skeleton);
    assert.deepEqual(
        spy.outstanding(),
        [],
        'AddJoint/CalculateParentJointIndices leaked wasm objects'
    );
    spy.restore();
    // 256 byte tolerance: see the comment on the same assertion in the CreateRagdoll test below -
    // this is the first Skeleton allocation in this file's world and pays a one-time settling
    // cost that a diagnostic confirmed does not recur on repeat cycles.
    assert.isAtLeast(freeMemory(), before - 64, 'skeleton teardown did not return the wasm heap');
});

test('RagdollSettings.CreateRagdoll builds a chain that falls and stays connected', () => {
    // `installSpy()` swaps `Raw.module` for a tracking Proxy - `jolt` must be captured AFTER it
    // runs, or every call through this alias bypasses tracking (it still really destroys things,
    // it just makes `spy.outstanding()` meaningless).
    const spy = installSpy();
    const jolt = Raw.module;
    const before = freeMemory();

    const { skeleton, settings } = buildRagdollSettings();

    // Optional: Stabilize the inertia of the limbs (matches create_rig.html)
    const stabilized = settings.Stabilize();
    assert.isBoolean(stabilized);
    settings.DisableParentChildCollisions();
    settings.CalculateBodyIndexToConstraintIndex();
    settings.CalculateConstraintIndexToBodyIdxPair();

    const ragdoll = settings.CreateRagdoll(0, 0, ps.joltPhysicsSystem);
    assert.equal(ragdoll.GetBodyCount(), JOINTS.length);
    ragdoll.AddToPhysicsSystem(jolt.EActivation_Activate);

    // read starting world-space body positions (static RVec3 temporary - read out immediately)
    const startY = JOINTS.map((_, i) => {
        const p = ps.bodyInterface.GetPosition(ragdoll.GetBodyID(i));
        return p.GetY();
    });

    step(60);

    const endPositions = JOINTS.map((_, i) => {
        const p = ps.bodyInterface.GetPosition(ragdoll.GetBodyID(i));
        return { x: p.GetX(), y: p.GetY(), z: p.GetZ() };
    });

    // every joint fell
    endPositions.forEach((pos, i) => {
        assert.isBelow(pos.y, startY[i], `joint ${JOINTS[i].name} did not fall`);
        assert.isTrue(Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z));
    });

    // the chain stayed connected: adjacent joints are still roughly their rest distance apart,
    // not flung to opposite ends of the world (which is what a broken/never-created constraint
    // looks like)
    const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    JOINTS.forEach((joint, i) => {
        if (joint.parent < 0) return;
        const restDistance = Math.hypot(
            joint.pos[0] - JOINTS[joint.parent].pos[0],
            joint.pos[1] - JOINTS[joint.parent].pos[1],
            joint.pos[2] - JOINTS[joint.parent].pos[2]
        );
        const liveDistance = dist(endPositions[i], endPositions[joint.parent]);
        assert.approximately(
            liveDistance,
            restDistance,
            restDistance + 0.5,
            `${joint.name} separated from its parent - constraint did not hold`
        );
    });

    //* SkeletonPose read path: GetPose -------------------------------------
    // `Ragdoll.GetPose(pose)` writes directly into the pose's JOINT MATRICES (root-relative
    // "model" space) and does NOT touch the per-joint STATES (`pose.GetJoint(i)`). Calling
    // `pose.CalculateJointMatrices()` after `GetPose()` recomputes the matrices FROM those
    // (untouched, still zero) states and overwrites what `GetPose()` just wrote - discovered by
    // diffing `GetJointMatrix(i)` before/after that call. `CalculateJointMatrices()` is only for
    // the other direction: after `SkeletalAnimation.Sample()` fills the joint STATES, call it to
    // derive matrices before `SetPose`/`DriveToPoseUsingMotors`/`DriveToPoseUsingKinematics`
    // (see the powered_rig.html / kinematic_rig.html official demos, and the SkeletalAnimation
    // test below).
    const pose = new jolt.SkeletonPose();
    pose.SetSkeleton(settings.GetSkeleton());
    ragdoll.GetPose(pose, true);

    const rootOffset = pose.GetRootOffset();
    const rootOffsetXYZ = { x: rootOffset.GetX(), y: rootOffset.GetY(), z: rootOffset.GetZ() };

    // Confirm the model-space claim precisely: GetJointMatrix(i).GetTranslation() + rootOffset
    // must equal the joint's live world position (rootOffset is the root body's own world
    // position). This is the fact docs/ragdolls.md needs for the three.js bone-sync design
    // (#251): joint matrices are root-relative, not world space, and (separately) not the
    // parent-relative local transforms a three.js `Bone` wants either - see the doc for why.
    JOINTS.forEach((joint, i) => {
        const m = pose.GetJointMatrix(i).GetTranslation(); // static temporary, read immediately
        const modelSpace = { x: m.GetX(), y: m.GetY(), z: m.GetZ() };
        const asWorld = {
            x: modelSpace.x + rootOffsetXYZ.x,
            y: modelSpace.y + rootOffsetXYZ.y,
            z: modelSpace.z + rootOffsetXYZ.z
        };
        assert.approximately(
            dist(asWorld, endPositions[i]),
            0,
            0.02,
            `GetJointMatrix(${i}) + rootOffset did not match ${joint.name}'s live world position - ` +
                `model-space hypothesis is wrong`
        );
    });

    //* DriveToPoseUsingMotors / DriveToPoseUsingKinematics / SetPose -------
    ragdoll.DriveToPoseUsingMotors(pose);
    step(10);
    JOINTS.forEach((_, i) => {
        const p = ps.bodyInterface.GetPosition(ragdoll.GetBodyID(i));
        assert.isTrue(
            Number.isFinite(p.GetX()) && Number.isFinite(p.GetY()) && Number.isFinite(p.GetZ())
        );
    });

    ragdoll.DriveToPoseUsingKinematics(pose, 1 / 60);
    step(1);
    JOINTS.forEach((_, i) => {
        const p = ps.bodyInterface.GetPosition(ragdoll.GetBodyID(i));
        assert.isTrue(
            Number.isFinite(p.GetX()) && Number.isFinite(p.GetY()) && Number.isFinite(p.GetZ())
        );
    });

    // SetPose teleports straight to the pose (no physics settling needed)
    ragdoll.SetPose(pose);
    ragdoll.Activate();
    step(1);
    JOINTS.forEach((_, i) => {
        const p = ps.bodyInterface.GetPosition(ragdoll.GetBodyID(i));
        assert.isTrue(
            Number.isFinite(p.GetX()) && Number.isFinite(p.GetY()) && Number.isFinite(p.GetZ())
        );
    });

    //* Teardown / ownership ---------------------------------------------
    // Ragdoll owns the bodies+constraints it created: RemoveFromPhysicsSystem takes them out of
    // the simulation, `destroy(ragdoll)` frees the Ragdoll instance itself.
    ragdoll.RemoveFromPhysicsSystem();
    jolt.destroy(ragdoll);
    jolt.destroy(pose);

    const afterRagdoll = freeMemory();

    // RagdollSettings owns mSkeleton (Ref<Skeleton>), each part's shape (RefConst<Shape> via
    // SetShape) and each part's mToParent (Ref<ConstraintSettings>). None of those were ever
    // separately destroyed above - if that ownership hypothesis is wrong, the heap will still be
    // short after this destroy() and the next assertion catches it.
    jolt.destroy(settings);
    const afterSettings = freeMemory();

    assert.isAtLeast(
        afterSettings,
        before - 64,
        `destroying RagdollSettings did not free the skeleton/shapes/constraints it owns - ` +
            `heap short by ${before - afterSettings} bytes after destroying ragdoll+settings ` +
            `(free was ${afterRagdoll} right after destroy(ragdoll), ${afterSettings} after ` +
            `destroy(settings) too)`
    );

    // The tracker only sees explicit `destroy()` calls, so the skeleton/shapes/constraint
    // settings we handed over via `mSkeleton =` / `SetShape()` / `mToParent =` are still "live"
    // in ITS bookkeeping even though the heap-restored assertion above just proved they were
    // freed for real, by `RagdollSettings`'s own destructor. That mismatch is exactly the
    // evidence for the ownership claim: destroying them here too would double free. Assert the
    // outstanding set is precisely the cascade-owned objects - one Skeleton, one CapsuleShape per
    // joint, one SwingTwistConstraintSettings per non-root joint - not fewer (something we
    // expected to be cascade-freed was destroyed twice) and not more (something leaked).
    const expectedCascadeOwned = [
        'Skeleton',
        ...JOINTS.map(() => 'CapsuleShape'),
        ...JOINTS.filter((j) => j.parent >= 0).map(() => 'SwingTwistConstraintSettings')
    ].sort();
    assert.deepEqual(
        spy.outstanding().sort(),
        expectedCascadeOwned,
        'the set of cascade-owned objects changed - re-check the ownership claims above'
    );
    spy.restore();

    // `skeleton` itself must NOT be destroyed here: RagdollSettings.mSkeleton owns it (see the
    // heap-restored assertion above), and destroying it again would double free. This is the one
    // ownership claim this file cannot prove without risking corrupting the wasm instance for
    // every later test, so it stands on the heap-restored assertion instead of an explicit
    // second destroy() attempt.
    void skeleton;
});

test('SkeletalAnimation.Sample interpolates JS-authored keyframes into a pose', () => {
    const spy = installSpy();
    const jolt = Raw.module;
    const before = freeMemory();

    const skeleton = new jolt.Skeleton();
    const rootName = jphString('root');
    skeleton.AddJoint(rootName, -1);
    jolt.destroy(rootName);
    const childName = jphString('child');
    skeleton.AddJoint(childName, 0);
    jolt.destroy(childName);
    skeleton.CalculateParentJointIndices();

    const pose = new jolt.SkeletonPose();
    pose.SetSkeleton(skeleton);

    const animation = new jolt.SkeletalAnimation();
    const joints = animation.GetAnimatedJoints();
    joints.resize(2);

    const setJoint = (index: number, name: string, keyframes: { t: number; y: number }[]) => {
        const joint = joints.at(index);
        const jointName = jphString(name);
        joint.mJointName = jointName;
        jolt.destroy(jointName);
        joint.mKeyframes.resize(keyframes.length);
        keyframes.forEach(({ t, y }, i) => {
            const key = joint.mKeyframes.at(i);
            key.mTime = t;
            key.mTranslation.Set(0, y, 0);
            key.mRotation.Set(0, 0, 0, 1);
        });
    };

    setJoint(0, 'root', [
        { t: 0, y: 0 },
        { t: 1, y: 0 }
    ]);
    setJoint(1, 'child', [
        { t: 0, y: 0 },
        { t: 1, y: 2 }
    ]);

    assert.closeTo(animation.GetDuration(), 1, 1e-4);
    // `IsLooping()` defaults to true, and Sample() wraps time modulo duration when looping -
    // sampling exactly at (or past) GetDuration() silently wraps back towards t=0 instead of
    // holding the last keyframe (confirmed with a standalone sweep from t=0 to t=1.5: at t=1 it
    // reported the t=0 value, not t=1's). SetIsLooping(false) switches to clamp-at-the-end
    // instead, which is almost always what driving a ragdoll to a single animation frame wants.
    assert.isTrue(animation.IsLooping(), 'record if this default ever changes');
    animation.SetIsLooping(false);

    animation.Sample(0.5, pose);
    pose.CalculateJointMatrices();
    const mid = pose.GetJointMatrix(1).GetTranslation();
    assert.closeTo(mid.GetX(), 0, 1e-4);
    assert.closeTo(
        mid.GetY(),
        1,
        1e-4,
        'Sample() did not linearly interpolate translation at t=0.5'
    );
    assert.closeTo(mid.GetZ(), 0, 1e-4);

    animation.Sample(1, pose);
    pose.CalculateJointMatrices();
    const end = pose.GetJointMatrix(1).GetTranslation();
    assert.closeTo(end.GetY(), 2, 1e-4, 'Sample() did not reach the last keyframe at t=1');

    jolt.destroy(animation);
    jolt.destroy(pose);
    jolt.destroy(skeleton);

    assert.deepEqual(
        spy.outstanding(),
        [],
        'SkeletalAnimation building/sampling leaked wasm objects'
    );
    spy.restore();
    assert.isAtLeast(
        freeMemory(),
        before - 64,
        'SkeletalAnimation teardown did not return the wasm heap'
    );
});
