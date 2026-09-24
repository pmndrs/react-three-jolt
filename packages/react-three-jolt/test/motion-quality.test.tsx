// Issue #248: `motionQuality` - `mMotionQuality` / `BodyInterface.SetMotionQuality` - on
// `BodyState` and `<RigidBody>`.
//
// Three things are covered here, all against the real WASM module (no mocks):
// - `BodyState.motionQuality` get/set: default is 'discrete', a static body has no
//   MotionProperties so its setter is a no-op rather than throwing, and the getter round-trips
//   whatever the setter last wrote.
// - the physical claim the issue asks for: a small, fast dynamic sphere set to 'discrete' tunnels
//   straight through a thin static wall in one physics step, while the same sphere set to
//   'linearCast' is stopped by it instead.
// - `<RigidBody motionQuality>` reaches the body and stays reactive, mirroring
//   body-material-props.test.tsx's coverage of `gravityFactor` and friends.

import { create } from '@react-three/test-renderer';
import React from 'react';
import { preload } from 'suspend-react';
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Physics, RigidBody } from '../src';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

// see body-material-props.test.tsx: <Physics> suspends on the (async) wasm load, so pre-resolve
// it and let create() mount synchronously inside act() for the <RigidBody> test below.
beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('motion-quality-test');
    preload(() => initJolt(), ['jolt']);
    await new Promise((resolve) => setTimeout(resolve, 0));
});

function addSphere(radius: number, at: THREE.Vector3, bodyType?: 'static') {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius));
    mesh.position.copy(at);
    return ps.bodySystem.getBody(
        ps.bodySystem.addBody(mesh, bodyType ? { bodyType } : undefined)
    ) as BodyState;
}

function addWall(size: [number, number, number], at: THREE.Vector3) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, { bodyType: 'static' })) as BodyState;
}

test('BodyState.motionQuality defaults to discrete and round-trips linearCast', () => {
    const sphere = addSphere(0.3, new THREE.Vector3(0, -200, 0));
    assert.equal(sphere.motionQuality, 'discrete', "Jolt's own default is discrete");

    sphere.motionQuality = 'linearCast';
    assert.equal(sphere.motionQuality, 'linearCast', 'setter did not stick');

    sphere.motionQuality = 'discrete';
    assert.equal(sphere.motionQuality, 'discrete', 'setter did not switch back');

    sphere.destroy();
});

test('BodyState.motionQuality is a no-op on a static body, not a throw', () => {
    const wall = addWall([1, 1, 1], new THREE.Vector3(0, -200, 0));
    assert.equal(wall.motionQuality, 'discrete');
    assert.doesNotThrow(() => {
        wall.motionQuality = 'linearCast';
    });
    // a static body has no MotionProperties at all, so nothing actually changed
    assert.equal(wall.motionQuality, 'discrete');
    wall.destroy();
});

test('a fast small sphere tunnels through a thin wall on discrete, but not on linearCast', () => {
    const wallThickness = 0.05;
    const sphereRadius = 0.15;
    // fast enough to cross the whole wall thickness (and then some) within a single 1/60s step -
    // 200 * (1/60) ≈ 3.33 units per step
    const speed = 200;

    // -- discrete: expected to tunnel straight through ------------------------------------
    // well inside the ~3.33 units the sphere covers in one step, so it reaches (and overshoots)
    // the wall within that single step rather than just approaching it
    const wallX = 2;
    const wall = addWall([wallThickness, 4, 4], new THREE.Vector3(wallX, 0, 0));
    const discreteSphere = addSphere(sphereRadius, new THREE.Vector3(0, 0, 0));
    discreteSphere.gravityFactor = 0; // isolate the tunneling behavior from falling
    discreteSphere.motionQuality = 'discrete';
    discreteSphere.velocity = new THREE.Vector3(speed, 0, 0);

    ps.onUpdate(STEP);

    assert.isAbove(
        discreteSphere.position.x,
        wallX + wallThickness,
        'discrete quality should have tunneled straight through the thin wall'
    );

    discreteSphere.destroy();
    wall.destroy();

    // -- linearCast: expected to be caught by the wall -------------------------------------
    const wallZ = 2;
    const wall2 = addWall([4, 4, wallThickness], new THREE.Vector3(0, 0, wallZ));
    const sweptSphere = addSphere(sphereRadius, new THREE.Vector3(0, 0, 0));
    sweptSphere.gravityFactor = 0;
    sweptSphere.motionQuality = 'linearCast';
    sweptSphere.velocity = new THREE.Vector3(0, 0, speed);

    ps.onUpdate(STEP);

    assert.isBelow(
        sweptSphere.position.z,
        wallZ,
        'linearCast quality should have stopped the sphere at the wall instead of letting it ' +
            'pass through'
    );

    sweptSphere.destroy();
    wall2.destroy();
});

test('<RigidBody motionQuality> reaches the body and stays reactive', async () => {
    const body = React.createRef<BodyState>();
    const tree = (motionQuality?: 'discrete' | 'linearCast') => (
        <Physics>
            <RigidBody ref={body} position={[0, 5, 0]} motionQuality={motionQuality}>
                <mesh>
                    <sphereGeometry args={[0.3]} />
                </mesh>
            </RigidBody>
        </Physics>
    );

    const renderer = await create(tree('linearCast'));
    assert.isNotNull(body.current, '<RigidBody> never produced a body');
    assert.equal(body.current!.motionQuality, 'linearCast', 'the prop was dropped');

    await renderer.update(tree('discrete'));
    assert.equal(body.current!.motionQuality, 'discrete', 'motionQuality did not stay reactive');

    await renderer.unmount();
});
