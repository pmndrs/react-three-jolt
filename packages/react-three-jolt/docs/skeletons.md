# SkeletonSystem (issue #250)

`systems/skeleton-system.ts` maps a three.js `Skeleton`/`Bone` hierarchy onto a Jolt `Skeleton` and
converts poses between the two. It is pure data plumbing - nothing in it simulates anything - built
directly on the empirical findings of the ragdoll spike (see `docs/ragdolls.md` and
`test/ragdoll-spike.test.ts`, issue #249). Consumed by `<Ragdoll>` (#251) and drive modes (#252).

```ts
import { createJoltSkeleton, readPoseFromBones, writePoseToBones } from '@react-three/jolt';

// Once per character type (see docs/ragdolls.md: build the skeleton/settings once, cache it,
// spawn instances from it - never rebuild per spawn).
const { skeleton, joints, parentIndex } = createJoltSkeleton(threeSkeleton /* or a root Bone */);

// bones (local transforms) -> a Jolt pose, ready for SetPose/DriveToPoseUsing*
readPoseFromBones(joints, pose);

// a live Ragdoll's pose -> bone local transforms, every frame
ragdoll.GetPose(pose, true); // writes MATRICES - no CalculateJointMatrices() call, see the gotcha below
writePoseToBones(pose, joints, parentIndex);
```

## `createJoltSkeleton(threeSkeleton | rootBone)`

Builds a `Jolt.Skeleton`, preserving bone order and names, and returns
`{ skeleton, joints, parentIndex }`:

- From a `THREE.Skeleton`: joints are `skeleton.bones`, **in that exact order** - never re-sorted.
  `parentIndex[i]` is `bones[i].parent`'s index within `bones`, or `-1` when the parent isn't
  itself one of `bones` (the usual case for the root bone).
- From a root `THREE.Bone`: joints are collected with a pre-order depth-first walk of `Bone`
  children only, which always visits a parent before its children.

`parentIndex` exists because `Jolt.Skeleton` has **no getter** for a joint's parent index or name
once `AddJoint`/`CalculateParentJointIndices` have run (verified in the #249 spike) - anything that
needs to walk the hierarchy afterwards has to keep its own copy, so `SkeletonSystem` builds and
returns one alongside the Jolt object.

**Ownership**: the returned `skeleton` is a real WASM allocation the caller owns. The intended next
step is `RagdollSettings.mSkeleton = skeleton` (ownership transfers on assignment - do not also
destroy it yourself once assigned, see `docs/ragdolls.md`'s ownership table) or, if it's never
turned into a ragdoll, `Raw.module.destroy(skeleton)` directly.

## `readPoseFromBones(bones, pose)`

Writes each bone's **local** transform (`position`/`quaternion`, parent-relative) into `pose`'s
per-joint STATES, then calls `pose.CalculateJointMatrices()` so the pose is immediately usable with
`Ragdoll.SetPose`/`DriveToPoseUsingKinematics`/`DriveToPoseUsingMotors` - the same "populate states,
then derive matrices" sequence `SkeletalAnimation.Sample()` requires.

This is a direct 1:1 copy, no hierarchy walk: a new fact this issue pinned down (not covered by the
#249 spike, which only exercised an identity-rotation root) is that `SkeletonPose`'s per-joint
STATES are **parent-relative local transforms** - the exact same space a three.js `Bone`'s
`position`/`quaternion` already live in - not root-relative "model space" like the matrices. See
`skeleton-system.test.ts`'s first test for the disambiguating experiment (a rotated root, since an
identity root can't tell the two readings apart).

Bone `scale` is ignored - `SkeletalAnimationJointState` has no scale field.

## `writePoseToBones(pose, bones, parentIndex, options?)`

Converts `pose`'s per-joint MATRICES (root-relative "model space" - what `Ragdoll.GetPose()`
writes) into each bone's local transform. Unlike `readPoseFromBones`, this direction **does** need
the hierarchy walk `docs/ragdolls.md` calls for:

```
local(i) = inverse(model(parent(i))) * model(i)          (local(i) = model(i) when parent(i) == -1)
```

Implementation-wise, every joint's model-space matrix is read out of Jolt's one static temporary
per by-value-returning function (`GetJointMatrix`/`GetTranslation`/`GetQuaternion`) immediately and
copied into an owned `THREE.Matrix4`, in a first pass across all joints, before any hierarchy math
runs in a second, pure three.js pass - so the conversion never depends on a Jolt temporary a later
call might have already overwritten. `bone.scale` is left untouched: Jolt joint matrices carry no
scale, so writing a decomposed scale back would silently reset any authored non-uniform scale.

**Deliberate deviation from issue #250's shorthand signature** `writePoseToBones(pose, bones)`: the
hierarchy walk above is impossible without `parentIndex`, so it is a required third argument here -
pass the array `createJoltSkeleton` returned alongside `bones`.

`options.root`/`options.skinnedMesh` optionally place the whole hierarchy in world space using
`pose.GetRootOffset()` (the root joint's live world position). The `skinnedMesh.bindMatrixInverse`
correction is a best-effort convenience, **only unit-tested against an identity bind matrix** - not
verified against a real GLTF-exported rig with a non-trivial bind pose. Flagged for the maintainer
to confirm (or replace) before `<Ragdoll>` (#251) leans on it.

## The big gotcha (inherited from #249, applies here too)

`Ragdoll.GetPose(pose)` writes joint **matrices** directly and does not touch the per-joint
**states**. Calling `pose.CalculateJointMatrices()` afterwards recomputes the matrices from those
(untouched, still zero/stale) states and **overwrites what `GetPose()` just wrote**. `writePoseToBones`
therefore must run on a pose that came straight from `GetPose()` (no `CalculateJointMatrices()` in
between); `readPoseFromBones` calls `CalculateJointMatrices()` itself because it goes the other way
- states in, matrices needed for `SetPose`/`DriveToPoseUsing*` out. See `docs/ragdolls.md` for the
full writeup.
