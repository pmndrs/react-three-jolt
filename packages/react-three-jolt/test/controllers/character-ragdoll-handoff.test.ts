// Character -> ragdoll handoff (issue #255): `CharacterControllerSystem.toRagdoll()`/
// `fromRagdoll()`, built on `RagdollSystem`/`SkeletonSystem` (#250/#251) exactly the way
// `<Ragdoll>` is, but driven imperatively off a `SkinnedMesh` rendered inside the character
// instead of its own top-level component.
//
// Real jolt-physics 1.1 WASM, no mocks - same synthetic rig (`root -> spine -> {armL, armR}`,
// no assets/loaders) `ragdoll-system.test.ts`/`skeleton-system.test.ts` use, duplicated here per
// this package's convention (each ragdoll test file keeps its own copy rather than sharing one -
// see ragdoll-system.test.ts's own module doc).

import * as THREE from 'three';
import { assert, test } from 'vitest';
import { CharacterControllerSystem } from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem, Raw } from '../../src/index';
import { installAllocTracker } from '../jolt-alloc';

/** Constructs an RVec3/Quat pair without pulling in `jolt-physics`' types just for two locals. */
const newRootTransformOut = () => ({
    position: new Raw.module.RVec3(),
    rotation: new Raw.module.Quat()
});

//* helpers -------------------------------------------------------------------------------------

const freeMemory = (): number => Raw.module.JoltInterface.prototype.sGetFreeMemory();

/** A 4 joint chain: root -> spine -> {armL, armR}, matching ragdoll-system.test.ts's rig shape. */
const buildBoneChain = (originY = 10): THREE.Bone[] => {
    const root = new THREE.Bone();
    root.name = 'root';
    root.position.set(0, originY, 0);

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

/** A synthetic SkinnedMesh (no assets, no loader) wrapping a bone chain. */
const buildSkinnedMesh = (bones: THREE.Bone[]): THREE.SkinnedMesh => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(bones[0]);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    return mesh;
};

/**
 * A fresh, warmed-up `PhysicsSystem` with a character + a synthetic skinned rig attached to it -
 * mirrors ragdoll-system.test.ts's `newWarmedWorld` (absorbs the one-time free-list settling cost
 * a world's first Skeleton/RagdollPart/body/constraint pays) plus a floor far enough below that a
 * short test never reaches it.
 */
async function newRiggedCharacter(
    label: string,
    originY = 10
): Promise<{ ps: PhysicsSystem; cc: CharacterControllerSystem; bones: THREE.Bone[] }> {
    await initJolt();
    const ps = new PhysicsSystem(label);
    const jolt = Raw.module;

    // warm-up cycle (same shape as ragdoll-system.test.ts's newWarmedWorld)
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
    part.mObjectLayer = 2; // Layer.RIG - avoid an import just for the warmup cycle
    settings.DisableParentChildCollisions();
    settings.CalculateBodyIndexToConstraintIndex();
    settings.CalculateConstraintIndexToBodyIdxPair();
    const warmupRagdoll = settings.CreateRagdoll(0, 0, ps.joltPhysicsSystem);
    warmupRagdoll.AddToPhysicsSystem(jolt.EActivation_Activate);
    ps.onUpdate(1 / 60);
    warmupRagdoll.RemoveFromPhysicsSystem();
    jolt.destroy(warmupRagdoll);
    jolt.destroy(settings);

    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -200, 0); // far below - nothing reaches it in these short tests
    ps.bodySystem.addBody(floor, { bodyType: 'static' });

    const cc = new CharacterControllerSystem(ps);
    const bones = buildBoneChain(originY);
    const mesh = buildSkinnedMesh(bones);
    cc.add(mesh);

    return { ps, cc, bones };
}

//* tests ---------------------------------------------------------------------------------------

test('prepareRagdoll builds a template from the SkinnedMesh rendered inside the character', async () => {
    const { ps, cc } = await newRiggedCharacter('character-ragdoll-prepare');
    const template = cc.prepareRagdoll();
    assert.isDefined(template);
    assert.equal(template!.joints.length, 4);
    assert.deepEqual(template!.parentIndex, [-1, 0, 1, 1]);
    // cached - a second call returns the exact same object, not a rebuild
    assert.strictEqual(cc.prepareRagdoll(), template);

    cc.destroy();
    ps.destroy();
});

test("toRagdoll spawns at the bones' CURRENT pose (not the template's build-time pose) and hands off the character's velocity", async () => {
    const { ps, cc, bones } = await newRiggedCharacter('character-ragdoll-position-velocity', 10);

    // Prebuild the template at this pose (issue #255's "prebuilt template").
    const template = cc.prepareRagdoll();
    assert.isDefined(template);

    // Move the rig away from the template's build-time pose - simulates the character having
    // walked/animated since the template was built. toRagdoll() must spawn at THIS pose, not
    // originY=10, which is the one thing a raw RagdollSystem.spawn() alone would give it.
    bones[0].position.set(5, 25, -3);
    bones[0].updateWorldMatrix(true, true);
    const expectedRootWorld = bones[0].getWorldPosition(new THREE.Vector3());

    cc.linearVelocity = new THREE.Vector3(3, 0, -1);
    const instance = cc.toRagdoll();
    assert.isDefined(instance);
    assert.equal(instance!.ragdoll.GetBodyCount(), 4);
    assert.equal(instance!.bodyStates.length, 4);

    // Position: the root part lands at the bone's CURRENT world position.
    const rootBodyPosition = instance!.bodyStates[0].position;
    assert.approximately(rootBodyPosition.x, expectedRootWorld.x, 0.1, 'root x');
    assert.approximately(rootBodyPosition.y, expectedRootWorld.y, 0.1, 'root y');
    assert.approximately(rootBodyPosition.z, expectedRootWorld.z, 0.1, 'root z');

    // Velocity: every part starts with the character's linear velocity, not zero.
    for (const state of instance!.bodyStates) {
        assert.approximately(state.velocity.x, 3, 1e-2, 'part vx');
        assert.approximately(state.velocity.y, 0, 1e-2, 'part vy');
        assert.approximately(state.velocity.z, -1, 1e-2, 'part vz');
    }

    // The character stopped stepping/rendering; the ragdoll is live.
    assert.isFalse(cc.threeObject.visible);
    assert.isTrue(cc.isRagdoll);
    assert.strictEqual(cc.ragdollInstance, instance);

    cc.fromRagdoll();
    cc.destroy();
    ps.destroy();
});

