// RagdollSystem (issue #251): builds a reusable `Jolt.RagdollSettings` template from a three.js
// `SkinnedMesh`/`Skeleton` (auto capsule per bone, one constraint per non-root joint) and spawns
// live `Jolt.Ragdoll` instances from it. Consumed by `<Ragdoll>`.
//
// Every design choice here follows the empirical findings in docs/ragdolls.md (issue #249's
// spike) and docs/skeletons.md (issue #250's `SkeletonSystem`):
//  - `RagdollSettings` is a REUSABLE TEMPLATE - build the skeleton/settings once per character
//    *type* (`buildTemplate`), cache it, and call `spawn()` (which wraps `CreateRagdoll`) once
//    per *instance*. Rebuilding a fresh template per spawn was shown to corrupt the wasm heap
//    after a couple of cycles - see "RagdollSettings is a reusable template" in docs/ragdolls.md.
//  - `Ragdoll.GetPose()` writes joint MATRICES directly and must not be followed by
//    `pose.CalculateJointMatrices()` (that call is only for the states-in / SkeletalAnimation
//    direction) - see `syncPoseNow`/`captureStep` below, both of which go straight from
//    `GetPose()` to `writePoseToBones()`.
//  - `ragdoll.RemoveFromPhysicsSystem()` before `destroy(ragdoll)` is mandatory - the very next
//    `PhysicsSystem.Step()` traps otherwise. See `RagdollInstance.destroy()`.
//  - `SetShape`/`mToParent`/`mSkeleton` transfer ownership on assignment (never destroy the
//    shape/constraint-settings/skeleton handed over that way - `RagdollSettings`'s own destroy()
//    cascades and frees them); `Vec3`/`RVec3`/`Quat` fields copy their value on assignment (the
//    temporary handed over must be destroyed right after, same as `constraint-system.ts`'s
//    `ownedVec3`/`Temporaries` pattern, reused here).
//
// One fact NOT in either doc, found while building this and worth flagging loudly:
// `SkeletonPose.SetSkeleton()` also transfers ownership - `Raw.module.destroy(pose)` frees the
// `Skeleton` it was set with, it does not just drop a borrowed reference. Binding every spawned
// instance's pose to the shared `template.skeleton` (the obvious thing to do, since `Ragdoll`'s
// own bodies were already built from it) frees that shared skeleton the first time ANY instance's
// pose is destroyed - corrupting `RagdollSettings.mSkeleton` for every other instance and the
// template itself, and reliably wasm-aborting the SECOND `pose.SetSkeleton()` call across the
// whole file with a wasm "OOM" that is actually a corrupted allocator, not real memory pressure.
// `spawn()` below therefore builds each instance a bare PRIVATE `Jolt.Skeleton` (`buildPoseSkeleton`,
// joint count/hierarchy only, no names/shapes/constraints - nothing else ever reads a pose's
// skeleton back) instead, and lets destroying the pose free it.
//
// A SECOND fact, also not in either doc, found and FIXED while resolving issue #275
// ("spawn -> destroy -> respawn on the same PhysicsSystem produces an empty Ragdoll"):
//
// `RagdollSettings` is itself a Jolt `RefTarget` - same family as the `SoftBodySharedSettings`
// refcount bug (#243) issue #275 pointed at as the likely lead. The *initial* hypothesis there
// (that `RagdollPart.SetShape()`/`mToParent`'s property setters skip `AddRef()` on the shape/
// constraint-settings objects) is REFUTED: padding a part's shape to `GetRefCount()` > 1000 with
// manual `AddRef()` calls before a spawn/destroy cycle does not fix the empty second ragdoll, so
// the shape (and constraint-settings) objects are not what's being freed prematurely.
//
// What actually happens: `RagdollSettings::CreateRagdoll()` gives the returned `Ragdoll` an
// internal back-reference to `this` (exposed read-only via `Ragdoll.GetRagdollSettings()`), and
// destroying a `Ragdoll` releases that reference. A JS-constructed `RagdollSettings` starts life
// at refcount 0 (RefTarget convention, same as a freshly `new`-ed `Shape`) - and the JS/WASM
// binder exposes NO `AddRef`/`Release`/`GetRefCount` on `RagdollSettings` at all (grepped
// `node_modules/jolt-physics/dist/types.d.ts` and confirmed at runtime: `settings.AddRef` is
// `undefined`), so nothing in this package could ever compensate for that missing reference
// directly. The FIRST `Ragdoll` built from a settings object becomes its only reference holder;
// destroying that Ragdoll drops the settings' refcount to 0, and Jolt's own `RefTarget::Release()`
// `delete`s it there and then - silently, with no JS-visible signal. Confirmed directly:
// `settings.mParts.size()` reads `0` (was `1`) and `settings.GetSkeleton().GetJointCount()` reads
// a garbage value immediately after the first spawned `Ragdoll`'s `destroy()`, even in the exact
// single-spawn-then-teardown sequence every test in this file used before this fix. The *previous*
// `RagdollTemplate.destroy()` then called `Raw.module.destroy(settings)` unconditionally - always
// a double free on an already-Jolt-freed object once any instance had been spawned, just one that
// happened not to trap immediately for a single spawn/destroy/teardown-in-order sequence (the
// freed block goes untouched before the process moves on). The very next `CreateRagdoll()` call on
// that same dangling `settings`, though, reads a zeroed `mParts` and returns a `Ragdoll` with
// `GetBodyCount() === 0` - exactly issue #275's symptom.
//
// THE FIX: `buildTemplate()` below creates one extra, permanent "keeper" `Ragdoll` right after
// building `settings` - added to the physics system and immediately removed again (never
// activated, never simulated, invisible to callers) purely so its existence holds a real reference
// on `settings` for the template's entire lifetime, no matter how many real instances `spawn()`
// creates and destroys. `RagdollTemplate.destroy()` destroys ONLY the keeper; `Raw.module.destroy
// (settings)` is never called directly any more - the keeper's own teardown is what makes Jolt's
// native refcounting free `settings` (cascading to `mSkeleton`, every part's shape, and every
// part's `mToParent`, same cascade as before), exactly once. Verified with a real-WASM probe: 5
// spawn/AddToPhysicsSystem/step/RemoveFromPhysicsSystem/destroy cycles on one template, each
// producing the correct body count, `sGetFreeMemory()` back at the pre-cycle baseline after the
// keeper (not `settings`) is destroyed. See `test/ragdoll-system.test.ts`'s
// "spawn -> destroy -> spawn again... 5 times" test and docs/ragdolls.md's updated ownership
// table. Worth an upstream jolt-physics report regardless (a `RefTarget` subclass with no
// AddRef/Release/GetRefCount exposed to JS is a real binder gap, and the underlying
// "Ragdoll silently frees its own RagdollSettings" behavior is surprising even in C++), but this
// package no longer needs one to support recycling ragdolls.

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Layer } from '../constants';
import { Raw } from '../raw';
import { devWarn } from '../utils';
import { BodyState } from './body-state';
import type { BodySystem } from './body-system';
import type { PhysicsSystem } from './physics-system';
import type { Vec3Tuple } from './shape-system';
import { createJoltSkeleton, type JoltSkeletonBuild, writePoseToBones } from './skeleton-system';

