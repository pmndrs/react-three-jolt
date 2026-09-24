// SkeletonSystem (issue #250): maps a three.js `Skeleton`/`Bone` hierarchy onto a Jolt `Skeleton`
// and converts poses between the two. Pure data plumbing - nothing here simulates anything - built
// on the empirical findings in docs/ragdolls.md (issue #249's spike, `test/ragdoll-spike.test.ts`).
// Consumed by `<Ragdoll>` (#251) and drive modes (#252).
//
// Two facts from docs/ragdolls.md drive every design choice below:
//  - `Jolt.Skeleton` never gives back a joint's parent index or name once added
//    (`AddJoint`/`CalculateParentJointIndices` are write-only), so this module keeps its own
//    `parentIndex: number[]` alongside every `Jolt.Skeleton` it builds.
//  - `SkeletonPose.GetJointMatrix(i)` is root-relative "model space", not a three.js `Bone`'s
//    parent-relative "local" space, so converting one to the other requires walking the hierarchy
//    with that `parentIndex[]` array - `local(i) = inverse(model(parent(i))) * model(i)`.
//
// One additional fact was verified for this issue (see "CalculateJointMatrices composes local
// joint STATES..." in skeleton-system.test.ts, which pins it down with a non-identity root
// rotation so the two hypotheses give different numbers): `SkeletonPose`'s per-joint STATES
// (`GetJoint(i).mTranslation`/`mRotation`, the ones `SkeletalAnimation.Sample()` writes and
// `CalculateJointMatrices()` reads) are parent-relative LOCAL transforms - the exact same space a
// three.js `Bone`'s `position`/`quaternion` already live in. That makes `readPoseFromBones` a
// direct per-joint copy with no hierarchy walk, unlike `writePoseToBones`.

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import { devWarn } from '../utils';

//* Public types ============================================================================

export interface JoltSkeletonBuild {
    /**
     * Caller-owned. Typical next step is `RagdollSettings.mSkeleton = skeleton` (ownership
     * transfers to the settings object on assignment - see docs/ragdolls.md's ownership table,
     * do not also destroy it yourself once assigned) or, if it is never turned into a ragdoll,
     * `Raw.module.destroy(skeleton)` directly.
     */
    skeleton: Jolt.Skeleton;
    /** The bones, indexed identically to the Jolt skeleton's joints: `joints[i]` <-> joint `i`. */
    joints: THREE.Bone[];
    /**
     * `joints[i]`'s parent's index within `joints`, or `-1` for a root joint. `Jolt.Skeleton` will
     * not give this back once built (see the module doc comment), so every other function in this
     * file that needs the hierarchy (`writePoseToBones`) takes it as an explicit argument - keep
     * this array alongside `joints` for the lifetime of anything built from it.
     */
    parentIndex: number[];
}

export interface WritePoseToBonesOptions {
    /**
     * Reuse across frames to avoid allocating `bones.length` `Matrix4`s per call - pass the same
     * array back in every frame (any length >= `bones.length`; only the first `bones.length`
     * entries are touched). A fresh array is allocated for this call only when omitted.
     */
    modelMatrixScratch?: THREE.Matrix4[];
    /**
     * Object whose local `position` receives `pose.GetRootOffset()` (the root joint's live
     * WORLD position - see docs/ragdolls.md) converted into `root.parent`'s local space. Left
     * untouched if omitted, which is correct when the caller places the bone hierarchy itself
     * (e.g. by driving `joints[0]`'s parent directly).
     */
    root?: THREE.Object3D;
    /**
     * The bones' owning `SkinnedMesh`. When given, the root offset is expressed in the mesh's
     * bind space via `bindMatrixInverse` before being written to `root` - meaningful when `root`
     * is the mesh itself (or shares its bind-time frame). **Not verified against a real skinned/
     * exported rig** (only against an identity `bindMatrix`, see skeleton-system.test.ts) - treat
     * as a best-effort convenience and re-check against a GLTF-loaded character before relying on
     * it for anything but an identity bind matrix.
     */
    skinnedMesh?: THREE.SkinnedMesh;
}

//* createJoltSkeleton ========================================================================

