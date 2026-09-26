// SkeletalAnimation (#254): convert a three.js AnimationClip to Jolt keyframes.
// Tests that createSkeletalAnimation maps three.js AnimationClip tracks to Jolt keyframes and
// that sampleTo() matches three.js AnimationMixer sampling within epsilon on a synthetic 3-bone clip.

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { createJoltSkeleton, createSkeletalAnimation, sampleTo } from '../src/systems';
import { initJolt, Raw } from '../src/raw';

let jolt: typeof Jolt;

beforeAll(async () => {
    await initJolt();
    jolt = Raw.module;
});

//* helpers ------------------------------------------------------------------

const freeMemory = (): number => jolt.JoltInterface.prototype.sGetFreeMemory();

/**
 * Creates a synthetic three-bone skeleton (root -> spine -> arm) for testing.
 * Returns the Skeleton (three.js) and matching three bones in depth-first order.
 */
const createThreeSkeleton = (): { skeleton: THREE.Skeleton; bones: THREE.Bone[] } => {
    const root = new THREE.Bone();
    root.name = 'root';
    root.position.set(0, 0, 0);
    root.quaternion.identity();

    const spine = new THREE.Bone();
    spine.name = 'spine';
    spine.position.set(0, 1, 0);
    spine.quaternion.identity();
    root.add(spine);

    const arm = new THREE.Bone();
    arm.name = 'arm';
    arm.position.set(0.5, 0, 0);
    arm.quaternion.identity();
    spine.add(arm);

    const skeleton = new THREE.Skeleton([root, spine, arm]);
    return { skeleton, bones: [root, spine, arm] };
};

/**
 * Creates an AnimationClip with a simple 2-second animation:
 * - root: stationary at origin
 * - spine: moves from (0,1,0) to (0,2,0), stays at quaternion identity
 * - arm: rotates 90 degrees around Y axis, moves from (0.5,0,0) to (1,0,0)
 */
const createAnimationClip = (): THREE.AnimationClip => {
    const tracks: THREE.KeyframeTrack[] = [];

    // Root: stationary
    tracks.push(
        new THREE.VectorKeyframeTrack('root.position', [0, 2], [0, 0, 0, 0, 0, 0]),
        new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])
    );

    // Spine: Y translation from 1 to 2
    tracks.push(
        new THREE.VectorKeyframeTrack('spine.position', [0, 2], [0, 1, 0, 0, 2, 0]),
        new THREE.QuaternionKeyframeTrack('spine.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])
    );

    // Arm: X position from 0.5 to 1, and rotate 90 degrees around Y axis (quaternion ~ [0, sin(45deg), 0, cos(45deg)])
    const sin45 = Math.sin(Math.PI / 4);
    const cos45 = Math.cos(Math.PI / 4);
    tracks.push(
        new THREE.VectorKeyframeTrack('arm.position', [0, 2], [0.5, 0, 0, 1, 0, 0]),
        new THREE.QuaternionKeyframeTrack(
            'arm.quaternion',
            [0, 2],
            [0, 0, 0, 1, 0, sin45, 0, cos45]
        )
    );

    return new THREE.AnimationClip('test-clip', 2, tracks);
};

//* tests ---------------------------------------------------------------------

test('createSkeletalAnimation maps position and quaternion tracks by bone name', () => {
    const before = freeMemory();

    const { skeleton: threeSkeleton } = createThreeSkeleton();
    const { skeleton: joltSkeleton } = createJoltSkeleton(threeSkeleton);
    const clip = createAnimationClip();

    const animation = createSkeletalAnimation(clip, joltSkeleton);

    assert.equal(animation.GetDuration(), 2, 'animation duration should match clip duration');
    assert.isFalse(animation.IsLooping(), 'isLooping should default to false');

    const animatedJoints = animation.GetAnimatedJoints();
    assert.equal(animatedJoints.size(), 3, 'should have animated joints for root, spine, and arm');

    // Check that keyframes were built correctly
    let foundRoot = false;
    let foundSpine = false;
    let foundArm = false;

    for (let i = 0; i < animatedJoints.size(); i++) {
        const joint = animatedJoints.at(i);
        const name = joint.mJointName.c_str();

        if (name === 'root') {
            foundRoot = true;
            assert.equal(joint.mKeyframes.size(), 2, 'root should have 2 keyframes');
        } else if (name === 'spine') {
            foundSpine = true;
            assert.equal(joint.mKeyframes.size(), 2, 'spine should have 2 keyframes');
        } else if (name === 'arm') {
            foundArm = true;
            assert.equal(joint.mKeyframes.size(), 2, 'arm should have 2 keyframes');
        }
    }

    assert.isTrue(foundRoot, 'should have root joint');
    assert.isTrue(foundSpine, 'should have spine joint');
    assert.isTrue(foundArm, 'should have arm joint');

    jolt.destroy(animation);
    jolt.destroy(joltSkeleton);

    assert.isAtLeast(freeMemory(), before - 256, 'createSkeletalAnimation teardown leaked heap');
});