//* Public types =============================================================================

/**
 * How a joint is attached to its parent part.
 *
 * - `'swingTwist'` (default): a `SwingTwistConstraint` - a cone limit plus an independent twist
 *   limit, the usual ball-and-socket-ish ragdoll joint (shoulders, hips, neck).
 * - `'hinge'`: a `HingeConstraint` - one rotational degree of freedom (elbows, knees).
 * - `'fixed'`: a `FixedConstraint` - welds the part rigidly to its parent (no relative motion at
 *   all). Still its own body (Jolt requires exactly one `RagdollPart` per skeleton joint - see
 *   `RagdollSettings.mParts`/`Ragdoll.GetBodyID`, which are 1:1 with joint index), just one that
 *   cannot move relative to its parent.
 * - `'none'`: no constraint is created for this joint at all - it gets a body, but nothing
 *   connects it to its parent (it will fall away under gravity/collision on its own). This is
 *   **not** true shape merging (folding a bone's length into its parent's capsule, reducing the
 *   body count) - that would need work the #249 spike flagged as unverified
 *   (`mAdditionalConstraints`, `RagdollSettings::sRestoreFromBinaryState`) and is out of scope
 *   here. See docs/ragdolls.md's "Recommended design" section and this file's module doc.
 */
export type RagdollJointConstraint = 'swingTwist' | 'hinge' | 'fixed' | 'none';

/** Per-bone overrides. Keyed by bone name in {@link RagdollTemplateOptions.parts}. */
export interface RagdollPartOptions {
    /** Capsule radius. Defaults to `radiusFraction * boneLength`, see {@link RagdollTemplateOptions}. */
    radius?: number;
    /** Fraction of this bone's auto-detected length used as the radius when `radius` is omitted. */
    radiusFraction?: number;
    /** Full capsule length (distance between its two end caps' centers). Overrides the auto
     * length-from-child-bone-distance calculation described in {@link RagdollTemplateOptions}. */
    length?: number;
    /** Body mass in kg. Omitted lets Jolt compute it from the capsule's volume and density. */
    mass?: number;
    /** How this joint attaches to its parent. Defaults to `defaultConstraint` (itself `'swingTwist'`). Ignored on the root joint, which has no parent. */
    constraint?: RagdollJointConstraint;

