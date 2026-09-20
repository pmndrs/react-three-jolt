// Runtime coverage for the jolt-physics binding. The type checker cannot see most of the Jolt
// API surface (embind hands back numbers), so these exercise the paths that actually changed
// between jolt-physics 0.22 and 1.1: RVec3 positions, RShapeCast / RMat44 queries, the split
// RayCastSettings back face mode, heightfields and constraints.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { ShapeCollider } from '../src/systems/queries/collider';
import { createMeshForShape } from '../src/systems/shape-system';

// One system for the whole file: every PhysicsSystem shares the Jolt module and its body id
// space, so a body created by one of them turns up in the contact listener of the other.
let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('test');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

test('bodies, forces and stepping', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.position.set(0, 5, 0);
    const boxState = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

    // position round trips through RVec3
    boxState.position = new THREE.Vector3(0, 4, 0);
    assert.closeTo(boxState.position.y, 4, 1e-3);

    boxState.addImpulse(new THREE.Vector3(0, 1, 0));
    boxState.applyForce(new THREE.Vector3(0, 1, 0));
    boxState.applyTorque(new THREE.Vector3(0, 1, 0));

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.isBelow(boxState.position.y, 4, 'box did not fall');

    boxState.moveKinematic(new THREE.Vector3(1, 3, 1), new THREE.Quaternion(), 1 / 60);
});

test('ray, shape and collide queries', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 20, 0);
    rc.direction = new THREE.Vector3(0, -40, 0);
    rc.cullBackFaces = true;
    rc.cast();
    assert.isAbove(rc.hits.length, 0, 'raycaster found nothing');
    assert.isFinite(rc.hits[0].position.y);

    const sc = ps.getShapecaster();
    sc.origin = new THREE.Vector3(0, 20, 0);
    sc.direction = new THREE.Vector3(0, -40, 0);
    sc.cast();
    assert.isAbove(sc.hits.length, 0, 'shapecaster found nothing');
    assert.isFinite(sc.hits[0].position.y);

    const collider = new ShapeCollider(ps.physicsSystem, ps.joltInterface);
    collider.position = new THREE.Vector3(0, 0, 0);
    collider.cast();
    assert.isAbove(collider.hits.length, 0, 'collide shape found nothing');
});

test('heightfields, trimeshes and constraints', () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(64, 64, 63, 63));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, -40, 0);
    assert.isNumber(ps.bodySystem.addHeightfield(plane));

    const trimesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 32, 8));
    trimesh.position.set(0, 20, 0);
    const tmState = ps.bodySystem.getBody(
        ps.bodySystem.addBody(trimesh, { shapeType: 'trimesh' })
    )!;
    assert.isFinite(tmState.position.y);

    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    a.position.set(10, 10, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(12, 10, 0);
    const aState = ps.bodySystem.getBody(ps.bodySystem.addBody(a))!;
    const bState = ps.bodySystem.getBody(ps.bodySystem.addBody(b))!;
    ps.constraintSystem.addConstraint('distance', aState, bState);

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    const geo = createMeshForShape(aState.body.GetShape());
    assert.isAbove(geo.attributes.position.count, 0);
});
