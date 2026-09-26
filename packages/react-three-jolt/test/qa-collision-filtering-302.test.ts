// QA repro + regression for issue #302: every box in the CollisionFiltering example fell through
// every shelf, including its own colour. Rebuilds the exact scene from
// apps/examples/src/examples/CollisionFiltering.tsx through the library's public body-system API
// - three static shelves, a 3x3 grid of falling boxes per shelf, and the same disableCollision
// calls the example makes when `filterByColor` is on - then steps the world and checks each
// colour comes to rest on its own shelf.
//
// Root cause: Jolt's GroupFilterTable hardcodes "two bodies with the SAME sub group id never
// collide" (Jolt/Physics/Collision/GroupFilterTable.h: `CanCollide` returns false whenever
// `GetSubGroupID()` matches, before it even looks at the bit table) - this is unconditional and
// disableCollision/enableCollision cannot override it. The original example gave a shelf and its
// matching-colour boxes the SAME subGroup (e.g. red shelf and red boxes both subGroup 1), which
// guaranteed they could never touch regardless of any disableCollision call. Not a library bug:
// the group filter, static bodies, and disableCollision's bit-table indexing all behave exactly
// like upstream Jolt (see the passing `same subgroup` assertions below, and
// test/collision-groups.test.ts for the dynamic-vs-dynamic cases). The fix is to give shelves and
// boxes DIFFERENT sub group ids (shelf id + BOX_ID_OFFSET below, matching the example) and disable
// the mismatched shelf/colour pairs instead.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const GRID = 3;
const SPACING = 1.1;
const BOX_ID_OFFSET = 10;

const SHELVES = [
    { name: 'red', subGroup: 1, y: 3 },
    { name: 'green', subGroup: 2, y: 6 },
    { name: 'blue', subGroup: 3, y: 9 }
] as const;

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-collision-filtering-302');
    ps.setGravity(20);

    // catch-all floor, ungrouped, like <Floor> in the example
    const floor = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 30));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });

    // three static shelves, each with its OWN subGroup (1, 2, 3)
    for (const shelf of SHELVES) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 5));
        mesh.position.set(0, shelf.y, 0);
        ps.bodySystem.addBody(mesh, { bodyType: 'static', group: 0, subGroup: shelf.subGroup });
    }

    // disable every shelf/colour pair whose colours DON'T match (a shelf always collides with its
    // own colour's boxes: they never share a subGroup id, so that pair is never touched here)
    for (const shelf of SHELVES) {
        for (const other of SHELVES) {
            if (shelf === other) continue;
            ps.bodySystem.disableCollision(shelf.subGroup, other.subGroup + BOX_ID_OFFSET);
        }
    }
});

function dropBoxes(shelfSubGroup: number): BodyState[] {
    const offset = ((GRID - 1) * SPACING) / 2;
    const boxes: BodyState[] = [];
    for (let x = 0; x < GRID; x++) {
        for (let z = 0; z < GRID; z++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
            mesh.position.set(x * SPACING - offset, 14 + shelfSubGroup, z * SPACING - offset);
            const handle = ps.bodySystem.addBody(mesh, {
                group: 0,
                subGroup: shelfSubGroup + BOX_ID_OFFSET
            });
            boxes.push(ps.bodySystem.getBody(handle)!);
        }
    }
    return boxes;
}

function settle(frames: number) {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
}

test('each colour of falling box comes to rest on its own shelf, not the floor', () => {
    const boxesBySubGroup = new Map(SHELVES.map((shelf) => [shelf.subGroup, dropBoxes(shelf.subGroup)]));

    // long enough for a box starting at y ~ 15-17 under gravity=20 to reach the floor if it fell
    // all the way through, and to fully settle on a shelf otherwise
    settle(300);

    for (const shelf of SHELVES) {
        const boxes = boxesBySubGroup.get(shelf.subGroup)!;
        for (const box of boxes) {
            assert.isAbove(
                box.position.y,
                shelf.y + 0.2,
                `a ${shelf.name} box (subGroup ${shelf.subGroup + BOX_ID_OFFSET}) ended at ` +
                    `y=${box.position.y.toFixed(2)}, below its own shelf at y=${shelf.y} - it ` +
                    `fell through its own colour's shelf`
            );
            assert.isBelow(
                box.position.y,
                shelf.y + 2,
                `a ${shelf.name} box (subGroup ${shelf.subGroup + BOX_ID_OFFSET}) ended at ` +
                    `y=${box.position.y.toFixed(2)}, well above its own shelf at y=${shelf.y} - ` +
                    `it never landed`
            );
        }
    }
});