    //* swingTwist -----------------------------------------
    /** Local twist axis (both bodies), world space at build time. Defaults to the bone's own direction (child - self, or inherited for a leaf). */
    twistAxis?: Vec3Tuple;
    /** Local plane axis, perpendicular to `twistAxis`. Auto-computed when omitted. */
    planeAxis?: Vec3Tuple;
    /** Full swing cone angle around the twist axis, radians. Default `Math.PI / 2` (90°). */
    normalConeAngle?: number;
    /** Full swing cone angle around the plane axis, radians. Default `Math.PI / 2` (90°). */
    planeConeAngle?: number;
    /** Twist limit lower bound, radians. Default `-Math.PI / 8` (~-22.5°). */
    twistMin?: number;
    /** Twist limit upper bound, radians. Default `Math.PI / 8` (~22.5°). */
    twistMax?: number;

    //* hinge ----------------------------------------------
    /** Hinge rotation axis. Defaults to a perpendicular of the bone's own direction. */
    hingeAxis?: Vec3Tuple;
    /** Reference axis perpendicular to `hingeAxis`, used to measure the limit angles. Defaults to the bone's own direction. */
    hingeNormal?: Vec3Tuple;
    /** Hinge limit lower bound, radians. Default `-Math.PI * 0.75`. */
    hingeMin?: number;
    /** Hinge limit upper bound, radians. Default `0`. */
    hingeMax?: number;
}

export type RagdollPartsConfig = Record<string, RagdollPartOptions>;

export interface RagdollTemplateOptions {
    /** Per-bone overrides, keyed by bone name (`THREE.Bone.name`). */
    parts?: RagdollPartsConfig;
    /** Default {@link RagdollPartOptions.constraint} for every joint that doesn't say its own. Default `'swingTwist'`. */
    defaultConstraint?: RagdollJointConstraint;
    /** Default {@link RagdollPartOptions.radiusFraction}. Default `0.15`. */
    defaultRadiusFraction?: number;
    /** Smallest capsule radius allowed, guards a zero/near-zero length bone. Default `0.03`. */
    minRadius?: number;
    /** Smallest capsule half-height allowed (guards a very short bone from an inverted capsule). Default `0.01`. */
    minHalfHeight?: number;
    /** Length assumed for a leaf bone (no children) whose parent is also a leaf-only chain, i.e. nothing to inherit from. Default `0.1`. */
    defaultLeafLength?: number;
    /** Jolt object layer every part is created on. Default `Layer.MOVING`, so a ragdoll collides with the world out of the box. Pass `Layer.RIG` for a rig that should stay non-colliding (see the module doc's note on `Layer.RIG`'s pair filter). */
    layer?: number;
    /** Call `RagdollSettings.Stabilize()` after building (improves inertia for long thin limb chains). Default `true`. */
    stabilize?: boolean;
    /** Call `RagdollSettings.DisableParentChildCollisions()` after building. Default `true`. */
    disableParentChildCollisions?: boolean;
}

/**
 * A reusable ragdoll template: one `Jolt.Skeleton` + one `Jolt.RagdollSettings`, built once per
 * character *type* and spawned from many times via {@link RagdollSystem.spawn} - including
 * respawning after a previous instance has been destroyed (issue #275). See the module doc -
 * rebuilding this per spawn is still unsafe, that part of the original finding stands.
 */
export interface RagdollTemplate {
    /** Owned by `settings.mSkeleton` once built - do not destroy separately, see {@link destroy}. */
    skeleton: Jolt.Skeleton;
    /**
     * Owned (indirectly - see {@link destroy}). Reusable: `spawn()` can be called on this any
     * number of times, including after previously spawned instances have been destroyed.
     */
    settings: Jolt.RagdollSettings;
    /** The bones this template was built from, `joints[i]` <-> joint/body index `i`. */
    joints: THREE.Bone[];
    /** `joints[i]`'s parent's index within `joints`, or `-1` for a root joint. */
    parentIndex: number[];
    /** The object layer every part was created on. */
    layer: number;
    /**
     * Frees `settings` (which cascades: skeleton, every part's shape, every part's `mToParent` -
     * see docs/ragdolls.md's ownership table) by destroying the template's internal "keeper"
     * `Ragdoll` (see the module doc's issue #275 finding) - **not** by calling
     * `Raw.module.destroy(settings)` directly, which would double-free `settings` once any
     * instance has ever been spawned from it. Safe to call once every spawned
     * {@link RagdollInstance} has already been destroyed; does not touch any live instance.
     */
    destroy(): void;
}

export interface SpawnRagdollOptions {
    /** Bones to drive instead of `template.joints` (same order/count). Lets one template be spawned against more than one skinned mesh's bone hierarchy. */
    bones?: THREE.Bone[];
    /** Whether the spawned ragdoll starts simulated. Default `'activate'`. */
    activation?: 'activate' | 'deactivate';
    userData?: number;
}

