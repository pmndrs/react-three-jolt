# Ragdolls (spike, issue #249)

Status: **research spike**, not an implementation. This documents what was verified against the
real jolt-physics 1.1 WASM binder while writing `test/ragdoll-spike.test.ts`, and recommends a
design for the "Rigged Bodies" milestone that builds on it: `SkeletonSystem` (#250), `<Ragdoll>`
(#251), drive modes (#252).

Nothing here was taken from documentation - there isn't any. `jolt-physics/dist/types.d.ts` has
signatures but zero ownership notes, and the only working example code is
[jrouwe/JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js)'s `Examples/rig/*.html` demos
(`create_rig.html`, `load_rig.html`, `kinematic_rig.html`, `powered_rig.html`, and
`Examples/js/ragdoll_loader.js`), fetched from GitHub while writing this spike. Those demos are
useful for the *shape* of the API - which fields exist, what a working `SwingTwistConstraintSettings`
looks like - but they never destroy anything they build, so none of the ownership claims below came
from them. Every ownership claim was verified empirically: build the object, destroy what the
hypothesis says you own, and check `JoltInterface.prototype.sGetFreeMemory()` actually returned
that memory (the same method `test/jolt-alloc.ts` uses everywhere else in this package). See
`test/ragdoll-spike.test.ts` for the runnable proof.

## The pipeline

```
Skeleton              - joint hierarchy (names + parent indices), no transforms
RagdollSettings       - a REUSABLE TEMPLATE: skeleton + one RagdollPart (shape/mass/motion type)
                        per joint + one constraint per non-root joint
RagdollSettings.CreateRagdoll(group, userData, physicsSystem) -> Ragdoll
                        - creates the actual bodies+constraints and adds them to `physicsSystem`'s
                          bookkeeping (NOT yet simulated - see AddToPhysicsSystem)
Ragdoll                - a live instance: N bodies + N-1 constraints, plus pose/drive methods
SkeletonPose            - a snapshot of joint transforms, read from a live Ragdoll or written by
                          SkeletalAnimation.Sample(), fed back into SetPose/DriveToPoseUsing*
SkeletalAnimation       - JS-authored (or loaded) keyframes per joint, sampled into a SkeletonPose
```

## Verified signatures

Grepped from `node_modules/jolt-physics/dist/types.d.ts`. Every field the binder exposes as a
struct member shows up as *both* `get_mX()`/`set_mX()` **and** a plain `mX` property - this
package's own code (`constraint-system.ts`) always uses the plain property, and this spike does
too; the `get_`/`set_` forms are redundant WebIDL boilerplate, not a different access path.

```ts
class Skeleton {
    constructor();
    AddJoint(inName: JPHString, inParentIndex: number): number; // returns the joint's index
    GetJointCount(): number;
    AreJointsCorrectlyOrdered(): boolean; // parents must precede children
    CalculateParentJointIndices(): void;  // call once, after all AddJoint calls
    // NOTE: no getter for a joint's parent index or name once added. If SkeletonSystem needs to
    // walk the hierarchy (it will, for local-transform bone sync - see below), it must keep its
    // own parallel `parentIndex[]` array in JS; Skeleton will not give it back.
}

class SkeletalAnimationJointState { // = a SkeletonPose joint's live state, and a keyframe's shape
    FromMatrix(inMatrix: Mat44): void;
    ToMatrix(): Mat44;
    mTranslation: Vec3; // live reference - mutate with .Set()/.x=, no reassignment needed
    mRotation: Quat;
}
class SkeletalAnimationKeyframe extends SkeletalAnimationJointState {
    constructor();
    mTime: number;
}
class ArraySkeletonKeyframe { // std::vector-like: resize/at/push_back, `.at(i)` is a live ref
    resize(inSize: number): void;
    at(inIndex: number): SkeletalAnimationKeyframe;
    // ...size/empty/push_back/reserve/clear
}
class SkeletalAnimationAnimatedJoint {
    mJointName: JPHString; // COPIED on assign, see "JPHString" below
    mKeyframes: ArraySkeletonKeyframe;
}
class SkeletalAnimation {
    constructor();
    SetIsLooping(inLooping: boolean): void;
    IsLooping(): boolean; // defaults to TRUE - see gotchas
    GetDuration(): number;
    ScaleJoints(inScale: number): void;
    Sample(inTime: number, ioPose: SkeletonPose): void; // writes ioPose's per-joint STATES
    GetAnimatedJoints(): ArraySkeletonAnimatedJoint; // live ref, `.resize(n)` then `.at(i)`
}

class SkeletonPose {
    constructor();
    SetSkeleton(inSkeleton: Skeleton): void; // sizes the pose to the skeleton's joint count
    GetSkeleton(): Skeleton;
    SetRootOffset(inOffset: RVec3): void;
    GetRootOffset(): RVec3;
    GetJointCount(): number;
    GetJoint(inJoint: number): SkeletalAnimationJointState; // per-joint STATE (local)
    GetJointMatrices(): ArrayMat44;
    GetJointMatrix(inJoint: number): Mat44; // by-value return - static temp, read immediately
    CalculateJointMatrices(): void; // STATES -> MATRICES (see gotcha below)
    CalculateJointStates(): void;   // MATRICES -> STATES (the reverse)
}

class RagdollPart extends BodyCreationSettings { // everything BodyCreationSettings has, plus:
    mToParent: TwoBodyConstraintSettings; // Ref<ConstraintSettings> - ownership transfers on assign
}
class ArrayRagdollPart {
    resize(inSize: number): void;
    at(inIndex: number): RagdollPart; // live ref into the vector - mutate in place
}
class RagdollSettings {
    constructor();
    Stabilize(): boolean; // improves inertia for long thin limb chains, optional but cheap
    CreateRagdoll(inCollisionGroup: number, inUserData: number, inSystem: PhysicsSystem): Ragdoll;
    GetSkeleton(): Skeleton;
    DisableParentChildCollisions(inJointMatrices?: Mat44MemRef, inMinSeparationDistance?: number): void;
    CalculateConstraintPriorities(inBasePriority?: number): void;
    CalculateBodyIndexToConstraintIndex(): void;
    CalculateConstraintIndexToBodyIdxPair(): void;
    mSkeleton: Skeleton;                       // Ref<Skeleton> - ownership transfers on assign
    mParts: ArrayRagdollPart;
    mAdditionalConstraints: ArrayRagdollAdditionalConstraint; // non-parent-child constraints
}

class Ragdoll {
    // constructor(inSystem: PhysicsSystem) exists but is NOT the creation path - always go
    // through RagdollSettings.CreateRagdoll(), which is what actually builds the bodies.
    AddToPhysicsSystem(inActivationMode: EActivation, inLockBodies?: boolean): void;
    RemoveFromPhysicsSystem(inLockBodies?: boolean): void; // MANDATORY before destroy() - see below
    Activate(inLockBodies?: boolean): void;
    IsActive(inLockBodies?: boolean): boolean;
    SetGroupID(inGroupID: number, inLockBodies?: boolean): void;
    SetPose(inPose: SkeletonPose, inLockBodies?: boolean): void;
    GetPose(outPose: SkeletonPose, inLockBodies?: boolean): void; // writes MATRICES, not states
    ResetWarmStart(): void;
    DriveToPoseUsingKinematics(inPose: SkeletonPose, inDeltaTime: number, inLockBodies?: boolean): void;
    DriveToPoseUsingMotors(inPose: SkeletonPose): void;
    DriveToPoseUsingMotors(inPrevPose: SkeletonPose, inPose: SkeletonPose, inDeltaTime: number): void;
    GetRootTransform(outPosition: RVec3, outRotation: Quat, inLockBodies?: boolean): void;
    GetBodyCount(): number;
    GetBodyID(inBodyIndex: number): BodyID; // body index === joint index, 1:1 with mParts
    GetConstraint(inConstraintIndex: number): TwoBodyConstraint;
    GetRagdollSettings(): RagdollSettings;
}
```

`CapsuleShape` can be built directly - `new Jolt.CapsuleShape(halfHeight, radius)` - skipping
`CapsuleShapeSettings.Create()` entirely, then handed straight to `RagdollPart.SetShape(shape)`
(inherited from `BodyCreationSettings`). This is what `create_rig.html` does and it is simpler
than this package's usual `createShapeFromSettings()` path (`shape-system.ts`) for the common case
of a plain capsule/box/sphere ragdoll limb.

## Ownership rules (verified)

| What | How it's assigned | Owns it after assignment | Must the caller destroy it separately? |
|---|---|---|---|
| `Skeleton.AddJoint(name, parent)` | function argument | copies the string content | **yes** - destroy the `JPHString` right after the call |
| `SkeletalAnimationAnimatedJoint.mJointName = name` | property assignment | copies the string content | **yes**, same as above |
| `RagdollPart.mPosition / mRotation` (and every other `Vec3`/`RVec3`/`Quat` field: `mPosition1/2`, `mTwistAxis1/2`, `mPlaneAxis1/2`, ...) | property assignment | copies the value | **yes** - these are plain value types, exactly like every other Jolt settings field this package already builds (`constraint-system.ts`'s `Temporaries`/`ownedVec3` pattern applies unchanged) |
| `RagdollPart.SetShape(shape)` | method call | takes a `RefConst<Shape>` reference | **no** - freed when the owning `RagdollSettings` is destroyed |
| `RagdollPart.mToParent = constraintSettings` | property assignment | takes a `Ref<ConstraintSettings>` reference | **no** - same as above |
| `RagdollSettings.mSkeleton = skeleton` | property assignment | takes a reference (Skeleton has no exposed `AddRef`/`Release`, but the assignment still transfers ownership at the C++ level) | **no** - freed when `RagdollSettings` is destroyed. **Destroying it separately after `destroy(settings)` was not tested and should be assumed unsafe** (see "what was not tested") |
| `Raw.module.destroy(ragdollSettings)` | - | frees `mSkeleton`, every part's shape, every part's `mToParent`, in one call | verified: after `destroy(settings)`, `sGetFreeMemory()` was back within 64 bytes of the pre-build baseline, and the allocator's live-object tracker showed exactly the skeleton/shapes/constraint-settings as the only "never separately destroyed" objects - i.e. they really were freed by `RagdollSettings`'s own destructor, not leaked |
| `Ragdoll` bodies + constraints | created by `CreateRagdoll()` | owned by the live simulation | `ragdoll.RemoveFromPhysicsSystem()` **then** `Raw.module.destroy(ragdoll)` - **both, in that order, every time** |

### `RemoveFromPhysicsSystem()` is not optional

Calling `Raw.module.destroy(ragdoll)` **without** calling `ragdoll.RemoveFromPhysicsSystem()`
first corrupts the physics world: the very next `physicsSystem.Step()` (i.e. the next
`PhysicsSystem.onUpdate()` in this package) throws `RuntimeError: memory access out of bounds`.
This is the one finding in this file backed by an actual WASM trap, not just a byte-counting
assertion - confirmed with a standalone reproduction, not included in the committed test (no
reason to crash the suite on purpose). `SkeletonSystem`/`<Ragdoll>` must treat "remove before
destroy" as a hard invariant, the same way `docs/Memory.md` already treats
`bodyInterface.RemoveBody` before `bodyInterface.DestroyBody` for a single body.

### `RagdollSettings` is a reusable template - and rebuilding it repeatedly is unsafe

`RagdollSettings.CreateRagdoll()` can be called many times on the **same** settings object to
spawn independent `Ragdoll` instances (pass a different `collisionGroup` per spawn). This was
stress-tested: build one `RagdollSettings` once, then `CreateRagdoll` → `AddToPhysicsSystem` →
step → `RemoveFromPhysicsSystem` → `destroy(ragdoll)` **six times in a row** on the same
`PhysicsSystem`, and the WASM heap was byte-for-byte identical after every single spawn. This is
the pattern `SkeletonSystem` should use: build the skeleton/settings once per character *type*,
cache it, and call `CreateRagdoll` per *instance*.

The pattern that is **not** safe: rebuilding a fresh `Skeleton` + `RagdollSettings` from scratch
on every spawn (instead of reusing one template) corrupted the WASM heap after two full
build/use/destroy cycles on the same `PhysicsSystem` - the third cycle's completely unrelated
`Skeleton.AddJoint`/`JPHString` cleanup trapped with the same "memory access out of bounds" error,
even though cycles 1 and 2 individually passed every heap-restored check. The root cause was not
identified (out of scope for a spike) and does not block the recommended design below, since
nothing in it rebuilds settings per spawn - but it should be treated as an open risk if a future
change ever needs to hot-reload or mutate a `RagdollSettings` template at runtime, and is worth a
follow-up investigation before that happens.

### `JPHString`

`new Jolt.JPHString(str, str.length)` is a real WASM allocation, destroyed like anything else.
Every place that takes one (`Skeleton.AddJoint`, `mJointName =`) copies its *content* rather than
retaining the wrapper - confirmed by constructing, using, and destroying one immediately, then
separately confirming a `JPHString` **never** destroyed after use is a genuine, isolated 24-byte
leak (not a crash) via the same heap-byte check. Treat it exactly like `ownedVec3`/`ownedRVec3` in
`constraint-system.ts`: build it, hand it over, destroy it, never hold onto it.

### Mass

`RagdollPart` (via `BodyCreationSettings`) takes mass the normal way:
`part.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
part.mMassPropertiesOverride.mMass = value;` (the latter is a live reference into the part - no
separate `Vec3`-style temporary to manage). Leaving `mOverrideMassProperties` at its default lets
Jolt compute mass from the shape's volume and density, same as any other body.

## The big gotcha: `GetPose()` vs `CalculateJointMatrices()`

This is the fact the issue asked to pin down, and it is sharper than "model space, not world
space": **`SkeletonPose` has two internal representations that are populated by two different,
mutually exclusive code paths, and calling the wrong follow-up method silently zeroes the one you
just populated.**

- `Ragdoll.GetPose(pose)` writes directly into the pose's **joint matrices** (root-relative
  "model" space - see below). It does **not** touch the per-joint **states**
  (`pose.GetJoint(i)`/`mTranslation`/`mRotation`), which are left at whatever they were before
  (zero, for a freshly constructed pose).
- `SkeletalAnimation.Sample(time, pose)` writes the per-joint **states**. It does **not** touch
  the joint matrices.
- `pose.CalculateJointMatrices()` derives the matrices **from the states**. Calling it after
  `GetPose()` overwrites the correct matrices `GetPose()` just wrote with zeros, because the
  states `GetPose()` left untouched are still empty. Calling it after `Sample()` is required and
  correct - that is the only way the states `Sample()` wrote become matrices.
- `pose.CalculateJointStates()` is the reverse (matrices → states); not needed for either path
  above.

**Rule: `GetPose()` needs no follow-up call - read `GetJointMatrix(i)` immediately. `Sample()`
always needs `CalculateJointMatrices()` before the pose is used for `SetPose`/
`DriveToPoseUsingMotors`/`DriveToPoseUsingKinematics`.** This was found by diffing
`GetJointMatrix(i)` before and after an (incorrect) `CalculateJointMatrices()` call immediately
after `GetPose()`: before, the translations were correct (see below); after, all four were
`(0,0,0)`.

### Joint matrices are root-relative "model space"

With `GetPose()`'s matrices read correctly (no `CalculateJointMatrices()` call), for a 4-joint
chain at rest with the root capsule at world y=10 and its children below it:

```
rootOffset (GetRootOffset()):        (0, 5.098, 0)   -- the ROOT BODY's live world position
joint 0 (root)  matrix translation:  (0, 0, 0)
joint 1 (spine) matrix translation:  (0, -1.2, 0)     -- exactly spine.y(3.898) - root.y(5.098)
joint 2 (armL)  matrix translation:  (-0.6, -2.2, 0)  -- exactly armL.y - root.y, armL.x - root.x
```

I.e. `worldPosition(joint i) = GetJointMatrix(i).GetTranslation() + rootOffset` for the translation
component (verified to within 0.02 units on every joint of the test rig). This only covers
translation because the test rig's bodies never rotated (an intentional simplification); with a
rotated root, the real relationship is a full transform compose -
`worldTransform(i) = rootTransform * jointMatrix(i)`, not a translation-only add - `rootOffset` is
a translation (`RVec3`), and the root's own rotation is baked into joint 0's own matrix instead of
being tracked separately.

**This is the fact #251 needs for three.js bone sync**: `GetJointMatrix(i)` is root-relative
("model space"), not world space, and - separately - **not** a three.js `Bone`'s parent-relative
*local* transform either. A three.js skeleton's bones each hold a transform relative to their
*parent bone*, not relative to the character root. Converting model-space joint matrices to the
local transforms bones need requires walking the hierarchy and computing
`local(i) = inverse(modelSpace(parent(i))) * modelSpace(i)` for every joint - and `Skeleton` does
not expose a parent-index getter (see above), so `SkeletonSystem` must keep its own
`parentIndex: number[]` (the same array it passes to `AddJoint`) to do this walk. This conversion
belongs in `SkeletonSystem`/`<Ragdoll>`'s per-frame bone sync, not in application code.

## `SkeletalAnimation.Sample()` looping

`IsLooping()` defaults to **true**. `Sample(time, pose)` wraps `time` modulo `GetDuration()` when
looping - sampling exactly at (or past) the duration does **not** hold the last keyframe, it wraps
back towards `t=0` (confirmed with a sweep from `t=0` to `t=1.5` on a 1-second clip: `t=1.0`
reported the `t=0` value, `t=1.1` reported the `t=0.1` value). Call `animation.SetIsLooping(false)`
to get clamp-at-the-end behaviour instead, which is almost always what driving a ragdoll to a
single animation frame (e.g. a death pose) wants. `#252`'s drive-mode design should default new
`SkeletalAnimation`s to non-looping unless the caller asks for a looping clip.

## What was not tested (uncertain / flag for the maintainer)

- **Destroying `Skeleton` separately after its owning `RagdollSettings` was already destroyed.**
  The ownership table above is inferred from `RagdollSettings`'s destroy() returning the skeleton's
  memory along with everything else (a full heap-byte restoration), not from attempting a second,
  separate `destroy(skeleton)` afterwards and confirming it throws - that experiment was skipped
  deliberately, because a double free that does *not* throw (silent corruption, per
  `docs/Memory.md`'s existing warnings) could have corrupted the WASM instance for every later test
  in the file with no clear signal. If `SkeletonSystem` ever needs to hold onto a `Skeleton`
  independently of the `RagdollSettings` built from it (plausible, since `GetSkeleton()` hands back
  what looks like the same object), this needs a real answer before it ships.
- **Root rotation's effect on the model-space formula above** - the test rig never rotated any
  body, so only the translation half of "model space" was verified precisely.
- **`mAdditionalConstraints`** (non-parent-child constraints, e.g. a stabilizing "shoulder brace")
  - not exercised at all.
- **`RagdollSettings::sRestoreFromBinaryState`/`SaveBinaryState`** (serialization) - not exercised;
  relevant if character rigs get shipped as data instead of built in JS.
- Why rebuilding `RagdollSettings` repeatedly (as opposed to reusing one and calling
  `CreateRagdoll` repeatedly) corrupts memory after two cycles - root cause unknown, see above.

## Recommended design

### `SkeletonSystem` (#250)

- Owns exactly the "template" half of the pipeline: one `Skeleton` + one `RagdollSettings` per
  character *type*, built once (e.g. on mount / asset load) and cached for the component's
  lifetime. Exposes the `parentIndex: number[]` array it built alongside the `Skeleton` (Jolt will
  not give it back), since bone sync needs it.
- `CreateRagdoll()` is called per *instance* that wants a physical body, not per frame and not per
  template rebuild - see the "reusable template" finding above.
- Owns collision-group id allocation for spawned ragdolls (an incrementing counter is enough;
  `DisableParentChildCollisions()` on the shared template already handles parent/child filtering).
- Provides the model-space → three.js-bone-local conversion described above as a per-frame method,
  fed by `Ragdoll.GetPose()`.

### `<Ragdoll>` (#251)

- A thin React wrapper, in the same spirit as `<RigidBody>`: takes a `SkeletonSystem`-built
  template (or builds a small default one from props, mirroring how `<RigidBody>` can build its
  own shape), calls `CreateRagdoll`/`AddToPhysicsSystem` on mount, `RemoveFromPhysicsSystem` +
  `destroy` on unmount - in that order, always, per the hard invariant above.
- Per-frame, reads the live pose via `GetPose()` (no `CalculateJointMatrices()` call - see the
  gotcha above) and writes the converted local transforms onto a three.js `Skeleton`'s `Bone[]`,
  the same shape a `SkinnedMesh` expects.
- Exposes `GetBodyID(i)`/individual body access for cases that need one limb (e.g. attaching a
  weapon to a hand bone) - `Ragdoll.GetBodyID(i)` is 1:1 with the skeleton's joint index.

### Drive modes (#252)

Three modes map directly onto what this spike verified works:

1. **Ragdoll (passive)** - just `AddToPhysicsSystem` + step; no pose driving at all. What
   `test/ragdoll-spike.test.ts`'s main test exercises.
2. **Animated / kinematic** - `SkeletalAnimation.Sample(time, pose)` →
   `pose.CalculateJointMatrices()` → `ragdoll.DriveToPoseUsingKinematics(pose, deltaTime)`. Use
   `SetIsLooping(false)` unless the clip should loop (see above). Good for a controlled character
   that should still push other dynamic bodies around, matching `kinematic_rig.html`.
3. **Motor-driven ("powered ragdoll")** - same sampling path, but
   `ragdoll.DriveToPoseUsingMotors(pose)` (or the `(prevPose, pose, deltaTime)` overload for
   velocity-aware driving). Lets external forces (an explosion, another character) still perturb
   the pose while it's actively driven, matching `powered_rig.html`. `SetPose(pose)` is the
   teleport-instead-of-drive escape hatch for either mode (e.g. snapping to an animation's first
   frame before handing off to motors, as `powered_rig.html` does).

All three modes read/write the *same* `SkeletonPose`/`SkeletalAnimation` objects, so `#252` can be
a single "drive mode" enum on `<Ragdoll>` that swaps which of `DriveToPoseUsingKinematics` /
`DriveToPoseUsingMotors` / nothing gets called per frame, rather than three separate component
trees.
