// Opt-in activation on BodyState setters (issue #167).
//
// `position`/`rotation`/`velocity`/`angularVelocity`/`scale`/`group`/`subGroup` used to force a
// sleeping body awake unconditionally. `activateOnChange` (default `true`, so nothing changes for
// existing callers) turns that off per body, and every setter's method form
// (`setPosition`/`setRotation`/`setVelocity`/`setAngularVelocity`/`setScale`/`setGroup`/
// `setSubGroup`) takes a `{ activate }` override that wins over the flag for one call.
//
// Runs against the real WASM module: `IsActive()` after a deliberately-deactivated body is
// written to is the only assertion that actually proves the activation mode reached Jolt.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('body-activation');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(500, 1, 500));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

// every test drops its box in a fresh column so bodies never interact across tests
let laneX = 0;

/** A dynamic box, put to sleep directly (no need to wait out the natural sleep timer). */
function sleepingBox(): BodyState {
    laneX += 5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(laneX, 0.5, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
    ps.bodyInterface.DeactivateBody(state.BodyID);
    assert.isFalse(state.body.IsActive(), 'test setup: body should start asleep');
    return state;
}

test('position: activateOnChange=false leaves a sleeping body asleep, and it stays asleep after a step', () => {
    const box = sleepingBox();
    box.activateOnChange = false;

    box.position = new THREE.Vector3(box.position.x, 2, box.position.z);
    assert.isFalse(
        box.body.IsActive(),
        'setting position while activateOnChange=false woke the body'
    );

    ps.onUpdate(STEP);
    assert.isFalse(box.body.IsActive(), 'the body woke up on its own after a step');
});

test('position: the default (activateOnChange=true) wakes a sleeping body', () => {
    const box = sleepingBox();
    // activateOnChange defaults to true - nothing set here
    box.position = new THREE.Vector3(box.position.x, 2, box.position.z);
    assert.isTrue(box.body.IsActive(), 'the default did not wake the body');
});

test('position: an explicit { activate } override wins over activateOnChange', () => {
    const asleepDespiteFlag = sleepingBox();
    asleepDespiteFlag.activateOnChange = true;
    asleepDespiteFlag.setPosition(new THREE.Vector3(asleepDespiteFlag.position.x, 2, 0), {
        activate: false
    });
    assert.isFalse(
        asleepDespiteFlag.body.IsActive(),
        '{ activate: false } did not override activateOnChange=true'
    );

    const awakeDespiteFlag = sleepingBox();
    awakeDespiteFlag.activateOnChange = false;
    awakeDespiteFlag.setPosition(new THREE.Vector3(awakeDespiteFlag.position.x, 2, 0), {
        activate: true
    });
    assert.isTrue(
        awakeDespiteFlag.body.IsActive(),
        '{ activate: true } did not override activateOnChange=false'
    );
});

test('rotation: honors activateOnChange and the explicit override', () => {
    const stillAsleep = sleepingBox();
    stillAsleep.activateOnChange = false;
    stillAsleep.rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1);
    assert.isFalse(stillAsleep.body.IsActive());

    const wokenByDefault = sleepingBox();
    wokenByDefault.rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        1
    );
    assert.isTrue(wokenByDefault.body.IsActive());

    const overridden = sleepingBox();
    overridden.activateOnChange = false;
    overridden.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1), {
        activate: true
    });
    assert.isTrue(overridden.body.IsActive(), 'explicit activate: true did not win');
});

test('velocity/angularVelocity: honors activateOnChange and the explicit override', () => {
    const stillAsleep = sleepingBox();
    stillAsleep.activateOnChange = false;
    stillAsleep.velocity = new THREE.Vector3(1, 0, 0);
    assert.isFalse(
        stillAsleep.body.IsActive(),
        'velocity woke the body with activateOnChange=false'
    );

    const wokenByDefault = sleepingBox();
    wokenByDefault.velocity = new THREE.Vector3(1, 0, 0);
    assert.isTrue(wokenByDefault.body.IsActive(), 'the default did not wake the body via velocity');

    const angularStillAsleep = sleepingBox();
    angularStillAsleep.activateOnChange = false;
    angularStillAsleep.angularVelocity = new THREE.Vector3(0, 1, 0);
    assert.isFalse(angularStillAsleep.body.IsActive());

    const angularWokenByDefault = sleepingBox();
    angularWokenByDefault.angularVelocity = new THREE.Vector3(0, 1, 0);
    assert.isTrue(angularWokenByDefault.body.IsActive());

    const overridden = sleepingBox();
    overridden.activateOnChange = false;
    overridden.setVelocity(new THREE.Vector3(1, 0, 0), { activate: true });
    assert.isTrue(overridden.body.IsActive(), 'explicit activate: true did not win for velocity');
});

test('scale: honors activateOnChange and the explicit override', () => {
    const stillAsleep = sleepingBox();
    stillAsleep.activateOnChange = false;
    stillAsleep.scale = 1.5;
    assert.isFalse(stillAsleep.body.IsActive(), 'scale woke the body with activateOnChange=false');

    const wokenByDefault = sleepingBox();
    wokenByDefault.scale = 1.5;
    assert.isTrue(wokenByDefault.body.IsActive(), 'the default did not wake the body via scale');

    const overridden = sleepingBox();
    overridden.activateOnChange = false;
    overridden.setScale(1.5, { activate: true });
    assert.isTrue(overridden.body.IsActive(), 'explicit activate: true did not win for scale');
});

test('group/subGroup: honors activateOnChange and the explicit override', () => {
    const stillAsleep = sleepingBox();
    stillAsleep.activateOnChange = false;
    stillAsleep.group = 42;
    assert.isFalse(
        stillAsleep.body.IsActive(),
        'group change woke the body with activateOnChange=false'
    );

    const wokenByDefault = sleepingBox();
    wokenByDefault.group = 42;
    assert.isTrue(wokenByDefault.body.IsActive(), 'the default did not wake the body via group');

    const subStillAsleep = sleepingBox();
    subStillAsleep.activateOnChange = false;
    subStillAsleep.subGroup = 3;
    assert.isFalse(subStillAsleep.body.IsActive());

    const overridden = sleepingBox();
    overridden.activateOnChange = false;
    overridden.setGroup(42, { activate: true });
    assert.isTrue(overridden.body.IsActive(), 'explicit activate: true did not win for group');
});

test('a static body never activates, regardless of activateOnChange', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(100, 5, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, { bodyType: 'static' }))!;
    assert.isFalse(state.body.IsActive(), 'a static body reported itself active');

    state.activateOnChange = true;
    state.setPosition(new THREE.Vector3(100, 6, 0), { activate: true });
    assert.isFalse(state.body.IsActive(), 'an explicit activate:true woke a static body');
    assert.closeTo(state.position.y, 6, 1e-3, 'the static body did not actually move');
});
