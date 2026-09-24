// SkeletonSystem (issue #250): maps a three.js Skeleton/Bone hierarchy onto a Jolt Skeleton and
// converts poses between the two. Builds on issue #249's spike - see docs/ragdolls.md and
// test/ragdoll-spike.test.ts for the verified Jolt API facts this file relies on (GetPose() writes
// joint MATRICES not states, CalculateJointMatrices() after GetPose() zeroes them, Skeleton has no
// parent-index getter, RagdollSettings/Ragdoll ownership rules).
//
// One additional fact is pinned down here (not in the #249 spike): whether SkeletonPose's
// per-joint STATES (the ones CalculateJointMatrices() reads) are parent-relative LOCAL transforms
// or already root-relative "model space" like the matrices. A rig with an identity root rotation
// cannot distinguish the two (local composition under an identity parent equals the local value
// itself), so the first test below uses a rotated root specifically to disambiguate.

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Layer } from '../src/constants';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import {
    createJoltSkeleton,
    type JoltSkeletonBuild,
    readPoseFromBones,
    writePoseToBones
} from '../src/systems/skeleton-system';
import { installAllocTracker } from './jolt-alloc';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('skeleton-system');

    // Warm-up: the *first* Skeleton/RagdollPart/body/constraint ever inserted into a fresh
    // world's broadphase settles its free-list pools differently than steady state - see the
    // identical warm-up in ragdoll-spike.test.ts, which measured this precisely (~96KB, one-time,
    // does not recur on repeat cycles). Absorbing that cost here, before any test in this file
    // takes its "before" heap reading, keeps every real assertion below at the tight tolerance
    // `installAllocTracker`/`freeMemory()` checks use everywhere else instead of a bespoke fudge
    // factor per test.
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

//* helpers -------------------------------------------------------------------

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

const step = (frames: number) => {
    for (let i = 0; i < frames; i++) ps.onUpdate(1 / 60);
};

/** A plain, un-parented Bone chain - deliberately not loaded from a GLTF (issue #250 asks for a
 * synthetic rig): root -> spine -> {armL, armR}, matching the shape of ragdoll-spike.test.ts's rig
 * so the two files can be compared, but built as three.js Bones instead of JOINTS descriptors. */