/** A live ragdoll instance: bodies + constraints in the simulation, plus its own pose/bone sync state. */
export interface RagdollInstance {
    ragdoll: Jolt.Ragdoll;
    /** Owned. Sized to the template's skeleton. */
    pose: Jolt.SkeletonPose;
    bones: THREE.Bone[];
    parentIndex: number[];
    /**
     * One `BodyState` per joint/body, `bodyStates[i]` <-> `ragdoll.GetBodyID(i)` <-> `bones[i]`.
     * Registered with the world's `BodySystem` (issue #251's `onCollisionEnter` etc. requirement)
     * on a plain, unparented `Object3D` proxy - **not** on `bones[i]` itself, since the bone's
     * transform is driven separately (parent-relative local space) by {@link syncPoseNow} /
     * {@link applyInterpolated}, not by the body sync loop's world-space write.
     */
    bodyStates: BodyState[];
    /** The Jolt collision group id this instance's parts were created with. */
    groupId: number;
    /** `bodyStates[i]` for the joint named `boneName`, or `undefined`. */
    getBodyState(boneName: string): BodyState | undefined;
    /**
     * Read the ragdoll's live pose and write it straight onto `bones` (no interpolation). Safe
     * to call any time after the ragdoll has stepped at least once.
     */
    syncPoseNow(): void;
    /**
     * Call once after every physics substep (see `useAfterPhysicsStep`): captures the live pose
     * into the previous/current snapshot pair {@link applyInterpolated} blends between, and - as
     * a side effect - writes the live (uninterpolated) pose onto `bones` too, so the rig always
     * shows *some* current pose even before a caller ever asks for interpolation.
     */
    captureStep(): void;
    /**
     * Blend the last two `captureStep()` snapshots by `alpha` (0..1, see
     * `PhysicsSystem.frameAlpha`) and write the result onto `bones`. Falls back to whatever
     * `captureStep()` last wrote (the live pose) until two snapshots exist.
     */
    applyInterpolated(alpha: number): void;
    /** `RemoveFromPhysicsSystem()` then `destroy()`, in that order - see the module doc. Idempotent. */
    destroy(): void;
}

//* Internal: owned-temporary tracking (mirrors constraint-system.ts's Temporaries) ==========

const ownedVec3 = (v: Vec3Tuple): Jolt.Vec3 => new Raw.module.Vec3(v[0], v[1], v[2]);
const ownedRVec3 = (v: THREE.Vector3): Jolt.RVec3 => new Raw.module.RVec3(v.x, v.y, v.z);
const ownedQuat = (q: THREE.Quaternion): Jolt.Quat => new Raw.module.Quat(q.x, q.y, q.z, q.w);

class Temporaries {
    private items: unknown[] = [];
    track<T>(item: T): T {
        this.items.push(item);
        return item;
    }
    release(): void {
        for (const item of this.items) Raw.module.destroy(item);
        this.items.length = 0;
    }
}

/**
 * A bare `Jolt.Skeleton` sized/shaped like `parentIndex` (joint names are not meaningful here -
 * nothing reads them back off a `SkeletonPose`'s skeleton, only `GetJointCount()`/the hierarchy
 * matter), for a `SkeletonPose` to own privately. See the "PRIVATE skeleton" comment in `spawn()`
 * for why this can never be `template.skeleton` itself.
 */
function buildPoseSkeleton(parentIndex: number[]): Jolt.Skeleton {
    const jolt = Raw.module;
    const skeleton = new jolt.Skeleton();
    parentIndex.forEach((parent, i) => {
        const name = new jolt.JPHString(`joint_${i}`, `joint_${i}`.length);
        skeleton.AddJoint(name, parent);
        jolt.destroy(name);
    });
    skeleton.CalculateParentJointIndices();
    return skeleton;
}

//* Internal: bone geometry (length/direction/world position per joint) ======================

interface BoneGeometry {
    worldPosition: THREE.Vector3[];
    /** Unit vector, world space: this bone's own long axis. */
    direction: THREE.Vector3[];
    /** Full length (distance to the child used for `direction`, or inherited). */
    length: number[];
}

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

