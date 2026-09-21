// Issue #201: `BodyState.mass` read the *shape's* density-derived mass
// (`GetShape().GetMassProperties().mMass`), so a body created with a `mass` override, or scaled
// afterwards, reported a number that had nothing to do with how it actually behaved. The setter
// went through `SetMassProperties(EAllowedDOFs_All, ...)`, which also reset the body's locked
// degrees of freedom.
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import type { GenerateBodyOptions } from '../src/systems/body-system';
import { PhysicsSystem } from '../src/systems/physics-system';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('body-mass');
});

let x = 0;
function addBox(options?: GenerateBodyOptions, size: [number, number, number] = [1, 1, 1]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    x += 5;
    mesh.position.set(x, 50, 0);
    return ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, options)) as BodyState;
}

/** The number Jolt actually simulates with. */
function inverseMassOf(state: BodyState) {
    return state.body.GetMotionProperties().GetInverseMass();
}

test('a body created with a mass option reports that mass', () => {
    const state = addBox({ mass: 5 });

    assert.closeTo(state.mass, 5, 1e-4, 'the mass option never reached the body');
    assert.closeTo(inverseMassOf(state), 1 / 5, 1e-4);

    // and it is not the shape's density mass, which for a 1x1x1 box is ~1000
    const shapeMass = state.body.GetShape().GetMassProperties().mMass;
    assert.isAbove(shapeMass, 100, 'the shape mass should be nothing like 5 here');

    state.destroy();
});

test('setting mass scales the motion properties and is read back exactly', () => {
    const state = addBox();
    const density = state.body.GetShape().GetMassProperties().mMass;
    assert.closeTo(state.mass, density, 1e-2, 'a body with no override weighs what its shape does');

    state.mass = 10;
    assert.closeTo(inverseMassOf(state), 0.1, 1e-6, 'the setter did not reach the inverse mass');
    assert.closeTo(state.mass, 10, 1e-4, 'the getter did not read the override back');

    // setting it again is absolute, not relative
    state.mass = 2;
    assert.closeTo(state.mass, 2, 1e-4);
    assert.closeTo(inverseMassOf(state), 0.5, 1e-6);

    state.destroy();
});

test('setting mass leaves locked degrees of freedom alone', () => {
    const state = addBox();
    state.lockRotations();
    assert.isFalse(state.dof.rotX);

    state.mass = 25;

    assert.closeTo(state.mass, 25, 1e-4);
    assert.isFalse(state.dof.rotX, 'setting mass unlocked the rotations again');
    assert.isFalse(state.dof.rotY);
    assert.isFalse(state.dof.rotZ);
    assert.isTrue(state.dof.x, 'setting mass also clobbered the translations');

    state.destroy();
});

test('static and kinematic bodies report a mass of 0 and ignore the setter', () => {
    const staticBody = addBox({ bodyType: 'static' });
    const kinematic = addBox({ bodyType: 'kinematic' });

    assert.equal(staticBody.mass, 0, 'a static body has infinite mass, reported as 0');
    assert.equal(kinematic.mass, 0, 'a kinematic body has infinite mass, reported as 0');

    // must not throw, and must not change anything (a static body has no MotionProperties at all)
    staticBody.mass = 12;
    kinematic.mass = 12;
    assert.equal(staticBody.mass, 0);
    assert.equal(kinematic.mass, 0);

    // the other motion-properties accessors are safe on a static body too
    assert.equal(staticBody.linearDamping, 0);
    staticBody.linearDamping = 0.5;
    staticBody.gravityFactor = 0;

    staticBody.destroy();
    kinematic.destroy();
});

test('a nonsense mass is refused rather than turned into an infinite one', () => {
    const state = addBox({ mass: 4 });

    state.mass = 0;
    assert.closeTo(state.mass, 4, 1e-4, 'mass = 0 produced an infinitely heavy body');
    state.mass = -3;
    assert.closeTo(state.mass, 4, 1e-4, 'a negative mass was accepted');

    state.destroy();
});

test('a heavier body pushes a lighter one, not the other way round', () => {
    // the point of #201: the number the getter reports is the one the simulation uses
    const heavy = addBox({ mass: 100 }, [2, 2, 2]);
    const light = addBox({ mass: 1 }, [2, 2, 2]);
    heavy.position = new THREE.Vector3(0, 200, 0);
    light.position = new THREE.Vector3(2.5, 200, 0);
    heavy.gravityFactor = 0;
    light.gravityFactor = 0;
    heavy.velocity = new THREE.Vector3(6, 0, 0);

    for (let i = 0; i < 60; i++) ps.onUpdate(1 / 60);

    assert.isAbove(light.position.x, 3, 'the light body was not pushed along');
    assert.isAbove(heavy.velocity.x, 4, 'the heavy body was stopped by the light one');

    heavy.destroy();
    light.destroy();
});
