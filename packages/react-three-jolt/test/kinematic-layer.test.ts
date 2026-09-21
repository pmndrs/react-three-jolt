// Issue #210 item 5: `Layer.KINEMATIC` existed but kinematic bodies were created on
// `Layer.MOVING`, so the reserved layer id was pure documentation - nothing ever used it and
// there was no way to filter a kinematic body's collisions independently of a dynamic one's.
//
// `generateBodySettings` (body-system.ts) now assigns `Layer.KINEMATIC` to any body created with
// `bodyType: 'kinematic'` (or `motionType: 'kinematic'`), and the object layer pair filter built
// in `PhysicsSystem`'s constructor enables it against `NON_MOVING`, `MOVING` and itself - so a
// kinematic platform keeps colliding with dynamic boxes exactly as it did while sharing `MOVING`.
//
// The pair filter alone is not the whole story for a *static* floor, though: Jolt only runs
// narrowphase on a pair when at least one side is Dynamic, so a kinematic-vs-static (or
// kinematic-vs-kinematic) pair is skipped regardless of what the pair filter allows, unless the
// kinematic body opts in with `BodyCreationSettings.mCollideKinematicVsNonDynamic`. Confirmed by
// probing the real WASM module: without that flag, driving a kinematic body deep into a static
// floor (or another kinematic body) with `moveKinematic` produced zero contact events no matter
// how the pair filter was configured. `generateBodySettings` now sets that flag for every
// kinematic body too, which is what the third test below actually exercises.
import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { Layer } from '../src/constants';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('kinematic-layer');
});

function addBox(
    size: [number, number, number],
    at: THREE.Vector3,
    bodyType?: 'kinematic' | 'static'
): BodyState {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    return ps.bodySystem.getBody(
        ps.bodySystem.addBody(mesh, bodyType ? { bodyType } : undefined)
    ) as BodyState;
}

test('a kinematic body is created on Layer.KINEMATIC, not Layer.MOVING', () => {
    const state = addBox([1, 1, 1], new THREE.Vector3(0, 50, 0), 'kinematic');
    assert.equal(state.body.GetObjectLayer(), Layer.KINEMATIC);
    state.destroy();
});

test('a kinematic platform still supports a dynamic box resting on it', () => {
    ps.resetAccumulator();
    const platform = addBox([10, 1, 10], new THREE.Vector3(0, 0, -60), 'kinematic');
    const box = addBox([1, 1, 1], new THREE.Vector3(0, 1.1, -60));

    for (let i = 0; i < 120; i++) ps.onUpdate(STEP);

    assert.closeTo(
        box.position.y,
        1,
        0.1,
        'the dynamic box fell through the kinematic platform instead of resting on it - ' +
            'Layer.KINEMATIC vs Layer.MOVING must be enabled in the pair filter'
    );

    box.destroy();
    platform.destroy();
});

test('a kinematic body still generates contacts against static geometry', () => {
    ps.resetAccumulator();
    // top surface at y = 0.5
    const floor = addBox([50, 1, 50], new THREE.Vector3(0, 0, -100), 'static');
    const platform = addBox([2, 1, 2], new THREE.Vector3(0, 5, -100), 'kinematic');

    let entered = false;
    platform.onCollisionEnter(() => {
        entered = true;
    });

    // drive the kinematic platform down into the static floor by hand - kinematic bodies are
    // not affected by collision response, so this is the only way to bring them into contact.
    // Both pieces have to be right for this to fire: Layer.KINEMATIC vs Layer.NON_MOVING enabled
    // in the pair filter, AND `mCollideKinematicVsNonDynamic` set on the body (Jolt otherwise
    // skips narrowphase entirely for a pair with no Dynamic side).
    for (let i = 1; i <= 90 && !entered; i++) {
        platform.moveKinematic(new THREE.Vector3(0, 5 - i * 0.1, -100), null, STEP);
        ps.onUpdate(STEP);
    }

    assert.isTrue(
        entered,
        'the kinematic platform never contacted the static floor - check the ' +
            'Layer.KINEMATIC/NON_MOVING pair filter and mCollideKinematicVsNonDynamic'
    );

    platform.destroy();
    floor.destroy();
});