function computeBoneGeometry(
    joints: THREE.Bone[],
    parentIndex: number[],
    defaultLeafLength: number
): BoneGeometry {
    // Force every root's subtree matrixWorld current - a synthetic rig built in a test (or
    // spawned this frame, before three's own render loop has ticked) never had updateMatrixWorld
    // called on it, and getWorldPosition below silently reads a stale (usually identity) matrix
    // otherwise.
    const roots = new Set<THREE.Bone>();
    parentIndex.forEach((p, i) => {
        if (p < 0) roots.add(joints[i]);
    });
    for (const root of roots) root.updateWorldMatrix(true, true);

    const worldPosition = joints.map((bone) => bone.getWorldPosition(new THREE.Vector3()));

    const children: number[][] = joints.map(() => []);
    parentIndex.forEach((p, i) => {
        if (p >= 0) children[p].push(i);
    });

    const direction = joints.map(() => new THREE.Vector3(0, 1, 0));
    const length = joints.map(() => defaultLeafLength);
    const resolved = joints.map(() => false);

    // First pass: every bone with at least one child gets a real direction/length, towards its
    // first child (matches the issue's "length from child bone distance").
    for (let i = 0; i < joints.length; i++) {
        const kids = children[i];
        if (kids.length === 0) continue;
        const child = kids[0];
        const delta = worldPosition[child].clone().sub(worldPosition[i]);
        const dist = delta.length();
        if (dist > 1e-6) {
            direction[i].copy(delta).normalize();
            length[i] = dist;
            resolved[i] = true;
        }
    }
    // Second pass: leaves (and any bone whose only child was degenerate, distance ~0) inherit
    // their parent's direction/length - a plausible "same thickness as what it hangs off of"
    // guess, and always better than falling back to a fixed default for every hand/foot/head bone.
    for (let i = 0; i < joints.length; i++) {
        if (resolved[i]) continue;
        const parent = parentIndex[i];
        if (parent >= 0) {
            direction[i].copy(direction[parent]);
            length[i] = length[parent];
        }
    }

    return { worldPosition, direction, length };
}

/** A stable perpendicular of `axis` - cross with world up, falling back to world right when `axis` is nearly parallel to up. */
function perpendicularOf(axis: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(axis.dot(UP)) > 0.99 ? RIGHT : UP;
    return new THREE.Vector3().crossVectors(axis, reference).normalize();
}

//* RagdollSystem =============================================================================

export class RagdollSystem {
    physicsSystem: PhysicsSystem;
    bodySystem: BodySystem;
    /** Collision group id allocator (issue #251/docs/ragdolls.md's "Recommended design"): each `spawn()` gets its own, so `DisableParentChildCollisions()` on the shared template's group filter only ever governs one instance's own bodies. */
    private nextGroupId = 1;

    constructor(physicsSystem: PhysicsSystem) {
        this.physicsSystem = physicsSystem;
        this.bodySystem = physicsSystem.bodySystem;
    }

    //* Template building =====================================================================