/**
 * Builds a `Jolt.Skeleton` from a three.js `Skeleton` or a root `Bone`, preserving bone order and
 * names.
 *
 * - `THREE.Skeleton`: joints are `skeleton.bones`, in that exact order (its order is preserved,
 *   never re-sorted) - `parentIndex[i]` is `bones[i].parent`'s index within `bones`, or `-1` when
 *   the parent isn't itself one of `bones` (the usual case for the root bone, whose parent is
 *   some non-`Bone` container).
 * - `THREE.Bone` (a root): joints are collected with a pre-order depth-first walk of `Bone`
 *   children only, which always visits a parent before its children - the ordering
 *   `Skeleton.AddJoint` requires (`AreJointsCorrectlyOrdered()`).
 *
 * The returned `skeleton` is a real WASM allocation the caller owns - see `JoltSkeletonBuild`.
 */
export function createJoltSkeleton(source: THREE.Skeleton | THREE.Bone): JoltSkeletonBuild {
    const { joints, parentIndex } = collectJoints(source);

    const jolt = Raw.module;
    const skeleton = new jolt.Skeleton();

    joints.forEach((bone, i) => {
        const jointName = bone.name || `bone_${i}`;
        // `Skeleton.AddJoint` copies the JPHString's *content* on the call - the wrapper itself
        // must be destroyed right after, exactly like `ownedVec3` elsewhere in this package (see
        // docs/ragdolls.md, "JPHString").
        const name = new jolt.JPHString(jointName, jointName.length);
        const index = skeleton.AddJoint(name, parentIndex[i]);
        jolt.destroy(name);
        if (index !== i) {
            devWarn(
                `createJoltSkeleton: joint '${jointName}' got Jolt index ${index}, expected ${i} - ` +
                    `parentIndex/joints will be out of sync with the Jolt skeleton`
            );
        }
    });

    skeleton.CalculateParentJointIndices();
    if (!skeleton.AreJointsCorrectlyOrdered()) {
        devWarn(
            "createJoltSkeleton: joints are not correctly ordered (a joint's parent must be " +
                'added before it) - reorder the source bones/skeleton so parents precede children'
        );
    }

    return { skeleton, joints, parentIndex };
}

function collectJoints(source: THREE.Skeleton | THREE.Bone): {
    joints: THREE.Bone[];
    parentIndex: number[];
} {
    if (source instanceof THREE.Skeleton) {
        const joints = source.bones;
        const parentIndex = joints.map((bone) => {
            const parent = bone.parent;
            if (!parent || !(parent instanceof THREE.Bone)) return -1;
            return joints.indexOf(parent);
        });
        return { joints, parentIndex };
    }

    // A root Bone: pre-order DFS over Bone children only, so parents always precede children.
    const joints: THREE.Bone[] = [];
    const parentIndex: number[] = [];
    const visit = (bone: THREE.Bone, parent: number) => {
        const index = joints.length;
        joints.push(bone);
        parentIndex.push(parent);
        for (const child of bone.children) {
            if (child instanceof THREE.Bone) visit(child, index);
        }
    };
    visit(source, -1);
    return { joints, parentIndex };
}

//* readPoseFromBones =========================================================================

/**
 * Writes each bone's LOCAL transform (`position`/`quaternion`, parent-relative) into `pose`'s
 * per-joint STATES, then calls `pose.CalculateJointMatrices()` so the pose is immediately usable
 * with `Ragdoll.SetPose`/`DriveToPoseUsingKinematics`/`DriveToPoseUsingMotors` - the same
 * "populate states, then derive matrices" sequence `SkeletalAnimation.Sample()` requires (see the
 * "GetPose() vs CalculateJointMatrices()" gotcha in docs/ragdolls.md).
 *
 * `bones[i]` must correspond to Jolt joint `i` (the `joints` array `createJoltSkeleton` returned,
 * in the same order). Bone `scale` is ignored - `SkeletalAnimationJointState` has no scale field.
 *
 * `pose` must already have `SetSkeleton()` called with a skeleton whose joint count/order matches
 * `bones` (typically the one `createJoltSkeleton` built).
 */
export function readPoseFromBones(bones: THREE.Bone[], pose: Jolt.SkeletonPose): void {
    const count = Math.min(bones.length, pose.GetJointCount());
    for (let i = 0; i < count; i++) {
        const bone = bones[i];
        const state = pose.GetJoint(i);
        // mTranslation/mRotation are live references into the pose - mutate in place with
        // .Set(), never reassign (see docs/ragdolls.md, SkeletalAnimationJointState).
        state.mTranslation.Set(bone.position.x, bone.position.y, bone.position.z);
        state.mRotation.Set(
            bone.quaternion.x,
            bone.quaternion.y,
            bone.quaternion.z,
            bone.quaternion.w
        );
    }
    pose.CalculateJointMatrices();
}