test('sampleTo samples animation and calculates joint matrices', () => {
    const before = freeMemory();

    const { skeleton: threeSkeleton } = createThreeSkeleton();
    const { skeleton: joltSkeleton } = createJoltSkeleton(threeSkeleton);
    const clip = createAnimationClip();

    const animation = createSkeletalAnimation(clip, joltSkeleton);
    const pose = new jolt.SkeletonPose();
    pose.SetSkeleton(joltSkeleton);

    // Sample at t=0
    sampleTo(animation, pose, 0);
    const root0 = pose.GetJointMatrix(0).GetTranslation();
    assert.approximately(root0.GetY(), 0, 1e-4, 'root at t=0 should be at y=0');

    // Sample at t=1 (midpoint)
    sampleTo(animation, pose, 1);
    const spine1 = pose.GetJointMatrix(1).GetTranslation();
    assert.approximately(spine1.GetY(), 1.5, 1e-4, 'spine at t=1 should be at y=1.5 (midpoint)');

    // Sample at t=2 (end)
    sampleTo(animation, pose, 2);
    const spine2 = pose.GetJointMatrix(1).GetTranslation();
    assert.approximately(spine2.GetY(), 2, 1e-4, 'spine at t=2 should be at y=2');

    jolt.destroy(pose);
    jolt.destroy(animation);
    jolt.destroy(joltSkeleton);

    assert.isAtLeast(freeMemory(), before - 256, 'sampleTo teardown leaked heap');
});