    /**
     * Build a reusable {@link RagdollTemplate} from a three.js `Skeleton` or root `Bone` - see
     * `SkeletonSystem.createJoltSkeleton` for how bone order/hierarchy is captured. One capsule
     * per joint (auto-sized from the distance to its first child bone, or inherited for a leaf),
     * one constraint per non-root joint (default `swingTwist`).
     */
    buildTemplate(
        source: THREE.Skeleton | THREE.Bone,
        options: RagdollTemplateOptions = {}
    ): RagdollTemplate {
        const jolt = Raw.module;
        const {
            parts = {},
            defaultConstraint = 'swingTwist',
            defaultRadiusFraction = 0.15,
            minRadius = 0.03,
            minHalfHeight = 0.01,
            defaultLeafLength = 0.1,
            layer = Layer.MOVING,
            stabilize = true,
            disableParentChildCollisions = true
        } = options;

        const build: JoltSkeletonBuild = createJoltSkeleton(source);
        const { skeleton, joints, parentIndex } = build;
        const geometry = computeBoneGeometry(joints, parentIndex, defaultLeafLength);

        const settings = new jolt.RagdollSettings();
        settings.mSkeleton = skeleton; // ownership transfers - see docs/ragdolls.md
        settings.mParts.resize(joints.length);

        const temps = new Temporaries();
        try {
            joints.forEach((bone, i) => {
                const partOptions = parts[bone.name] ?? {};
                const part = settings.mParts.at(i);

                const length = partOptions.length ?? geometry.length[i];
                const radius = Math.max(
                    minRadius,
                    partOptions.radius ??
                        length * (partOptions.radiusFraction ?? defaultRadiusFraction)
                );
                const halfHeight = Math.max(minHalfHeight, length / 2 - radius);

                // create_rig.html's pattern (docs/ragdolls.md): a capsule built directly, no
                // CapsuleShapeSettings.Create() round trip. SetShape takes a RefConst<Shape> - we
                // do not destroy `shape` ourselves, RagdollSettings' destructor cascades it.
                const shape = new jolt.CapsuleShape(halfHeight, radius);
                part.SetShape(shape);

                // The capsule's local +Y is its long axis; orient it along the bone's own
                // direction and center it at the midpoint of the segment it represents.
                const orientation = new THREE.Quaternion().setFromUnitVectors(
                    UP,
                    geometry.direction[i]
                );
                const center = geometry.worldPosition[i]
                    .clone()
                    .addScaledVector(geometry.direction[i], length / 2);

                const position = temps.track(ownedRVec3(center));
                part.mPosition = position;
                const rotation = temps.track(ownedQuat(orientation));
                part.mRotation = rotation;

                part.mMotionType = jolt.EMotionType_Dynamic;
                part.mObjectLayer = layer;
                if (partOptions.mass !== undefined) {
                    part.mOverrideMassProperties = jolt.EOverrideMassProperties_CalculateInertia;
                    part.mMassPropertiesOverride.mMass = partOptions.mass;
                }

                if (parentIndex[i] < 0) return; // root: no constraint to a parent
                const constraintType = partOptions.constraint ?? defaultConstraint;
                if (constraintType === 'none') return;
                part.mToParent = this.buildJointConstraint(
                    constraintType,
                    geometry.worldPosition[i],
                    geometry.direction[i],
                    partOptions,
                    temps
                );
            });

            if (stabilize) settings.Stabilize();
            if (disableParentChildCollisions) settings.DisableParentChildCollisions();
            settings.CalculateBodyIndexToConstraintIndex();
            settings.CalculateConstraintIndexToBodyIdxPair();
        } finally {
            // Jolt copied every Vec3/RVec3/Quat field's value on assignment by now; the
            // TwoBodyConstraintSettings objects handed to `mToParent` are NOT tracked here (that
            // assignment transfers ownership - see docs/ragdolls.md's table), only the plain
            // value-type temporaries used to build them.
            temps.release();
        }

        // *** issue #275 fix: a permanent "keeper" Ragdoll ***
        // `RagdollSettings` is itself a Jolt RefTarget with no AddRef/Release/GetRefCount exposed
        // to JS (see the module doc). `CreateRagdoll()` gives the returned `Ragdoll` the settings'
        // only reference; without a keeper, destroying the first (or last) spawned instance drops
        // that reference to zero and Jolt frees `settings` out from under this template, silently
        // corrupting every later `spawn()`. This keeper is added to the physics system and
        // immediately removed again (never activated, never stepped, never handed to a caller) -
        // its sole job is to hold `settings` alive for the template's whole lifetime. See
        // `destroy()` below for why `settings` must never be destroyed directly once this exists.
        const keeperGroupId = this.nextGroupId++;
        const keeper = settings.CreateRagdoll(
            keeperGroupId,
            0,
            this.physicsSystem.joltPhysicsSystem
        );
        keeper.AddToPhysicsSystem(jolt.EActivation_DontActivate);
        keeper.RemoveFromPhysicsSystem();

        let destroyed = false;
        const destroy = () => {
            if (destroyed) return;
            destroyed = true;
            // Destroying the keeper releases the LAST reference on `settings`, and Jolt's own
            // RefTarget::Release() frees it right there - cascading to mSkeleton, every part's
            // shape and every part's mToParent, same cascade `docs/ragdolls.md`'s ownership table
            // always documented. Calling `jolt.destroy(settings)` here too would be a double free
            // (verified: it traps with "memory access out of bounds", not silently) - the keeper
            // IS the destroy path now, not an addition to it. `skeleton` must still never be
            // destroyed separately either. The keeper was already removed from the physics system
            // right after it was created above, so no RemoveFromPhysicsSystem() call belongs here.
            jolt.destroy(keeper);
        };

        return {
            skeleton,
            settings,
            joints,
            parentIndex,
            layer,
            destroy
        };
    }

    /** Builds (and returns, uninstalled) the `mToParent` settings for one non-root joint. */
    private buildJointConstraint(
        type: Exclude<RagdollJointConstraint, 'none'>,
        jointPosition: THREE.Vector3,
        boneDirection: THREE.Vector3,
        options: RagdollPartOptions,
        temps: Temporaries
    ): Jolt.TwoBodyConstraintSettings {
        const jolt = Raw.module;
        const position = temps.track(ownedRVec3(jointPosition));

        if (type === 'fixed') {
            const settings = new jolt.FixedConstraintSettings();
            settings.mPoint1 = settings.mPoint2 = position;
            return settings;
        }

        if (type === 'hinge') {
            const settings = new jolt.HingeConstraintSettings();
            settings.mPoint1 = settings.mPoint2 = position;
            const axis = options.hingeAxis
                ? temps.track(ownedVec3(options.hingeAxis))
                : temps.track(ownedVec3(perpendicularOf(boneDirection).toArray() as Vec3Tuple));
            settings.mHingeAxis1 = settings.mHingeAxis2 = axis;
            const normal = options.hingeNormal
                ? temps.track(ownedVec3(options.hingeNormal))
                : temps.track(ownedVec3(boneDirection.toArray() as Vec3Tuple));
            settings.mNormalAxis1 = settings.mNormalAxis2 = normal;
            settings.mLimitsMin = options.hingeMin ?? -Math.PI * 0.75;
            settings.mLimitsMax = options.hingeMax ?? 0;
            return settings;
        }

        // swingTwist (default)
        const settings = new jolt.SwingTwistConstraintSettings();
        settings.mPosition1 = settings.mPosition2 = position;
        const twistAxis = options.twistAxis
            ? temps.track(ownedVec3(options.twistAxis))
            : temps.track(ownedVec3(boneDirection.toArray() as Vec3Tuple));
        settings.mTwistAxis1 = settings.mTwistAxis2 = twistAxis;
        const planeAxis = options.planeAxis
            ? temps.track(ownedVec3(options.planeAxis))
            : temps.track(ownedVec3(perpendicularOf(boneDirection).toArray() as Vec3Tuple));
        settings.mPlaneAxis1 = settings.mPlaneAxis2 = planeAxis;
        settings.mNormalHalfConeAngle = (options.normalConeAngle ?? Math.PI / 2) / 2;
        settings.mPlaneHalfConeAngle = (options.planeConeAngle ?? Math.PI / 2) / 2;
        settings.mTwistMinAngle = options.twistMin ?? -Math.PI / 8;
        settings.mTwistMaxAngle = options.twistMax ?? Math.PI / 8;
        return settings;
    }