const buildBoneChain = (): THREE.Bone[] => {
    const root = new THREE.Bone();
    root.name = 'root';
    root.position.set(0, 10, 0);

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

const approxVec3 = (a: THREE.Vector3, b: THREE.Vector3, epsilon: number, label: string) => {
    assert.approximately(a.x, b.x, epsilon, `${label}.x`);
    assert.approximately(a.y, b.y, epsilon, `${label}.y`);
    assert.approximately(a.z, b.z, epsilon, `${label}.z`);
};

// Quaternions q and -q represent the same rotation - compare via Dot() instead of components.
const approxQuat = (a: THREE.Quaternion, b: THREE.Quaternion, epsilon: number, label: string) => {
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    assert.closeTo(dot, 1, epsilon, `${label} - quaternions diverged (|dot| = ${dot})`);
};

//* tests -----------------------------------------------------------------------------------

test('CalculateJointMatrices composes local joint STATES through the parent hierarchy into model-space matrices', () => {
    // Disambiguates two possible readings of `SkeletonPose.GetJoint(i)`'s STATES that both fit
    // the #249 spike's identity-root test rig:
    //  A) states are parent-relative LOCAL transforms, and CalculateJointMatrices() walks the
    //     hierarchy: model(i) = model(parent(i)) * local(i).
    //  B) states are already root-relative MODEL space, and CalculateJointMatrices() just repacks
    //     them into Mat44 with no hierarchy composition.
    // A 90-degree root rotation makes the two hypotheses predict different numbers for the
    // child's model-space matrix; an identity root (as in ragdoll-spike.test.ts) cannot.
    const spy = installAllocTracker(Raw, {
        types: ['JPHString', 'Skeleton', 'SkeletonPose'],
        throwOnDoubleDestroy: false
    });
    const jolt = Raw.module;
    const before = freeMemory();

    const skeleton = new jolt.Skeleton();
    const rootName = new jolt.JPHString('root', 4);
    skeleton.AddJoint(rootName, -1);
    jolt.destroy(rootName);
    const childName = new jolt.JPHString('child', 5);
    skeleton.AddJoint(childName, 0);
    jolt.destroy(childName);
    skeleton.CalculateParentJointIndices();

    const pose = new jolt.SkeletonPose();
    pose.SetSkeleton(skeleton);

    // root: translation (1,0,0), rotation = 90 degrees about Z
    const rootState = pose.GetJoint(0);
    rootState.mTranslation.Set(1, 0, 0);
    const half = Math.PI / 4; // 90 degrees total
    rootState.mRotation.Set(0, 0, Math.sin(half), Math.cos(half));

    // child: translation (0,1,0), identity rotation
    const childState = pose.GetJoint(1);
    childState.mTranslation.Set(0, 1, 0);
    childState.mRotation.Set(0, 0, 0, 1);

    pose.CalculateJointMatrices();

    // Root has no parent: both hypotheses agree its matrix equals its own state.
    const rootTranslation = pose.GetJointMatrix(0).GetTranslation();
    assert.approximately(rootTranslation.GetX(), 1, 1e-4);
    assert.approximately(rootTranslation.GetY(), 0, 1e-4);
    assert.approximately(rootTranslation.GetZ(), 0, 1e-4);

    // Hypothesis A predicts (0,0,0): (1,0,0) + Rz90*(0,1,0) = (1,0,0) + (-1,0,0).
    // Hypothesis B predicts (0,1,0): the child's state, uncomposed.
    const childTranslation = pose.GetJointMatrix(1).GetTranslation();
    assert.approximately(
        childTranslation.GetX(),
        0,
        1e-4,
        'child model-space X - states are not being composed through the parent hierarchy ' +
            '(hypothesis A rejected)'
    );
    assert.approximately(
        childTranslation.GetY(),
        0,
        1e-4,
        'child model-space Y - states are not being composed through the parent hierarchy ' +
            '(hypothesis A rejected)'
    );
    assert.approximately(childTranslation.GetZ(), 0, 1e-4);

    jolt.destroy(pose);
    jolt.destroy(skeleton);
    assert.deepEqual(spy.liveDetails(), [], 'skeleton/pose build leaked wasm objects');
    spy.uninstall();
    assert.isAtLeast(freeMemory(), before - 64, 'teardown did not return the wasm heap');
});

test('createJoltSkeleton builds a matching parentIndex from a THREE.Skeleton, preserving bone order/names', () => {
    const spy = installAllocTracker(Raw, {
        types: ['JPHString', 'Skeleton'],
        throwOnDoubleDestroy: false
    });
    const before = freeMemory();

    const bones = buildBoneChain();
    const skeleton = new THREE.Skeleton(bones);

    const build = createJoltSkeleton(skeleton);

    assert.equal(build.skeleton.GetJointCount(), 4);
    assert.deepEqual(
        build.joints.map((b) => b.name),
        ['root', 'spine', 'armL', 'armR'],
        'bone order was not preserved'
    );
    assert.deepEqual(build.parentIndex, [-1, 0, 1, 1]);

    Raw.module.destroy(build.skeleton);
    assert.deepEqual(spy.liveDetails(), [], 'createJoltSkeleton leaked wasm objects');
    spy.uninstall();
    assert.isAtLeast(freeMemory(), before - 64, 'teardown did not return the wasm heap');
});

test('createJoltSkeleton from a root Bone (no THREE.Skeleton wrapper) walks parent-before-child', () => {
    const spy = installAllocTracker(Raw, {
        types: ['JPHString', 'Skeleton'],
        throwOnDoubleDestroy: false
    });
    const before = freeMemory();

    const [root] = buildBoneChain(); // buildBoneChain already parents spine/armL/armR under root
    const build = createJoltSkeleton(root);

    assert.equal(build.skeleton.GetJointCount(), 4);
    assert.deepEqual(
        build.joints.map((b) => b.name),
        ['root', 'spine', 'armL', 'armR']
    );
    assert.deepEqual(build.parentIndex, [-1, 0, 1, 1]);
    assert.isTrue(build.skeleton.AreJointsCorrectlyOrdered());

    Raw.module.destroy(build.skeleton);
    assert.deepEqual(spy.liveDetails(), [], 'createJoltSkeleton leaked wasm objects');
    spy.uninstall();
    assert.isAtLeast(freeMemory(), before - 64, 'teardown did not return the wasm heap');
});

test('readPoseFromBones -> writePoseToBones round trip is identity within epsilon', () => {
    const spy = installAllocTracker(Raw, {
        types: ['JPHString', 'Skeleton', 'SkeletonPose'],
        throwOnDoubleDestroy: false
    });
    const before = freeMemory();

    const sourceBones = buildBoneChain();
    // Give every bone a non-trivial local rotation too, not just translation, so the round trip
    // actually exercises quaternion composition/decomposition, not only vector addition.
    sourceBones.forEach((bone, i) => {
        bone.quaternion.setFromAxisAngle(
            new THREE.Vector3(0, 1, 0).normalize(),
            (i + 1) * 0.3 // distinct, non-identity angle per bone
        );
    });
    sourceBones.forEach((bone) => {
        bone.updateMatrix();
    });

    const build = createJoltSkeleton(sourceBones[0]);
    const pose = new Raw.module.SkeletonPose();
    pose.SetSkeleton(build.skeleton);

    // bones -> pose (states), then CalculateJointMatrices() internally
    readPoseFromBones(build.joints, pose);

    // A second, independent Bone chain (same hierarchy, zeroed transforms) to write the pose back
    // into - proves writePoseToBones doesn't depend on the target bones already holding the
    // source values.
    const targetBones = build.joints.map((b) => {
        const clone = new THREE.Bone();
        clone.name = b.name;
        return clone;
    });

    writePoseToBones(pose, targetBones, build.parentIndex);

    sourceBones.forEach((source, i) => {
        const target = targetBones[i];
        approxVec3(target.position, source.position, 1e-4, `bone ${i} (${source.name}) position`);
        approxQuat(
            target.quaternion,
            source.quaternion,
            1e-4,
            `bone ${i} (${source.name}) rotation`
        );
    });

    Raw.module.destroy(pose);
    Raw.module.destroy(build.skeleton);
    assert.deepEqual(spy.liveDetails(), [], 'round trip leaked wasm objects');
    spy.uninstall();
    assert.isAtLeast(freeMemory(), before - 64, 'teardown did not return the wasm heap');
});

//* Ragdoll GetPose -> bones -> back check -----------------------------------------------------

/** Same 4-joint rig shape as ragdoll-spike.test.ts (root -> spine -> {armL, armR}), described
 * both as a Bone chain (for SkeletonSystem) and as world-space capsule placements (for the
 * RagdollSettings this test builds directly, mirroring buildRagdollSettings() there). */
const RAGDOLL_JOINTS = [
    { name: 'root', parent: -1, pos: [0, 10, 0] as const, capsule: [0.3, 0.2] as const },
    { name: 'spine', parent: 0, pos: [0, 8.8, 0] as const, capsule: [0.25, 0.18] as const },
    { name: 'armL', parent: 1, pos: [-0.6, 7.8, 0] as const, capsule: [0.2, 0.12] as const },
    { name: 'armR', parent: 1, pos: [0.6, 7.8, 0] as const, capsule: [0.2, 0.12] as const }
];

const buildRagdollBones = (): THREE.Bone[] => {
    const bones = RAGDOLL_JOINTS.map((joint) => {
        const bone = new THREE.Bone();
        bone.name = joint.name;
        return bone;
    });
    RAGDOLL_JOINTS.forEach((joint, i) => {
        if (joint.parent < 0) return;
        const parentPos = RAGDOLL_JOINTS[joint.parent].pos;
        // Bone local position = world rest position minus its parent's world rest position (a
        // flat, unrotated rest pose, matching the ragdoll-spike rig).
        bones[i].position.set(
            joint.pos[0] - parentPos[0],
            joint.pos[1] - parentPos[1],
            joint.pos[2] - parentPos[2]
        );
        bones[joint.parent].add(bones[i]);
    });
    const rootPos = RAGDOLL_JOINTS[0].pos;
    bones[0].position.set(rootPos[0], rootPos[1], rootPos[2]);
    return bones;
};

const buildRagdollSettings = (): {
    skeleton: JoltSkeletonBuild;
    settings: Jolt.RagdollSettings;
} => {
    const jolt = Raw.module;
    const bones = buildRagdollBones();
    const skeleton = createJoltSkeleton(bones[0]);

    const settings = new jolt.RagdollSettings();
    settings.mSkeleton = skeleton.skeleton;
    settings.mParts.resize(RAGDOLL_JOINTS.length);

    RAGDOLL_JOINTS.forEach((joint, i) => {
        const part = settings.mParts.at(i);
        const [halfHeight, radius] = joint.capsule;
        part.SetShape(new jolt.CapsuleShape(halfHeight, radius));

        const position = new jolt.RVec3(joint.pos[0], joint.pos[1], joint.pos[2]);
        part.mPosition = position;
        jolt.destroy(position);
        part.mRotation = jolt.Quat.prototype.sIdentity();

        part.mMotionType = jolt.EMotionType_Dynamic;
        part.mObjectLayer = Layer.RIG;

        if (joint.parent >= 0) {
            const parent = RAGDOLL_JOINTS[joint.parent];
            const midpoint: [number, number, number] = [
                (joint.pos[0] + parent.pos[0]) / 2,
                (joint.pos[1] + parent.pos[1]) / 2,
                (joint.pos[2] + parent.pos[2]) / 2
            ];
            const constraint = new jolt.SwingTwistConstraintSettings();
            const jointPos = new jolt.RVec3(midpoint[0], midpoint[1], midpoint[2]);
            constraint.mPosition1 = constraint.mPosition2 = jointPos;
            jolt.destroy(jointPos);
            const twistAxis = new jolt.Vec3(0, 0, 1);
            constraint.mTwistAxis1 = constraint.mTwistAxis2 = twistAxis;
            jolt.destroy(twistAxis);
            const planeAxis = new jolt.Vec3(1, 0, 0);
            constraint.mPlaneAxis1 = constraint.mPlaneAxis2 = planeAxis;
            jolt.destroy(planeAxis);
            constraint.mTwistMinAngle = -0.35;
            constraint.mTwistMaxAngle = 0.35;
            constraint.mNormalHalfConeAngle = 0.79;
            constraint.mPlaneHalfConeAngle = 0.79;
            part.mToParent = constraint;
        }
    });

    return { skeleton, settings };
};

test('Ragdoll.GetPose() -> writePoseToBones -> bones reproduce the same model-space matrices', () => {
    const jolt = Raw.module;
    const before = freeMemory();

    const { skeleton, settings } = buildRagdollSettings();
    settings.Stabilize();
    settings.DisableParentChildCollisions();
    settings.CalculateBodyIndexToConstraintIndex();
    settings.CalculateConstraintIndexToBodyIdxPair();

    const ragdoll = settings.CreateRagdoll(0, 0, ps.joltPhysicsSystem);
    ragdoll.AddToPhysicsSystem(jolt.EActivation_Activate);
    step(60); // let it fall and settle into a non-trivial pose

    const pose = new jolt.SkeletonPose();
    pose.SetSkeleton(settings.GetSkeleton());
    // GetPose() writes joint MATRICES directly - no CalculateJointMatrices() call (see the
    // gotcha in docs/ragdolls.md; calling it here would zero the matrices GetPose() just wrote).
    ragdoll.GetPose(pose, true);

    // Capture the exact model-space matrices writePoseToBones read, via modelMatrixScratch, so
    // the "back" half of this test can compare against them without a second GetPose()/
    // GetJointMatrix() pass (whose static temporaries would otherwise be a second read anyway -
    // this just makes the comparison values explicit rather than re-deriving them).
    const capturedModelMatrices = skeleton.joints.map(() => new THREE.Matrix4());
    const bones = skeleton.joints;
    writePoseToBones(pose, bones, skeleton.parentIndex, {
        modelMatrixScratch: capturedModelMatrices
    });

    // Recompute each bone's model-space matrix purely in three.js, from the LOCAL transforms
    // writePoseToBones just wrote, walking the same parentIndex hierarchy forward this time
    // (model(i) = model(parent(i)) * local(i)) - the mirror image of writePoseToBones's own
    // inverse-multiply. If the two don't match, the local/model conversion round trip is wrong.
    const recomposed = bones.map(() => new THREE.Matrix4());
    bones.forEach((bone, i) => {
        const local = new THREE.Matrix4().compose(
            bone.position,
            bone.quaternion,
            new THREE.Vector3(1, 1, 1)
        );
        const parent = skeleton.parentIndex[i];
        recomposed[i] = parent >= 0 ? recomposed[parent].clone().multiply(local) : local;
    });

    bones.forEach((bone, i) => {
        const expected = new THREE.Vector3();
        const expectedQuat = new THREE.Quaternion();
        capturedModelMatrices[i].decompose(expected, expectedQuat, new THREE.Vector3());
        const actual = new THREE.Vector3();
        const actualQuat = new THREE.Quaternion();
        recomposed[i].decompose(actual, actualQuat, new THREE.Vector3());

        approxVec3(actual, expected, 1e-3, `joint ${i} (${bone.name}) recomposed model position`);
        approxQuat(
            actualQuat,
            expectedQuat,
            1e-3,
            `joint ${i} (${bone.name}) recomposed model rotation`
        );
    });

    // Sanity: the ragdoll actually fell (matches ragdoll-spike.test.ts's main assertion) so this
    // isn't trivially passing on an all-zero pose.
    const rootOffset = pose.GetRootOffset();
    assert.isBelow(rootOffset.GetY(), 10, 'root did not fall - rig is not exercising a real pose');

    ragdoll.RemoveFromPhysicsSystem();
    jolt.destroy(ragdoll);
    jolt.destroy(pose);
    jolt.destroy(settings);

    assert.isAtLeast(
        freeMemory(),
        before - 512,
        'ragdoll+settings+pose teardown did not return the wasm heap'
    );
});
