# Ragdolls (spike #249, implementation #251, drive modes #252)

Status: the spike (issue #249) below is now implemented. `SkeletonSystem` (#250) maps a
three.js `Skeleton`/`Bone` hierarchy onto a Jolt `Skeleton` and converts poses - see
`docs/skeletons.md`. `RagdollSystem` + `<Ragdoll>` (#251, this section) build a `RagdollSettings`
template from a `SkinnedMesh` and drive a live ragdoll from it. Drive modes (#252 - `'animated'`
kinematic, `'powered'` motors, `'ragdoll'` free, with blending - see "Drive modes (issue #252)"
below) are now implemented too. The rest of this file is the original #249 spike write-up, kept
because every ownership/API fact in it is still what #251/#252 are built on.

## `RagdollSystem` / `<Ragdoll>` (issue #251)

`src/systems/ragdoll-system.ts` exports `RagdollSystem` (reachable as `physicsSystem.ragdollSystem`
on every world) and the types around it; `<Ragdoll>` (`src/components/Ragdoll.tsx`) is the React
wrapper.

```tsx
<Physics>
    <Ragdoll
        parts={{
            spine: { radius: 0.18 },
            armL: { constraint: 'hinge', hingeMin: -1.5, hingeMax: 0 }
        }}
        debug
        onCollisionEnter={(e) => console.log(e.target.object?.name, 'part landed')}
    >
        <primitive object={mySkinnedMesh} />
    </Ragdoll>
</Physics>
```

- **Template**: `RagdollSystem.buildTemplate(skeleton, options)` builds one capsule per joint
  (auto-sized: `radiusFraction * length`, `length` = distance to the joint's first child bone, or
  inherited from the parent for a leaf) and one constraint per non-root joint - default
  `swingTwist` (a cone + independent twist limit), or `hinge` / `fixed` / `none` per joint via
  `parts[boneName].constraint` (`none` gives the joint its own body but no `mToParent` at all - it
  is **not** true shape merging, see the type doc on `RagdollJointConstraint`). Capsule placement
  and constraint anchors are read from the bones' *current* world transform at build time
  (`Object3D.updateWorldMatrix` is called for you), so build the template after the character is
  posed where you want the ragdoll to start.
- **Spawning**: `RagdollSystem.spawn(template, options)` calls `CreateRagdoll` +
  `AddToPhysicsSystem`, registers one `BodyState` per part (on an unparented proxy `Object3D`, not
  the bone itself - the bone's transform is driven by the pose sync below, not by the normal
  body-to-object sync loop) so `onCollisionEnter`/etc. work through the ordinary `BodySystem`
  dispatch, and registers the instance as a `PhysicsSystem` disposable so a world torn down
  directly still removes the ragdoll before its bodies/constraints, matching the hard invariant
  below.
- **Pose sync**: every physics substep, `RagdollInstance.captureStep()` reads `ragdoll.GetPose()`
  (no `CalculateJointMatrices()` - see the gotcha below) and writes it onto the bones via
  `SkeletonSystem.writePoseToBones`, the same "no interpolation, but always current" write
  `<RigidBody>`'s own sync makes each substep. `<Ragdoll>`'s `useFrame` (registered after
  `<Physics>`'s own stepper, same ordering `<Debug>` relies on) then blends the last two captures
  by `physicsSystem.frameAlpha` when `interpolate` is on, respecting interpolation the same way
  `PhysicsSystem.syncBodyToObject` does for an ordinary body.
- **Teardown**: `RagdollInstance.destroy()` calls `RemoveFromPhysicsSystem()` then `destroy(ragdoll)`
  then `destroy(pose)`, in that order, and unregisters every part's `BodyState` without touching
  Jolt (the bodies are Ragdoll's to free). `RagdollTemplate.destroy()` frees `settings` (which
  cascades - see the ownership table below).
- **`<Ragdoll>` props**: `parts`, `defaultConstraint`, `layer` (Jolt object layer, default
  `Layer.MOVING` so it collides with the world out of the box - see the `Layer.RIG` note below),
  `activate`, `debug` (draws a wireframe capsule per part via `BodyState.debug`, the same overlay
  `<RigidBody debug>` uses), and the usual `onCollisionEnter`/etc. props, fanned out to every
  part. `parts`/`defaultConstraint`/`layer` are read once, at mount, never rebuilt on a prop
  change - see "RagdollSettings is a reusable template" below for why. The imperative `ref` is a
  `RagdollHandle`: `parts` (every part's `BodyState`), `getPart(boneName)`, `setVelocity` (every
  part, a coherent "throw"), `addImpulse(boneName, impulse)`.
- **`Layer.RIG`**: `PhysicsSystem`'s pair filter currently disables `Layer.RIG` against
  everything, including itself (see `constants.ts`/`physics-system.ts`) - a ragdoll built with
  `layer: Layer.RIG` will not collide with the floor or anything else. `<Ragdoll>` defaults to
  `Layer.MOVING` instead specifically so it works out of the box; pass `Layer.RIG` deliberately
  only if you want a non-colliding rig (and expect to flip that pair filter on yourself, or wait
  for a future issue that does). Flagged for the maintainer - this looks like a gap the RIG layer
  was reserved for but never wired up.

## Drive modes: animated / powered / ragdoll (issue #252)

`RagdollInstance`/`<Ragdoll>` now has a `mode: 'animated' | 'powered' | 'ragdoll'` (default
`'ragdoll'`), and per-part `swingTwist` motor tuning, on top of #251's spawn/pose-sync mechanics.

```tsx
<Ragdoll mode={hit ? 'ragdoll' : 'powered'} blendTime={0.3}>
    <primitive object={mySkinnedMesh} />
</Ragdoll>
```

- **`'animated'`**: every substep, `driveStep()` reads `bones`' CURRENT local transforms (their
  parent-relative `position`/`quaternion`, exactly what `SkeletonSystem.readPoseFromBones` reads -
  see `docs/skeletons.md`) into a private target `SkeletonPose` and calls
  `ragdoll.DriveToPoseUsingKinematics(pose, deltaTime)`. `captureStep()` (unconditionally run every
  substep, in every mode, per #251) then writes the physics result back onto the SAME `bones`
  array. **One array serves both roles** - read as the drive target before `Step()`, written as the
  render output after it - which is what lets a plain `THREE.AnimationMixer` targeting the
  `<Ragdoll>`'s own `SkinnedMesh` "just work": the mixer's `useFrame` update (which must run before
  `<Physics>`'s own step within the same rendered frame - not itself enforced by this package, the
  caller's `useFrame` priority/mount order has to make it so) sets the bones to this frame's
  animated pose, `driveStep()` reads that as the target, `Step()` runs, and `captureStep()`
  overwrites the bones with the (very closely tracking, since kinematic driving is velocity-exact
  per substep) physics result, ready for the mixer to overwrite again next frame.
- **`'powered'`**: same target read, but `ragdoll.DriveToPoseUsingMotors(pose)` - every
  `swingTwist` joint's `SwingTwistConstraint` motor (torque-limited, spring-driven towards the
  pose's target orientation) does the work instead of a direct velocity set, so an external force
  (a hit, another body) can still perturb the pose while it's being driven. Only `swingTwist`
  joints are motor-driven - `hinge`/`fixed`/`none` joints are unaffected by `'powered'` mode (Jolt
  exposes hinge/slider motors too, per `constraint-system.ts`'s existing `ConstraintMotorOptions`,
  but wiring ragdoll parts to those is out of scope here - the issue asked for SwingTwist motors).
- **`'ragdoll'`** (default): `driveStep()` no-ops; bodies are free, `captureStep()`'s usual
  physics-to-bones sync is the only thing touching `bones` - this is exactly what #251's own tests
  already exercised, unchanged.

### Per-part motor tuning (`'powered'` mode)

`RagdollPartOptions.motorStrength`/`motorDamping` (`swingTwist` joints only; defaults via
`RagdollTemplateOptions.defaultMotorStrength`/`defaultMotorDamping`, `6`/`1`) are baked into the
joint's `mSwingMotorSettings`/`mTwistMotorSettings` (a `MotorSettings` with a `SpringSettings`
spring, `mFrequency`/`mDamping` - see `constraint-system.ts`'s existing `createMotorSettings` for
the same pattern applied to hinge/slider constraints) at **template build time**, same as every
other per-part option here - motors can't be rebuilt cheaply per spawn any more than shapes or
constraint limits can (see "RagdollSettings is a reusable template" below). A joint built with
`motorStrength: 0` never has its motor turned on in `'powered'` mode (`setMode()` leaves it at
`EMotorState_Off` instead of `EMotorState_Position` - see below) - it stays limp even while the
rest of the ragdoll is powered, the mechanism the issue calls "a hit region go limp".

### `RagdollInstance.setMode(mode, blendSeconds?)`

- Entering/leaving `'powered'` flips every `swingTwist` joint's constraint motor state
  (`SetSwingMotorState`/`SetTwistMotorState`, `EMotorState_Position` only when that joint's
  `motorStrength > 0`, else `EMotorState_Off`). `'animated'`'s kinematic driving doesn't touch
  constraint motors at all, so switching into/out of it is a no-op here.
- **Switching TO `'ragdoll'` needs no special handling to "inherit velocity"**: kinematic driving
  and motor torque both already leave the bodies with real physics velocity every substep (that's
  how they work - see below); simply not driving them further (`driveStep()` no-ops in `'ragdoll'`
  mode) is enough. Verified in `test/ragdoll-modes.test.ts`: a kinematically-driven body's velocity
  right after `setMode('ragdoll')` is still close to what it was while driven, not reset to zero.
- **Switching AWAY from `'ragdoll'`** snapshots `bones`' current local transforms and blends
  `captureStep()`'s writes from that snapshot towards the newly-driven pose over `blendSeconds`
  (default the `blendTime` passed to `spawn()`/the `<Ragdoll blendTime>` prop, itself default
  `0.2`) instead of popping straight to the driven pose - a per-bone position lerp + quaternion
  slerp, advanced by the real substep `delta` each `captureStep()` call. Pass `0` for an immediate
  cut. Never blended going INTO `'ragdoll'` - going limp is meant to be an immediate, physically
  real transition, not a smoothed one.
- `<Ragdoll mode>` is reactive (unlike `parts`/`layer`/`defaultMotorStrength`/`defaultMotorDamping`,
  which stay build-time-only, same as #251) - changing the prop after mount calls `setMode()`.

### Two facts pinned down while building this, not in #249/#250/#251's docs

**`Ragdoll.SetPose()`/`DriveToPoseUsingKinematics()`/`DriveToPoseUsingMotors()` read the ROOT's
target WORLD position from `pose.GetJoint(0)`'s STATE** (what `readPoseFromBones` writes from
`bones[0].position` - joint 0 has no parent, so its "local" state IS its world target directly),
**not from `pose.GetRootOffset()`.** This is the opposite convention from `GetPose()`'s OUTPUT (see
"Joint matrices are root-relative model space" below, where `GetRootOffset()` holds the live world
position and joint 0's own matrix is always ~identity) - the input and output conventions are NOT
symmetric, and nothing in #249/#250 exercised the input side. Verified with a throwaway probe:
moving `bones[0].position` by `+5` on X and calling `SetPose()` (`GetRootOffset()` left at its
default `(0,0,0)`) moved the root body by exactly `+5` on X. `driveStep()` needs no
`SetRootOffset()` call because of this - `readPoseFromBones` already puts the root's target where
these calls expect it. One consequence worth flagging for `<Ragdoll>`'s own root bone handling
later: because `captureStep()`'s `writePoseToBones` call always writes the root's OWN local
translation back as `(0,0,0)` (the flip side of the same "root's own model matrix is always
identity" fact), a caller driving `'animated'`/`'powered'` mode must set the root bone's FULL
target transform every substep (not just mutate one axis) - leaving a component untouched means it
silently reads back as whatever `captureStep()` last zeroed it to, not "hold your last real value".

**Kinematically/motor-driving a multi-body CONSTRAINED chain does not move every part in lockstep,
even for `'animated'` mode's supposedly velocity-exact kinematic drive.** The root (no parent
constraint pulling on it) converges tightly and immediately to a moving OR still target. A
downstream joint (spine, armL/armR) settles to a bounded, non-zero STEADY-STATE offset from its
own forward-kinematically-computed target - verified in `test/ragdoll-modes.test.ts` by holding a
moving target still and waiting up to 120 extra substeps (2 seconds): the gap does not shrink
further, it is a genuine equilibrium, not slow decay. Best working theory (not confirmed against
Jolt's source): `DriveToPoseUsingKinematics` sets each body's velocity independently from the
forward-kinematic pose every substep, and the `swingTwist` constraint's own positional correction
(pulling a child back towards where its PARENT physically is *this substep*, not where the
parent's kinematic TARGET is) partially fights that imposed velocity on a compliant joint. Deeper
joints (two constraints from the root) carry a larger gap than shallower ones. Flagged for the
maintainer/for anyone building a precision-tracking use case on `'animated'` mode - `<Ragdoll>`'s
current shipped behavior is good enough for "drag a controlled character's ragdoll along with its
animation, close enough to still collide sensibly", not for exact multi-body IK-style tracking.

### New findings from building #251 (not in the original #249 spike)

**`SkeletonPose.SetSkeleton()` transfers ownership.** `Raw.module.destroy(pose)` frees the
`Skeleton` it was set with - it does not just drop a borrowed reference, the way `Ragdoll`'s own
bodies borrow the template's shapes without owning them. Binding every spawned instance's pose to
the shared `template.skeleton` (the obvious choice, since `Ragdoll`'s bodies were already built
from it) frees that shared skeleton the first time *any* instance's pose is destroyed, corrupting
`RagdollSettings.mSkeleton` for the template and every other instance. `RagdollSystem.spawn()`
therefore builds each instance a bare **private** `Jolt.Skeleton` (joint count/hierarchy only, no
names/shapes/constraints - nothing else ever reads a pose's skeleton back) for its `SkeletonPose`,
and lets destroying the pose free that private copy.

**Spawning a second ragdoll on the same `PhysicsSystem`, after a previous one has been destroyed,
used to silently fail - fixed for issue #275, see below.** `CreateRagdoll -> AddToPhysicsSystem ->
step -> RemoveFromPhysicsSystem -> destroy(ragdoll)` looped on one settings object used to produce
a working first ragdoll (`GetBodyCount()` 4) and an **empty** one on every call after - `GetBodyCount()`
0, `GetBodyID(0).GetIndexAndSequenceNumber()` 0 (Jolt's invalid-body sentinel) - even though the
heap-byte accounting looked perfectly clean, which is exactly why the original spike's stress test
(byte-count only) missed it.

**Root cause (#275): `RagdollSettings` is itself a Jolt `RefTarget`, and `Ragdoll` holds an
internal back-reference to it that gets released when the `Ragdoll` is destroyed.** The issue's own
lead hypothesis - that `RagdollPart.SetShape()`/`mToParent`'s setters skip `AddRef()` on the
*shape*/*constraint-settings* objects - is **refuted**: artificially padding a shape's
`GetRefCount()` to 1000+ before a spawn/destroy cycle does not fix the empty second ragdoll, so
those objects are not what gets freed prematurely. What's actually being freed is `settings`
itself: a JS-constructed `RagdollSettings` starts at refcount 0 (same convention as a freshly
`new`-ed `Shape`), `CreateRagdoll()` gives the returned `Ragdoll` the settings' only reference, and
the JS/WASM binder exposes **no** `AddRef`/`Release`/`GetRefCount` on `RagdollSettings` at all
(confirmed both by grepping `node_modules/jolt-physics/dist/types.d.ts` and at runtime -
`settings.AddRef` is `undefined`), so nothing in JS could ever compensate directly. Destroying the
first spawned `Ragdoll` therefore drops `settings`' refcount to zero, and Jolt's own
`RefTarget::Release()` frees it immediately - confirmed directly: `settings.mParts.size()` reads
`0` (was `1`) and `settings.GetSkeleton().GetJointCount()` reads a garbage value right after that
first `destroy(ragdoll)` call, even in the single-spawn-then-teardown sequence every test in this
package used before this fix. The *previous* `RagdollTemplate.destroy()` then called
`Raw.module.destroy(settings)` unconditionally, which was **always** a double free once any
instance had been spawned - it just happened not to trap for a single spawn/destroy/teardown
sequence (see "what the fix looks like" below for when it does trap). Two ragdolls kept alive
*simultaneously* (no destroy in between) were always fine, since neither one's reference ever hit
zero - it is specifically spawn -> destroy -> spawn again that broke.

**The fix: `RagdollSystem.buildTemplate()` now creates one extra, permanent "keeper" `Ragdoll`**
right after building `settings` (`AddToPhysicsSystem` + `RemoveFromPhysicsSystem` immediately,
never activated, never stepped, never handed to a caller) purely to hold a reference on `settings`
for the template's whole lifetime, no matter how many real instances get spawned and destroyed.
`RagdollTemplate.destroy()` now destroys **only** the keeper - `Raw.module.destroy(settings)` is
never called directly any more, because the keeper's own teardown is what makes Jolt's native
refcounting free `settings` (still cascading to `mSkeleton`, every part's shape and every part's
`mToParent`, exactly as before). Calling `jolt.destroy(settings)` in addition to destroying the
keeper **does** trap with "memory access out of bounds" once a template has real constraints
(`mToParent`) and has been through more than a couple of spawn/destroy cycles - confirmed while
building this fix, which is how the double free was pinned down precisely. Verified with a real
5-cycle spawn/AddToPhysicsSystem/step/RemoveFromPhysicsSystem/destroy stress test (4-joint,
swingTwist-constrained template): every cycle produces the correct body count, and
`sGetFreeMemory()` is back at the pre-cycle baseline once the keeper (not `settings`) is destroyed
- see `test/ragdoll-system.test.ts`'s "spawn -> destroy -> spawn again... 5 times" test. A
`RefTarget` subclass with no `AddRef`/`Release`/`GetRefCount` exposed to JS, and a `Ragdoll` that
silently frees its own `RagdollSettings`, are both still worth an upstream jolt-physics report -
but this package no longer needs one to support recycling ragdolls.

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
| `RagdollSettings.CreateRagdoll(...)` | method call | the returned `Ragdoll` takes an internal reference **on `RagdollSettings` itself** - `RagdollSettings` is a Jolt `RefTarget`, released when that `Ragdoll` is destroyed (issue #275) | **no exposed API to manage this directly** - `RagdollSettings` has no `AddRef`/`Release`/`GetRefCount` in the JS binder at all (confirmed at runtime). See "`RagdollSettings` is a reusable template" below for how `RagdollSystem` compensates (a permanent internal "keeper" `Ragdoll`) |
| `Raw.module.destroy(ragdollSettings)` | - | frees `mSkeleton`, every part's shape, every part's `mToParent`, in one call, **but only if no `Ragdoll` was ever created from it** | Safe (verified: `sGetFreeMemory()` back within 64 bytes of baseline) only when `CreateRagdoll()` was never called on this settings object. Once any `Ragdoll` has been spawned from it, its refcount is no longer 0 at the "no Ragdoll ever created" baseline - destroying the last such `Ragdoll` already frees `RagdollSettings` via Jolt's own refcounting (see the row above), and calling `Raw.module.destroy(settings)` afterward is a **double free** (traps with "memory access out of bounds" once the template has real constraints and has been through a few spawn/destroy cycles - see issue #275) |
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
spawn independent `Ragdoll` instances (pass a different `collisionGroup` per spawn) - **including
after a previously spawned instance has been destroyed**, fixed for issue #275. This is the pattern
`RagdollSystem` uses: build the skeleton/settings once per character *type* (`buildTemplate()`),
cache it, and call `CreateRagdoll` (via `spawn()`) per *instance*, any number of times, in any
order relative to destroying previous instances.

Making respawn safe requires `buildTemplate()` to also create one internal "keeper" `Ragdoll` (see
the ownership table's `CreateRagdoll` row above) that is never exposed to callers and lives for the
template's whole lifetime, specifically to hold `RagdollSettings`' own reference count above zero
regardless of how many real instances get spawned and destroyed. Without a keeper, destroying the
*first* spawned `Ragdoll` alone is enough to free `RagdollSettings` out from under the template -
this was previously stress-tested as "six spawn/destroy cycles, byte-for-byte identical heap after
every spawn" and looked completely safe, because that test only checked heap *byte counts*, never
the spawned ragdoll's actual body count. It wasn't: every `CreateRagdoll()` call after the first
returned an empty `Ragdoll` (`GetBodyCount()` 0) while still leaving the heap byte-accounting
clean, which is exactly why byte-count-only verification missed a real bug for as long as it did.
See `RagdollSystem.buildTemplate()`'s module doc in `src/systems/ragdoll-system.ts` for the fix
itself.

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

### `<Ragdoll>` (#251) - implemented, see the section near the top of this file

Built as described here: a thin React wrapper that builds a template from the `SkinnedMesh` found
among its children, spawns one instance on mount, and calls `RemoveFromPhysicsSystem` + `destroy`
on unmount in that order, per the hard invariant above. Per-substep pose sync goes through
`GetPose()` (no `CalculateJointMatrices()` call) and `SkeletonSystem.writePoseToBones`, exactly as
recommended. Individual body access is exposed via the imperative `RagdollHandle` (`parts`,
`getPart(boneName)`) rather than a raw `GetBodyID(i)` passthrough, since every part already has a
full `BodyState`.

### Drive modes (#252) - implemented, see "Drive modes: animated / powered / ragdoll" near the top

The original recommendation below (kept for history) was to sample a package-owned
`SkeletalAnimation` into the pose every frame. What actually shipped reads the target pose
directly from `bones`' CURRENT local transforms instead (`SkeletonSystem.readPoseFromBones`, no
`SkeletalAnimation`/`Sample()` involved) - simpler, and it means ANY external driver of the
`<Ragdoll>`'s own `SkinnedMesh` bones (a `THREE.AnimationMixer`, a procedural rig, another
package) works as the drive target for free, not just a Jolt-native `SkeletalAnimation` clip. The
three modes still map onto the same three Jolt calls this spike verified:

1. **`'ragdoll'` (passive, default)** - just `AddToPhysicsSystem` + step; no pose driving at all.
   What `test/ragdoll-spike.test.ts`'s main test exercises, and #251's tests too.
2. **`'animated'` (kinematic)** - `ragdoll.DriveToPoseUsingKinematics(pose, deltaTime)`, matching
   `kinematic_rig.html`.
3. **`'powered'` (motor-driven)** - `ragdoll.DriveToPoseUsingMotors(pose)`, matching
   `powered_rig.html`. The `(prevPose, pose, deltaTime)` velocity-aware overload and `SetPose()`'s
   teleport escape hatch are both still unused by this package - flagged as possible follow-ups,
   not needed for what #252 asked for.