    //* Spawning ==============================================================================

    /**
     * Create a live `Jolt.Ragdoll` from `template` and add it to the world. Registers one
     * `BodyState` per part so `onCollisionEnter`/etc. work through the normal `BodySystem`
     * dispatch, and registers the instance as a `PhysicsSystem` disposable so a world torn down
     * directly (not through `<Ragdoll>` unmounting) still tears this down in the right order -
     * `RemoveFromPhysicsSystem` before the generic constraint/body teardown, matching the hard
     * invariant in docs/ragdolls.md.
     *
     * Safe to call again on the same `template` after a previously spawned instance (on the same
     * or a different `PhysicsSystem`) has been destroyed - see issue #275 and the module doc's
     * "keeper" finding. Earlier versions of this function could only be called once per template
     * per `PhysicsSystem`'s lifetime before every subsequent call silently produced an empty
     * `Ragdoll`; `buildTemplate()` now protects against that at the template level, so `spawn()`
     * itself needed no changes.
     */
    spawn(template: RagdollTemplate, options: SpawnRagdollOptions = {}): RagdollInstance {
        const jolt = Raw.module;
        const bones = options.bones ?? template.joints;
        if (bones.length !== template.joints.length)
            devWarn(
                `RagdollSystem.spawn: ${bones.length} bones passed, template has ` +
                    `${template.joints.length} joints - they must match 1:1`
            );

        const groupId = this.nextGroupId++;
        const ragdoll = template.settings.CreateRagdoll(
            groupId,
            options.userData ?? 0,
            this.physicsSystem.joltPhysicsSystem
        );
        const activation =
            options.activation === 'deactivate'
                ? jolt.EActivation_DontActivate
                : jolt.EActivation_Activate;
        // Mandatory pairing with RemoveFromPhysicsSystem() in destroy() below - see the module doc.
        ragdoll.AddToPhysicsSystem(activation);

        // A PRIVATE skeleton for this instance's pose - NOT `template.skeleton`. Verified
        // empirically (not in docs/ragdolls.md or docs/skeletons.md - this spike didn't test
        // spawning more than one instance's `SkeletonPose` against a shared skeleton): destroying
        // a `SkeletonPose` frees the `Skeleton` it was `SetSkeleton()`-ed with - `SkeletonPose`
        // takes ownership on that call, it does not just borrow a reference. Reusing
        // `template.skeleton` here corrupted the wasm heap on the SECOND spawn from one template
        // (`pose.SetSkeleton()` itself aborted with a wasm OOM, the signature of a freed/
        // corrupted allocator, not a real out-of-memory condition - `RagdollSettings.mSkeleton`
        // had already been freed out from under it by the first instance's `destroy(pose)`, and
        // `RagdollSettings` itself would then double free the same pointer when eventually
        // destroyed too). See docs/ragdolls.md's updated ownership table.
        const privateSkeleton = buildPoseSkeleton(template.parentIndex);
        const pose = new jolt.SkeletonPose();
        pose.SetSkeleton(privateSkeleton);
        // `pose` now owns `privateSkeleton` - never destroy it separately, see above.

        // One BodyState per part, on an unparented Object3D proxy (never the bone itself - see
        // RagdollInstance.bodyStates' doc). `skipAddBody` because AddToPhysicsSystem() above
        // already added these bodies to the simulation.
        const bodyStates: BodyState[] = [];
        const byName = new Map<string, BodyState>();
        for (let i = 0; i < template.joints.length; i++) {
            const bodyId = ragdoll.GetBodyID(i);
            const body = this.physicsSystem.joltPhysicsSystem
                .GetBodyLockInterfaceNoLock()
                .TryGetBody(bodyId);
            if (!body) {
                devWarn(`RagdollSystem.spawn: could not resolve part ${i}'s body, skipping it`);
                continue;
            }
            const proxy = new THREE.Object3D();
            proxy.name = template.joints[i].name;
            this.bodySystem.addExistingBody(proxy, body, {
                bodyType: 'dynamic',
                index: i,
                skipAddBody: true
            });
            const handle = bodyId.GetIndexAndSequenceNumber();
            const state = this.bodySystem.getBody(handle);
            if (!state) throw new Error('r3/jolt: RagdollSystem failed to register a part body');
            bodyStates.push(state);
            byName.set(template.joints[i].name, state);
        }

        const jointCount = template.joints.length;
        const previousModel = Array.from({ length: jointCount }, () => new THREE.Matrix4());
        const currentModel = Array.from({ length: jointCount }, () => new THREE.Matrix4());
        let captures = 0;

        const syncPoseNow = () => {
            // GetPose() writes joint MATRICES directly - no CalculateJointMatrices() call, see
            // the module doc and docs/ragdolls.md's "big gotcha".
            ragdoll.GetPose(pose, true);
            writePoseToBones(pose, bones, template.parentIndex);
        };

        const captureStep = () => {
            // shift current -> previous (copy, not swap: callers may be mid-read of the arrays)
            for (let i = 0; i < jointCount; i++) previousModel[i].copy(currentModel[i]);
            ragdoll.GetPose(pose, true);
            writePoseToBones(pose, bones, template.parentIndex, {
                modelMatrixScratch: currentModel
            });
            if (captures < 2) captures++;
        };

        const applyInterpolated = (alpha: number) => {
            if (captures < 2) return; // not enough history yet - bones already hold the live pose
            applyBlendedModelMatrices(
                previousModel,
                currentModel,
                alpha,
                bones,
                template.parentIndex
            );
        };

        let destroyed = false;
        const unregister = this.physicsSystem.registerDisposable({
            destroy: () => destroyInstance()
        });
        const destroyInstance = () => {
            if (destroyed) return;
            destroyed = true;
            unregister();
            // Unregister every part's BodyState without touching Jolt: the bodies/constraints
            // are Ragdoll's to free, below. Mirrors BodySystem.forget()'s bookkeeping, minus the
            // bodyInterface calls removeBody() would make (those are exactly what must NOT
            // happen here - see the module doc's "RemoveFromPhysicsSystem() is not optional").
            for (const state of bodyStates) {
                state.dispose();
                const handle = state.handle;
                this.bodySystem.bodies.delete(handle);
                this.bodySystem.dynamicBodies.delete(handle);
            }
            // Mandatory order (docs/ragdolls.md): RemoveFromPhysicsSystem() before destroy(),
            // every time, or the next Step() traps with an out-of-bounds wasm access.
            if (!this.physicsSystem.destroyed) ragdoll.RemoveFromPhysicsSystem();
            jolt.destroy(ragdoll);
            jolt.destroy(pose);
        };

        return {
            ragdoll,
            pose,
            bones,
            parentIndex: template.parentIndex,
            bodyStates,
            groupId,
            getBodyState: (boneName: string) => byName.get(boneName),
            syncPoseNow,
            captureStep,
            applyInterpolated,
            destroy: destroyInstance
        };
    }
}

