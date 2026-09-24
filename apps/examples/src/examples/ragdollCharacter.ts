// Shared character-rig helpers for the Ragdolls/PoweredRagdoll demos (issue #253).
//
// `Soldier.glb` (apps/examples/src/assets/models, see LICENSE.md there) is a Mixamo-derived
// humanoid with 49 skin joints, including individual finger bones and toe bones -
// `RagdollSystem.buildTemplate` puts one capsule + one constraint on EVERY joint (no shape
// merging - see docs/ragdolls.md), so a real GLTF rig like this needs real `parts` tuning, not
// just the auto radius-from-bone-length heuristic. This file is that tuning, worked out against
// the real asset (see the module doc at the bottom for what changed and why).
import type { RagdollInstance, RagdollPartsConfig } from '@react-three/jolt';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

export const SOLDIER_URL = new URL('../assets/models/Soldier.glb', import.meta.url).href;

/** A cloned character instance ready to spawn a ragdoll from (own skeleton, own bones). */
export interface ClonedCharacter {
    /** The visual hierarchy (glTF "Character" node, SkinnedMesh, etc.) - render this. */
    scene: THREE.Object3D;
    mesh: THREE.SkinnedMesh;
    /** `bones[0]` (the root/Hips joint) is NOT a descendant of `scene` - see `normalizeRagdollRoot`. */
    bones: THREE.Bone[];
}

/**
 * `SkeletonUtils.clone` (not `Object3D.clone`, which does NOT rebind a `SkinnedMesh`'s skeleton -
 * every clone would share one skeleton/bones array, so two spawned ragdolls would fight over the
 * same bones) - each pile member / respawn needs its own independent bone hierarchy to hand to
 * `RagdollSystem.spawn`'s `bones` option (the template itself is shared, see docs/ragdolls.md's
 * "RagdollSettings is a reusable template").
 *
 * `worldPosition` places the character (baked into `scene.position` BEFORE the root-bone fix
 * below runs, so it ends up correctly folded into the root bone's normalized local transform too -
 * see `normalizeRagdollRoot`'s doc comment for why a `<group position>` wrapper applied AFTER
 * cloning does not work for this). `boneRoot` is where the reparented root bone (and therefore the
 * whole bone hierarchy - moving a bone moves its children) ends up living; pass the top-level r3f
 * `THREE.Scene` (`useThree().scene`), which - like `<Ragdoll debug>`'s own part proxies - is the
 * one node in the tree guaranteed to sit at true world identity.
 */
export function cloneCharacter(
    source: THREE.Object3D,
    boneRoot: THREE.Object3D,
    worldPosition?: THREE.Vector3
): ClonedCharacter {
    const scene = cloneSkeleton(source) as THREE.Object3D;
    if (worldPosition) scene.position.copy(worldPosition);
    let mesh: THREE.SkinnedMesh | undefined;
    scene.traverse((child) => {
        if (!mesh && (child as THREE.SkinnedMesh).isSkinnedMesh) mesh = child as THREE.SkinnedMesh;
    });
    if (!mesh) throw new Error('ragdollCharacter: cloned scene has no SkinnedMesh');
    normalizeRagdollRoot(scene, mesh, boneRoot);
    return { scene, mesh, bones: mesh.skeleton.bones };
}