//* writePoseToBones ==========================================================================

// Module-level scratch: this runs per frame from <Ragdoll> (#251), so avoid allocating three.js
// objects (not WASM memory - ordinary GC churn) for the parts that don't need to persist a value
// across calls. `modelMatrixScratch` is the one part callers may want to persist themselves,
// since its size depends on the joint count (see WritePoseToBonesOptions).
const _translation = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _unitScale = new THREE.Vector3(1, 1, 1);
const _localMatrix = new THREE.Matrix4();
const _decomposedPosition = new THREE.Vector3();
const _decomposedQuaternion = new THREE.Quaternion();
const _decomposedScale = new THREE.Vector3();
const _rootWorld = new THREE.Vector3();

/**
 * Converts `pose`'s per-joint MATRICES (root-relative "model space" - what `Ragdoll.GetPose()`
 * writes, see docs/ragdolls.md) into each bone's LOCAL transform (`position`/`quaternion`,
 * parent-relative - what a three.js `Bone` wants) and writes it onto `bones`.
 *
 * `Jolt.Skeleton` will not give back a joint's parent index (see the module doc comment), so
 * `parentIndex` must be supplied explicitly - typically the array `createJoltSkeleton` returned
 * alongside `bones`. This is the one deliberate deviation from issue #250's `writePoseToBones(pose,
 * bones)` shorthand signature: the hierarchy walk below is impossible without it.
 *
 * Implementation note: `pose.GetJointMatrix(i)` is the WebIDL binder's one static temporary for
 * that function (see docs/Memory.md / docs/ragdolls.md) - every joint's translation/rotation is
 * read out of it immediately into an owned `THREE.Matrix4` in a first pass, before any hierarchy
 * math runs, so the second pass never depends on a Jolt-side temporary that a later
 * `GetJointMatrix` call may have already overwritten.
 *
 * `bone.scale` is left untouched: Jolt joint matrices carry no scale, so writing a decomposed
 * scale back would silently reset any authored non-uniform bone scale to 1.
 */
export function writePoseToBones(
    pose: Jolt.SkeletonPose,
    bones: THREE.Bone[],
    parentIndex: number[],
    options?: WritePoseToBonesOptions
): void {
    const count = Math.min(bones.length, parentIndex.length, pose.GetJointCount());
    const modelMatrices = options?.modelMatrixScratch ?? bones.map(() => new THREE.Matrix4());

    // Pass 1: read every joint's model-space matrix out of Jolt into an owned three.js Matrix4.
    for (let i = 0; i < count; i++) {
        const matrix = pose.GetJointMatrix(i);
        const t = matrix.GetTranslation();
        _translation.set(t.GetX(), t.GetY(), t.GetZ());
        const q = matrix.GetQuaternion();
        _rotation.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
        modelMatrices[i].compose(_translation, _rotation, _unitScale);
    }

    // Pass 2: pure three.js math, no more Jolt calls - walk the hierarchy this package tracked
    // itself (parentIndex) to turn each model-space matrix into a parent-relative local one.
    for (let i = 0; i < count; i++) {
        const parent = parentIndex[i];
        const local = parent >= 0 ? _localMatrix.copy(modelMatrices[parent]) : modelMatrices[i];
        if (parent >= 0) {
            local.invert().multiply(modelMatrices[i]);
        }
        local.decompose(_decomposedPosition, _decomposedQuaternion, _decomposedScale);
        bones[i].position.copy(_decomposedPosition);
        bones[i].quaternion.copy(_decomposedQuaternion);
    }

    if (options?.root) {
        const rootOffset = pose.GetRootOffset(); // RVec3, static temp - read immediately
        _rootWorld.set(rootOffset.GetX(), rootOffset.GetY(), rootOffset.GetZ());
        if (options.skinnedMesh) {
            _rootWorld.applyMatrix4(options.skinnedMesh.bindMatrixInverse);
        }
        if (options.root.parent) {
            options.root.parent.updateWorldMatrix(true, false);
            options.root.parent.worldToLocal(_rootWorld);
        }
        options.root.position.copy(_rootWorld);
    }
}