test('toRagdoll is idempotent; fromRagdoll no-ops when not a ragdoll', async () => {
    const { ps, cc } = await newRiggedCharacter('character-ragdoll-idempotent');

    // fromRagdoll() before any toRagdoll() call - no-op, does not throw.
    assert.doesNotThrow(() => cc.fromRagdoll());
    assert.isFalse(cc.isRagdoll);

    const instance = cc.toRagdoll();
    assert.isDefined(instance);
    const again = cc.toRagdoll();
    assert.strictEqual(
        again,
        instance,
        'a second toRagdoll() call should return the same instance'
    );

    cc.fromRagdoll();
    assert.isFalse(cc.isRagdoll);
    assert.isUndefined(cc.ragdollInstance);
    // a second fromRagdoll() is a no-op too
    assert.doesNotThrow(() => cc.fromRagdoll());

    cc.destroy();
    ps.destroy();
});

test("fromRagdoll stands the character back up at the ragdoll's root/pelvis position and reattaches it to the step loop", async () => {
    const { ps, cc } = await newRiggedCharacter('character-ragdoll-from', 8);

    const instance = cc.toRagdoll();
    assert.isDefined(instance);

    // let it fall for a bit so the root/pelvis position on return is not just the spawn pose
    for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);

    const { position: outPosition, rotation: outRotation } = newRootTransformOut();
    instance!.ragdoll.GetRootTransform(outPosition, outRotation, true);
    const expectedX = outPosition.GetX();
    const expectedY = outPosition.GetY();
    const expectedZ = outPosition.GetZ();
    Raw.module.destroy(outPosition);
    Raw.module.destroy(outRotation);

    cc.fromRagdoll();

    assert.isFalse(cc.isRagdoll);
    assert.isTrue(cc.threeObject.visible);
    assert.approximately(cc.position.x, expectedX, 0.05, 'character x after fromRagdoll');
    assert.approximately(cc.position.y, expectedY, 0.05, 'character y after fromRagdoll');
    assert.approximately(cc.position.z, expectedZ, 0.05, 'character z after fromRagdoll');

    // the character is back on the step loop - moving it should still work.
    cc.move(new THREE.Vector3(1, 0, 0));
    assert.doesNotThrow(() => ps.onUpdate(1 / 60));

    cc.destroy();
    ps.destroy();
});

test('round trip (toRagdoll -> fromRagdoll, 5 times) leaves the wasm heap at the prepared-template baseline', async () => {
    const { ps, cc } = await newRiggedCharacter('character-ragdoll-round-trip', 6);

    // Build the template once, up front - it is meant to be reused across handoffs, so its cost
    // is not part of what a round trip should give back (matches ragdoll-system.test.ts's own
    // "spawn -> destroy -> spawn again... 5 times" baseline convention).
    const template = cc.prepareRagdoll();
    assert.isDefined(template);
    const before = freeMemory();

    for (let cycle = 1; cycle <= 5; cycle++) {
        cc.linearVelocity = new THREE.Vector3(cycle * 0.1, 0, 0);
        const instance = cc.toRagdoll();
        assert.equal(
            instance!.ragdoll.GetBodyCount(),
            4,
            `cycle ${cycle}: toRagdoll produced an empty ragdoll`
        );
        for (let i = 0; i < 5; i++) ps.onUpdate(1 / 60);
        cc.fromRagdoll();
        assert.isFalse(cc.isRagdoll, `cycle ${cycle}: still a ragdoll after fromRagdoll()`);
        assert.doesNotThrow(
            () => ps.onUpdate(1 / 60),
            `cycle ${cycle}: the world corrupted after fromRagdoll()`
        );
    }

    assert.isAtLeast(
        freeMemory(),
        before - 128,
        '5 toRagdoll/fromRagdoll cycles did not return the wasm heap to the template baseline'
    );

    cc.destroy();
    ps.destroy();
});

test('destroy() while mid-ragdoll tears down the live instance and the cached template without a double free', async () => {
    const { ps, cc } = await newRiggedCharacter('character-ragdoll-destroy-mid-ragdoll');
    const spy = installAllocTracker(Raw, { throwOnDoubleDestroy: true });

    const instance = cc.toRagdoll();
    assert.isDefined(instance);
    assert.doesNotThrow(() => cc.destroy());

    spy.uninstall();
    assert.doesNotThrow(() => ps.onUpdate(1 / 60), 'the world corrupted after destroy()');
    ps.destroy();
});