/**
 * **Real finding (issue #253), the input-side twin of the "root translation" gap documented in
 * docs/ragdolls.md**: `Soldier.glb` (and every Mixamo-exported GLTF character) parents its
 * skeleton root (`Hips`) under an ancestor node (`Character`) carrying a non-identity transform -
 * here a `0.01` uniform scale plus a -90 degrees X rotation (Mixamo's Y-up-in-centimeters ->
 * three.js-style Z-up-in-meters axis/unit conversion, baked into the glTF itself, verified by
 * dumping the raw glTF JSON's `nodes` array). `SkeletonSystem.readPoseFromBones` - and therefore
 * `RagdollInstance.driveStep()` in `'animated'`/`'powered'` mode - reads `bones[0]`'s LOCAL
 * position directly as the ROOT'S WORLD target for `DriveToPoseUsingKinematics`/
 * `DriveToPoseUsingMotors` (see docs/ragdolls.md: "joint 0 has no parent, so its local state IS
 * its world target directly"). That convention silently assumes `bones[0].parent`'s transform is
 * identity - true for every synthetic rig `docs/ragdolls.md`/`docs/skeletons.md` verified against,
 * false here. Left alone, `driveStep()` reads Hips' RAW un-scaled local position (e.g. `(-0.16,
 * 1.15, 106.13)` - centimeters, pre-rotation) as if it were already a meters-scale world target,
 * and the kinematic drive throws the root capsule roughly 100x too far on one axis - reproduced
 * empirically (a throwaway build+drive probe against this exact asset put the root ~106 units
 * away after 10 substeps, not a few centimeters of settling error).
 *
 * The fix needs no core-package change: `THREE.Object3D.attach()` reparents a child while
 * preserving its WORLD transform, recomputing the local one - exactly what's needed to make
 * `bones[0]`'s local transform equal its real-world (correctly scaled/rotated) transform. Safe
 * here specifically because the ancestor scale is uniform (`attach()` does not support
 * non-uniform scale in the chain it walks - see three.js's own doc comment on the method).
 *
 * **A second, non-obvious requirement found while wiring this into a positioned demo character**:
 * `bones[0]`'s local value only equals a USABLE world target if `bones[0].parent` is ITSELF at
 * true world identity - reparenting under a `<group position={spawnPos}>` wrapper (an earlier
 * version of this file did exactly that) makes `attach()` SUBTRACT `spawnPos` back out (it
 * preserves the bone's WORLD transform relative to a parent that now sits AT `spawnPos`), so the
 * resulting local value silently drops the spawn offset - `driveStep()` would then target the
 * character's un-positioned bind location, not wherever it was actually spawned. Fixed by
 * reparenting the root bone under `boneRoot` (expected to be the r3f scene root, always identity)
 * instead of under any node that carries the spawn placement, and baking the spawn position into
 * `scene.position` BEFORE this runs (see `cloneCharacter`) so `getWorldPosition()`-based capsule
 * placement - unaffected by any of this, see below - still ends up in the right place too.
 *
 * Called once, right after loading/cloning, before the skeleton is ever handed to
 * `RagdollSystem.buildTemplate`/`spawn` - capsule PLACEMENT was never affected by the root-parent
 * issue itself (`computeBoneGeometry` reads world positions via `getWorldPosition()`, already
 * transform-chain-correct regardless of where in the graph a bone's ancestors live), only the
 * `'animated'`/`'powered'` DRIVE target was.
 */
export function normalizeRagdollRoot(
    scene: THREE.Object3D,
    mesh: THREE.SkinnedMesh,
    boneRoot: THREE.Object3D
): void {
    const root = mesh.skeleton.bones[0];
    if (root.parent === boneRoot) return;
    scene.updateMatrixWorld(true);
    boneRoot.attach(root);
}

const _rootOffset = new THREE.Vector3();

/**
 * **The output-side twin, and the gap issue #253 explicitly called out**: `RagdollInstance
 * .captureStep()` (via `SkeletonSystem.writePoseToBones`) always writes the root bone's OWN local
 * translation back as `(0, 0, 0)` - `Ragdoll.GetPose()`'s joint-matrix convention makes joint 0's
 * matrix translation identically zero BY DEFINITION (`GetRootOffset()` IS the root body's live
 * world position, and joint 0's matrix translation is `worldPosition(0) - GetRootOffset()`, always
 * zero - see docs/ragdolls.md's "Joint matrices are root-relative model space"). Verified this
 * still holds exactly against the real 49-joint Soldier rig (not just the synthetic 4-joint test
 * rigs docs/ragdolls.md's own finding was based on): `bones[0].position` reads back as precisely
 * `(0, 0, 0)` after every `captureStep()`, in every drive mode, hero or pile.
 *
 * `<Ragdoll>`'s own internal `captureStep()` call has no option to fix this (it always calls
 * `writePoseToBones` without `options.root`), so this restores the real value the same way
 * `writePoseToBones`'s own `options.root` parameter would - from `pose.GetRootOffset()` (an
 * `RVec3`, the WebIDL binder's one static temporary for that call - read into a plain
 * `THREE.Vector3` immediately, never held) - converted into `bones[0].parent`'s local space (the
 * identity frame `normalizeRagdollRoot` created, so in practice this is a near-identity copy, but
 * going through `worldToLocal` keeps this correct even if a caller nests that frame under a moving
 * parent later).
 *
 * Call from a `useAfterPhysicsStep` mounted in a component that renders the `<Ragdoll>` (or this
 * file's `RagdollActor`) as a CHILD - effects commit bottom-up on mount, so a parent's subscription
 * registers, and therefore fires, after the child's own `captureStep()` - the same ordering
 * `<Ragdoll>`'s own module doc relies on for `<Debug>`.
 */
export function restoreRootBonePosition(instance: RagdollInstance): void {
    const bone = instance.bones[0];
    const offset = instance.pose.GetRootOffset();
    _rootOffset.set(offset.GetX(), offset.GetY(), offset.GetZ());
    if (bone.parent) {
        bone.parent.updateWorldMatrix(true, false);
        bone.parent.worldToLocal(_rootOffset);
    }
    bone.position.copy(_rootOffset);
}

