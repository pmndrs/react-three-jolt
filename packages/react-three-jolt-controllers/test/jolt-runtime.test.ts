// Runtime coverage for the Jolt APIs the controllers drive directly: CharacterVirtual with a
// CharacterContactListenerJS (jolt-physics 0.32 grew that interface) and VehicleConstraint with
// VehicleConstraintCallbacksJS (0.26 changed those callback arguments). Neither break is visible
// to the type checker - embind only throws when Jolt actually calls into JavaScript.
import { assert, beforeAll, test } from 'vitest';
import * as THREE from 'three';
import { PhysicsSystem, initJolt } from '@react-three/jolt';
import { CharacterControllerSystem } from '../src/systems/character-controller';
import { VehicleSystem } from '../src/systems/vehicles';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('test');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

test('character controller steps against the world', () => {
    const cc = new CharacterControllerSystem(ps);
    cc.position = new THREE.Vector3(0, 3, 0);
    assert.closeTo(cc.position.y, 3, 1e-3);

    cc.move(new THREE.Vector3(1, 0, 0));
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    assert.isFinite(cc.position.x);
    assert.isBelow(cc.position.y, 3, 'character did not fall onto the floor');
});

test('four wheel vehicle steps against the world', () => {
    const vehicle = new VehicleSystem(ps).addVehicle('car');
    vehicle.move(new THREE.Vector2(0, 1));
    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);
    assert.isFinite(vehicle.position.x);
    assert.isFinite(vehicle.position.y);
});
