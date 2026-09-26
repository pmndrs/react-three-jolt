// Regression test for issue #303: the Shapecast example (apps/examples/src/examples/Shapecast.tsx,
// issue #287) sweeps a sphere over a row of static boxes but never shows a hit marker or normal
// arrow - `Shapecaster.cast()` never reports a hit in the browser.
//
// Root cause: `Shapecaster`'s `origin`/`rotation`/`scale` setters all route through `setOrigin()`,
// which destroys the live `Jolt.RShapeCast` and rebuilds it via `initializeShapecast()`.
// `initializeShapecast()` builds the new cast's direction from `this.activeDirection` - a field
// the `direction` setter never touches (it mutates `this.shapecast.mDirection` on the *existing*
// native object in place instead, see the `direction` getter/setter in shapecasters.ts). So any
// origin/rotation/scale write after a direction write silently resets the cast's direction back to
// the zero vector `activeDirection` is constructed with.
//
// The `shape` setter already works around exactly this (see its comment: "Capture + restore the
// current direction across the rebuild ... a naive rebuild here would silently reset direction
// back to zero") - `setOrigin()` never got the same treatment.
//
// The example hits this dead-on: `ShapecastSweep`'s `direction` effect runs once on mount, then
// `useFrame` sets `shapecaster.origin` every frame before calling `cast()` - so after the very
// first frame, every cast runs with direction (0,0,0), i.e. a stationary probe at the sweep's
// current height (well above every obstacle), and never hits anything again.
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import type { ShapecastHit } from '../src/systems/queries/shapecasters';

let ps: PhysicsSystem;

// Mirrors Shapecast.tsx's scene: a floor plus a few static boxes at different heights/positions.
beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-shapecast-303-test');

    const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(20, 0.2, 20));
    floorMesh.position.set(0, -0.1, 0);
    ps.bodySystem.addBody(floorMesh, { bodyType: 'static' });

    const OBSTACLES: { position: [number, number, number]; size: [number, number, number] }[] = [
        { position: [-6, 0.5, 0], size: [1.4, 1, 1.4] },
        { position: [-2, 1, 0], size: [1.4, 2, 1.4] },
        { position: [2, 0.3, 0], size: [1.4, 0.6, 1.4] },
        { position: [6, 0.8, 0], size: [1.4, 1.6, 1.4] }
    ];
    for (const obstacle of OBSTACLES) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...obstacle.size));
        mesh.position.set(...obstacle.position);
        ps.bodySystem.addBody(mesh, { bodyType: 'static' });
    }
});

test('a shapecast whose direction is set before origin (the example order) still hits the obstacle below it (issue #303)', () => {
    const sc = ps.getShapecaster();

    // matches ShapecastSweep: the direction effect runs once (castDistance=5, straight down)...
    sc.direction = new THREE.Vector3(0, -5, 0);
    // ...then useFrame sets `origin` every frame, directly over the tallest obstacle
    // (position [-2, 1, 0], size [1.4, 2, 1.4] -> top at y=2), well within a 5-unit downward sweep.
    sc.origin = new THREE.Vector3(-2, 4, 0);

    const hit = sc.cast() as ShapecastHit | undefined;
    assert.isDefined(
        hit,
        'shapecast found nothing - direction set before origin was lost on the origin rebuild'
    );
    assert.closeTo(
        hit!.position.y,
        2,
        0.5,
        'hit position is not on top of the obstacle the sweep should have found'
    );

    sc.destroy();
});

test('origin can keep changing frame-to-frame without losing a direction set once up front (issue #303)', () => {
    const sc = ps.getShapecaster();
    sc.direction = new THREE.Vector3(0, -5, 0);

    // frame 1: over empty space between obstacles - expect a miss (floor is 20 units wide/deep but
    // the floor itself sits far enough below that a 5-unit sweep from y=4 still reaches it, so
    // assert the *obstacle* isn't hit rather than asserting no hit at all)
    sc.origin = new THREE.Vector3(0, 4, 0);
    const first = sc.cast() as ShapecastHit | undefined;

    // frame 2: directly over the short obstacle at x=2 (top at y=0.3+0.3=0.6)
    sc.origin = new THREE.Vector3(2, 4, 0);
    const second = sc.cast() as ShapecastHit | undefined;
    assert.isDefined(second, 'second-frame shapecast found nothing - direction was lost again');
    assert.closeTo(second!.position.y, 0.6, 0.5, 'second-frame hit is not on the short obstacle');

    // sanity: the two casts landed on genuinely different surfaces (proves the sweep is actually
    // tracking the moving origin, not just replaying frame 1's cast)
    if (first) assert.notEqual(first.position.y, second!.position.y);

    sc.destroy();
});