/**
 * Bone-name-pattern-driven `parts` overrides for `<Ragdoll>`/`RagdollSystem.buildTemplate`,
 * built from `bones` at runtime rather than hardcoded per name - works for `Soldier.glb` and
 * `Xbot.glb` alike (both are Mixamo rigs with the same joint names), and degrades gracefully
 * (falls through to the auto heuristic) on any other similarly-named humanoid rig.
 *
 * **Real finding (issue #253): GLTFLoader strips the `mixamorig:` colon from bone names** -
 * `THREE.PropertyBinding`'s node-name sanitizing turns `mixamorig:LeftUpLeg` into
 * `mixamorigLeftUpLeg` on load (verified by logging `mesh.skeleton.bones.map(b => b.name)` against
 * the real asset - every name in this file's matching below had to drop the colon prefix
 * assumption and match on the un-prefixed suffix instead, e.g. `endsWith('UpLeg')`, not
 * `=== 'mixamorig:Hips'`). Any doc/snippet elsewhere that shows a colon-prefixed Mixamo bone name
 * is describing the *source* rig, not what a `THREE.Skeleton` loaded through `GLTFLoader` actually
 * hands back.
 */
export function buildSoldierParts(bones: THREE.Bone[]): RagdollPartsConfig {
    const parts: RagdollPartsConfig = {};
    const isDigit = (name: string) =>
        /(HandThumb|HandIndex|HandMiddle|HandRing|HandPinky)\d/.test(name) ||
        name.endsWith('_End') ||
        name.endsWith('ToeBase');

    for (const bone of bones) {
        const name = bone.name;

        // Fingers/toes/end-effectors: the auto heuristic already sizes these fine (they're real
        // leaves with short real segments), but 10 free swingTwist joints per hand jitter
        // visibly and add constraint-solver cost for no visual payoff at demo scale - weld them.
        if (isDigit(name)) {
            parts[name] = { constraint: 'fixed', radiusFraction: 0.4 };
            continue;
        }

        // Hips (root - no constraint, but still needs a real pelvis-sized capsule): auto length
        // is the distance to Spine (~0.096, a short segment) - radiusFraction off that undersizes
        // it badly (~0.014 radius). Real pelvis-width numbers instead.
        if (name.endsWith('Hips')) {
            parts[name] = { radius: 0.14, length: 0.22 };
            continue;
        }

        // Spine chain: auto length (~0.11-0.14) is a reasonable torso-segment length already;
        // only the radius needed bumping up from radiusFraction's default (torso is much wider
        // than the vertebra-to-vertebra bone distance suggests).
        if (name.includes('Spine')) {
            parts[name] = { radius: 0.12 };
            continue;
        }

        // Neck: real bone is tiny (~0.03 long) - auto radius clamps to `minRadius` (a near-sphere
        // stub). Fine for a neck, but give it a touch more length so it doesn't fully bury inside
        // the head/spine capsules.
        if (name.includes('Neck')) {
            parts[name] = { radius: 0.06, length: 0.1 };
            continue;
        }

        // Head: a LEAF in the 49-joint skin (HeadTop_End is not itself a skin joint), so the auto
        // heuristic makes it INHERIT Neck's ~0.03 length/direction (see computeBoneGeometry's
        // "leaves inherit their parent" pass in ragdoll-system.ts) - radius clamps to `minRadius`
        // (0.03), producing a near-invisible capsule at head height instead of a head. Needed a
        // fully explicit size, not just a bigger radiusFraction (there is no usable auto length to
        // scale from here).
        if (name.endsWith('Head')) {
            parts[name] = { radius: 0.11, length: 0.22 };
            continue;
        }

        // Shoulders/upper arms: auto radiusFraction (0.15 default) is close; nudge up slightly.
        if (name.includes('Shoulder') || (name.endsWith('Arm') && !name.includes('Fore'))) {
            parts[name] = { radiusFraction: 0.17 };
            continue;
        }
        if (name.includes('ForeArm')) {
            parts[name] = { radiusFraction: 0.14 };
            continue;
        }

        // Hands: auto length (~0.05) * default radiusFraction gives a near-invisible ~0.007
        // radius nub - explicit paddle-sized capsule instead.
        if (name.endsWith('Hand')) {
            parts[name] = { radius: 0.035, length: 0.1 };
            continue;
        }

        if (name.includes('UpLeg')) {
            parts[name] = { radiusFraction: 0.17 };
            continue;
        }
        // NOTE: check UpLeg (above) before this - 'UpLeg' also ends with 'Leg'.
        if (name.endsWith('Leg')) {
            parts[name] = { radiusFraction: 0.12 };
            continue;
        }
        if (name.endsWith('Foot')) {
            parts[name] = { radius: 0.05 };
        }
        // every other bone (there are none left in this rig, but keeps this future-proof for a
        // differently-named humanoid): fall through to RagdollTemplateOptions' own defaults.
    }
    return parts;
}
