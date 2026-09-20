// Coverage for the typed embind helpers added for issue #144 (`wrapPointer`, `castObject`,
// `getPointer`) and for the collector/cast callback types that replaced the ~60 blanket
// suppressions around them (#11, #145).
//
// Two things are being checked here, and the second one is the point of the file:
//  - at runtime, that the helpers really are `Raw.module.wrapPointer/castObject/getPointer` and
//    round trip a pointer back into a usable wrapper;
//  - at compile time, that the helper signatures and the `cast()` handler types accept what the
//    library and the demos actually pass. `yarn test` runs `tsc -p tsconfig.test.json` before
//    vitest, so a regression in either signature fails the test run even though the assertions
//    below would still pass.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { castObject, getPointer, initJolt, Raw, wrapPointer } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import type { RaycastHit } from '../src/systems/queries/raycasters';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('typed-helpers');
    const floor = new THREE.Mesh(new THREE.BoxGeometry(50, 1, 50));
    floor.position.set(0, -1, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });
});

test('wrapPointer round trips a body pointer and keeps its identity', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.position.set(0, 5, 0);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

    const pointer = getPointer(state.body);
    assert.isNumber(pointer);
    assert.notEqual(pointer, 0, 'a live body must have a non-null pointer');

    // The wrapper is a *view*: emscripten caches one per (pointer, class), so re-wrapping the
    // same address hands back the very same object rather than allocating anything.
    const wrapped = wrapPointer(pointer, Raw.module.Body);
    assert.strictEqual(wrapped, state.body);
    assert.strictEqual(
        wrapped.GetID().GetIndexAndSequenceNumber(),
        state.handle,
        'the wrapped body is not the one the pointer came from'
    );

    state.destroy(true);
});

test('castObject re-views a shape as its subclass', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

    const shape = state.body.GetShape();
    assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Box);

    // The base `Shape` type has no GetHalfExtent; reading one is exactly what every call site
    // used to need a suppression for.
    const asBox = castObject(shape, Raw.module.BoxShape);
    const halfExtent = asBox.GetHalfExtent();
    assert.closeTo(halfExtent.GetX(), 1, 0.05);

    // castObject re-wraps the same pointer, so the cast view aliases the original - which is why
    // only one of them may ever be released.
    assert.equal(getPointer(asBox), getPointer(shape));

    state.destroy(true);
});

test('cast() accepts a narrower success handler and reports the hit', () => {
    const rc = ps.getRaycaster();
    rc.origin = new THREE.Vector3(0, 20, 0);
    rc.direction = new THREE.Vector3(0, -40, 0);

    let seen: RaycastHit | undefined;
    let missed = false;
    // `(hit: RaycastHit) => void` is narrower than the declared `THit | THit[]` parameter. It
    // compiles because CastSuccessHandler is method-style (bivariant) - every demo in
    // apps/examples passes exactly this, and a plain function-type property would reject it.
    rc.cast(
        (hit: RaycastHit) => {
            seen = hit;
        },
        () => {
            missed = true;
        }
    );

    assert.isFalse(missed, 'the fail handler ran for a ray that should have hit the floor');
    assert.isDefined(seen, 'the success handler never ran');
    assert.isFinite((seen as RaycastHit).position.y);
});

test('a miss runs the fail handler and returns undefined', () => {
    const rc = ps.getRaycaster();
    // straight up, away from the floor
    rc.origin = new THREE.Vector3(0, 20, 0);
    rc.direction = new THREE.Vector3(0, 40, 0);

    let missed = false;
    const result = rc.cast(undefined, () => {
        missed = true;
    });

    assert.isUndefined(result);
    assert.isTrue(missed, 'the fail handler did not run for a ray that hit nothing');
});
