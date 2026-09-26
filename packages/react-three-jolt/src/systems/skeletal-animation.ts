// SkeletalAnimation (#254): convert a three.js AnimationClip to Jolt keyframes.
// Builds a Jolt.SkeletalAnimation from a three.js AnimationClip by mapping position/quaternion
// tracks per joint by bone name (scale tracks are ignored with a dev warning).

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import { devWarn } from '../utils';

export interface CreateSkeletalAnimationOptions {
    /**
     * Whether the animation should loop. Defaults to false (clamp at end), which is almost always
     * what driving a ragdoll to a single animation frame wants. Jolt's `IsLooping()` defaults to
     * true in the WASM module, so we override it here to false unless the caller asks otherwise.
     */
    isLooping?: boolean;
}

/**
 * Converts a three.js `AnimationClip` into a `Jolt.SkeletalAnimation` that can be sampled to
 * drive a ragdoll, useful for headless/server stepping and for driving a ragdoll from a clip at
 * a fixed rate without a three.js `AnimationMixer`.
 *
 * - Mapping: position and quaternion tracks are mapped per joint by bone name (case-sensitive).
 *   Scale tracks are ignored with a dev warning.
 * - Looping: defaults to false (clamp at end, not wrap), which is almost always what driving a
 *   ragdoll to a single animation frame wants. See `options.isLooping` to override.
 * - Ownership: the returned `SkeletalAnimation` is a real WASM allocation the caller owns and
 *   must `destroy()` when done.
 *
 * Use `sampleTo()` to sample the animation into a pose, which handles the required
 * `CalculateJointMatrices()` call after `Sample()`.
 */
export function createSkeletalAnimation(
    clip: THREE.AnimationClip,
    joltSkeleton: Jolt.Skeleton,
    options?: CreateSkeletalAnimationOptions
): Jolt.SkeletalAnimation {
    const jolt = Raw.module;
    const animation = new jolt.SkeletalAnimation();
    const joints = animation.GetAnimatedJoints();

    // Build a map of joint name -> joint index from the Jolt skeleton. We iterate over the
    // clip's tracks and match by name; Jolt doesn't expose a name getter, so we need to track
    // which joint each name corresponds to.

    // Extract unique bone names from the clip's tracks (removing the ".position", ".quaternion",
    // ".scale" suffixes that three.js attaches).
    const boneNames = new Set<string>();
    clip.tracks.forEach((track) => {
        const match = track.name.match(/^(.+)\.(position|quaternion|scale)$/);
        if (match) {
            boneNames.add(match[1]);
        }
    });

    // Allocate the animated joints array
    joints.resize(boneNames.size);

    let animatedJointIndex = 0;
    for (const boneName of boneNames) {
        const animatedJoint = joints.at(animatedJointIndex);

        // Set the joint name (copied on assignment, see docs/ragdolls.md)
        const jointName = new jolt.JPHString(boneName, boneName.length);
        animatedJoint.mJointName = jointName;
        jolt.destroy(jointName);

        // Collect keyframes for this joint from position and quaternion tracks
        const keyframeMap = new Map<
            number,
            { time: number; position?: THREE.Vector3; quaternion?: THREE.Quaternion }
        >();

        // Process position track
        const positionTrack = clip.tracks.find((t) => t.name === `${boneName}.position`);
        if (positionTrack && positionTrack instanceof THREE.VectorKeyframeTrack) {
            const times = positionTrack.times;
            const values = positionTrack.values;
            for (let i = 0; i < times.length; i++) {
                const time = times[i];
                if (!keyframeMap.has(time)) {
                    keyframeMap.set(time, { time });
                }
                const entry = keyframeMap.get(time)!;
                entry.position = new THREE.Vector3(
                    values[i * 3],
                    values[i * 3 + 1],
                    values[i * 3 + 2]
                );
            }
        }

        // Process quaternion track
        const quaternionTrack = clip.tracks.find((t) => t.name === `${boneName}.quaternion`);
        if (quaternionTrack && quaternionTrack instanceof THREE.QuaternionKeyframeTrack) {
            const times = quaternionTrack.times;
            const values = quaternionTrack.values;
            for (let i = 0; i < times.length; i++) {
                const time = times[i];
                if (!keyframeMap.has(time)) {
                    keyframeMap.set(time, { time });
                }
                const entry = keyframeMap.get(time)!;
                entry.quaternion = new THREE.Quaternion(
                    values[i * 4],
                    values[i * 4 + 1],
                    values[i * 4 + 2],
                    values[i * 4 + 3]
                );
            }
        }

        // Warn if there's a scale track we're ignoring
        const scaleTrack = clip.tracks.find((t) => t.name === `${boneName}.scale`);
        if (scaleTrack) {
            devWarn(
                `createSkeletalAnimation: scale track for joint '${boneName}' will be ignored - ` +
                    `SkeletalAnimationJointState has no scale field`
            );
        }

        // Populate keyframes in sorted time order
        const sortedTimes = Array.from(keyframeMap.keys()).sort((a, b) => a - b);
        animatedJoint.mKeyframes.resize(sortedTimes.length);

        sortedTimes.forEach((time, keyframeIndex) => {
            const entry = keyframeMap.get(time)!;
            const keyframe = animatedJoint.mKeyframes.at(keyframeIndex);

            keyframe.mTime = time;

            // Position: default to identity (0, 0, 0) if not present
            if (entry.position) {
                keyframe.mTranslation.Set(entry.position.x, entry.position.y, entry.position.z);
            } else {
                keyframe.mTranslation.Set(0, 0, 0);
            }

            // Rotation: default to identity (0, 0, 0, 1) if not present
            if (entry.quaternion) {
                keyframe.mRotation.Set(
                    entry.quaternion.x,
                    entry.quaternion.y,
                    entry.quaternion.z,
                    entry.quaternion.w
                );
            } else {
                keyframe.mRotation.Set(0, 0, 0, 1);
            }
        });

        animatedJointIndex++;
    }

    // Set looping behavior (defaults to false, matching the ragdoll use case)
    animation.SetIsLooping(options?.isLooping ?? false);

    return animation;
}

/**
 * Samples a `SkeletalAnimation` at a given time into a `SkeletonPose`, handling the required
 * `CalculateJointMatrices()` call after `Sample()`.
 *
 * See docs/ragdolls.md "GetPose() vs CalculateJointMatrices()" for why this is necessary: the
 * pose has two internal representations (per-joint STATES and joint MATRICES) that are populated
 * by mutually exclusive code paths. `SkeletalAnimation.Sample()` writes only the STATES;
 * `CalculateJointMatrices()` derives the MATRICES from those STATES and must be called before the
 * pose is used for `Ragdoll.SetPose`/`DriveToPoseUsingMotors`/`DriveToPoseUsingKinematics`.
 *
 * This helper combines both calls so the returned pose is immediately usable.
 */
export function sampleTo(
    animation: Jolt.SkeletalAnimation,
    pose: Jolt.SkeletonPose,
    time: number
): void {
    animation.Sample(time, pose);
    pose.CalculateJointMatrices();
}