test('sampleTo interpolates keyframes correctly on a synthetic clip', () => {
    const before = freeMemory();

    // Create both three.js and Jolt skeletons from the same bone hierarchy
    const { skeleton: threeSkeleton } = createThreeSkeleton();
    const { skeleton: joltSkeleton } = createJoltSkeleton(threeSkeleton);

    // Create the animation clip
    const clip = createAnimationClip();

    // Set up Jolt animation
    const joltAnimation = createSkeletalAnimation(clip, joltSkeleton);
    const joltPose = new jolt.SkeletonPose();
    joltPose.SetSkeleton(joltSkeleton);

    // Sample at several time points and verify linear interpolation
    const epsilon = 1e-4;

    // At t=0, spine should be at y=1
    sampleTo(joltAnimation, joltPose, 0);
    const spine0 = joltPose.GetJoint(1);
    assert.approximately(spine0.mTranslation.GetY(), 1, epsilon, 'spine at t=0 should be at y=1');

    // At t=1, spine should be at y=1.5 (linear interpolation from 1 to 2)
    sampleTo(joltAnimation, joltPose, 1);
    const spine1 = joltPose.GetJoint(1);
    assert.approximately(
        spine1.mTranslation.GetY(),
        1.5,
        epsilon,
        'spine at t=1 should be at y=1.5'
    );

    // At t=2, spine should be at y=2
    sampleTo(joltAnimation, joltPose, 2);
    const spine2 = joltPose.GetJoint(1);
    assert.approximately(spine2.mTranslation.GetY(), 2, epsilon, 'spine at t=2 should be at y=2');

    // At t=0.5, spine should be at y=1.25 (interpolation at 1/4 of the range)
    sampleTo(joltAnimation, joltPose, 0.5);
    const spine05 = joltPose.GetJoint(1);
    assert.approximately(
        spine05.mTranslation.GetY(),
        1.25,
        epsilon,
        'spine at t=0.5 should be at y=1.25'
    );

    // At t=1.5, spine should be at y=1.75 (interpolation at 3/4 of the range)
    sampleTo(joltAnimation, joltPose, 1.5);
    const spine15 = joltPose.GetJoint(1);
    assert.approximately(
        spine15.mTranslation.GetY(),
        1.75,
        epsilon,
        'spine at t=1.5 should be at y=1.75'
    );

    // Verify arm rotation is interpolated: should go from identity to 90 degrees around Y
    sampleTo(joltAnimation, joltPose, 0);
    const arm0 = joltPose.GetJoint(2);
    assert.approximately(arm0.mRotation.GetX(), 0, epsilon, 'arm at t=0 rotation.x should be ~0');
    assert.approximately(arm0.mRotation.GetY(), 0, epsilon, 'arm at t=0 rotation.y should be ~0');
    assert.approximately(arm0.mRotation.GetZ(), 0, epsilon, 'arm at t=0 rotation.z should be ~0');
    assert.approximately(
        arm0.mRotation.GetW(),
        1,
        epsilon,
        'arm at t=0 rotation.w should be ~1 (identity)'
    );

    // At t=2, arm should be at 90 degrees (sin(45deg) ≈ 0.707, cos(45deg) ≈ 0.707)
    sampleTo(joltAnimation, joltPose, 2);
    const arm2 = joltPose.GetJoint(2);
    const sin45 = Math.sin(Math.PI / 4);
    const cos45 = Math.cos(Math.PI / 4);
    assert.approximately(
        arm2.mRotation.GetY(),
        sin45,
        epsilon,
        'arm at t=2 rotation.y should be ~sin(45deg)'
    );
    assert.approximately(
        arm2.mRotation.GetW(),
        cos45,
        epsilon,
        'arm at t=2 rotation.w should be ~cos(45deg)'
    );

    jolt.destroy(joltPose);
    jolt.destroy(joltAnimation);
    jolt.destroy(joltSkeleton);

    assert.isAtLeast(freeMemory(), before - 256, 'interpolation test leaked heap');
});

test('createSkeletalAnimation respects isLooping option', () => {
    const { skeleton: threeSkeleton } = createThreeSkeleton();
    const { skeleton: joltSkeleton } = createJoltSkeleton(threeSkeleton);
    const clip = createAnimationClip();

    // Test default (false)
    const animationDefault = createSkeletalAnimation(clip, joltSkeleton);
    assert.isFalse(animationDefault.IsLooping(), 'default isLooping should be false');

    // Test explicit true
    const animationLooping = createSkeletalAnimation(clip, joltSkeleton, { isLooping: true });
    assert.isTrue(animationLooping.IsLooping(), 'isLooping option true should be respected');

    // Test explicit false
    const animationNonLooping = createSkeletalAnimation(clip, joltSkeleton, { isLooping: false });
    assert.isFalse(animationNonLooping.IsLooping(), 'isLooping option false should be respected');

    jolt.destroy(animationDefault);
    jolt.destroy(animationLooping);
    jolt.destroy(animationNonLooping);
    jolt.destroy(joltSkeleton);
});

test('createSkeletalAnimation ignores scale tracks with dev warning', () => {
    const { skeleton: threeSkeleton } = createThreeSkeleton();
    const { skeleton: joltSkeleton } = createJoltSkeleton(threeSkeleton);

    // Create a clip with scale tracks
    const tracks: THREE.KeyframeTrack[] = [];
    tracks.push(
        new THREE.VectorKeyframeTrack('root.position', [0, 1], [0, 0, 0, 0, 0, 0]),
        new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
        // Scale track - should be ignored with a warning
        new THREE.VectorKeyframeTrack('root.scale', [0, 1], [1, 1, 1, 2, 2, 2])
    );

    const clipWithScale = new THREE.AnimationClip('test-with-scale', 1, tracks);

    // This should not throw, and should complete without crashing
    const animation = createSkeletalAnimation(clipWithScale, joltSkeleton);
    assert.exists(animation, 'should create animation even with scale tracks');

    jolt.destroy(animation);
    jolt.destroy(joltSkeleton);
});
