// Regression for the Character demo "everything collapses to the centre" report after #300.
//
// BodyState captured `invertedWorldMatrix` from the object's OWN `matrixWorld` instead of its
// parent's. That only worked while `matrixWorld` was still identity at body creation. #300
// applies the spawn transform in a layout effect, so in a browser a frame renders (and updates
// `matrixWorld` to include the spawn position) before the passive effect creates the body -
// after which every synced pose had its own spawn offset subtracted, pulling objects to the
// origin. These tests create the body AFTER updating world matrices, the browser's ordering.
import * as THREE from 'three';
import { assert, beforeAll, onTestFinished, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';

beforeAll(async () => {
    await initJolt();
});

function world() {
    const system = new PhysicsSystem('sync-parent-space');
    onTestFinished(() => system.destroy());
    return system;
}

function box(x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(x, y, z);
    return mesh;
}

test('a body created after its object3D matrixWorld already holds the spawn pose stays in place', () => {
    const system = world();
    const scene = new THREE.Scene();
    const mesh = box(3, 5, -15);
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    system.bodySystem.addBody(mesh);
    for (let i = 0; i < 5; i++) system.onUpdate(1 / 60);

    assert.approximately(mesh.position.x, 3, 1e-3, `x drifted to ${mesh.position.x}`);
    assert.approximately(mesh.position.z, -15, 1e-3, `z drifted to ${mesh.position.z}`);
    assert.isAbove(mesh.position.y, 4, `y collapsed to ${mesh.position.y}`);
});

test('a body under a translated parent renders where its Jolt body is (parent-space sync)', () => {
    // Known quirk (see matrix-auto-update.test.ts): the Jolt body is created at `object.position`
    // read as a world position, ignoring the parent. The sync must then render the object at
    // that body's world pose, which the old own-matrixWorld inverse did not (it collapsed it).
    const system = world();
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.position.set(10, 0, 0);
    scene.add(group);
    const mesh = box(0, 5, -15);
    group.add(mesh);
    scene.updateMatrixWorld(true);

    system.bodySystem.addBody(mesh);
    for (let i = 0; i < 5; i++) system.onUpdate(1 / 60);

    scene.updateMatrixWorld(true);
    const worldPos = mesh.getWorldPosition(new THREE.Vector3());
    assert.approximately(worldPos.x, 0, 1e-3, `world x is ${worldPos.x}, expected the body's 0`);
    assert.approximately(
        worldPos.z,
        -15,
        1e-3,
        `world z is ${worldPos.z}, expected the body's -15`
    );
});