//* Interpolation ==============================================================================

const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _blendedPosition = new THREE.Vector3();
const _blendedQuaternion = new THREE.Quaternion();
const _localMatrix = new THREE.Matrix4();
const _decomposedPosition = new THREE.Vector3();
const _decomposedQuaternion = new THREE.Quaternion();
const _decomposedScale = new THREE.Vector3();

/**
 * Blend two model-space matrix snapshots per joint (position lerp, rotation slerp) and write the
 * result onto `bones` as parent-relative local transforms - the same hierarchy walk
 * `SkeletonSystem.writePoseToBones` does for a single live pose (`local(i) =
 * inverse(model(parent(i))) * model(i)`), reimplemented here because the inputs are two blended
 * snapshots rather than a live `Jolt.SkeletonPose` `writePoseToBones` could read from directly.
 */
function applyBlendedModelMatrices(
    previous: THREE.Matrix4[],
    current: THREE.Matrix4[],
    alpha: number,
    bones: THREE.Bone[],
    parentIndex: number[]
): void {
    const count = Math.min(previous.length, current.length, bones.length, parentIndex.length);
    const blended: THREE.Matrix4[] = [];
    for (let i = 0; i < count; i++) {
        previous[i].decompose(_p1, _q1, _s);
        current[i].decompose(_p2, _q2, _s);
        _blendedPosition.lerpVectors(_p1, _p2, alpha);
        _blendedQuaternion.copy(_q1).slerp(_q2, alpha);
        blended.push(
            new THREE.Matrix4().compose(_blendedPosition, _blendedQuaternion, _s.set(1, 1, 1))
        );
    }
    for (let i = 0; i < count; i++) {
        const parent = parentIndex[i];
        const local = parent >= 0 ? _localMatrix.copy(blended[parent]) : blended[i];
        if (parent >= 0) local.invert().multiply(blended[i]);
        local.decompose(_decomposedPosition, _decomposedQuaternion, _decomposedScale);
        bones[i].position.copy(_decomposedPosition);
        bones[i].quaternion.copy(_decomposedQuaternion);
    }
}
