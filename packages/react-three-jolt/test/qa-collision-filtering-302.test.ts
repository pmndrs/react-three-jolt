// QA repro for issue #302: every box in the CollisionFiltering example falls through every
// shelf, including its own colour. Rebuilds the exact scene from
// apps/examples/src/examples/CollisionFiltering.tsx through the library's public API - three
// static shelves at group 0 / subGroup 1,2,3, a 3x3 grid of falling boxes per shelf sharing its
// shelf's subGroup, and the same three cross-colour pairs disabled - then steps the world and
// checks each colour comes to rest on its own shelf.

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const GRID = 3;
const SPACING = 1.1;

const SHELVES = [
    { name: 'red', subGroup: 1, y: 3 },
    { name: 'green', subGroup: 2, y: 6 },
    { name: 'blue', subGroup: 3, y: 9 }
] as const;
const CROSS_PAIRS: [number, number][] = [
    [1, 2],
    [1, 3],
    [2, 3]
];

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('qa-collision-filtering-302');
    ps.setGravity(20);

    // catch-all floor, ungrouped, like <Floor> in the example
    const floor = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 30));
    floor.position.set(0, -0.5, 0);
    ps.bodySystem.addBody(floor, { bodyType: 'static' });

    // three static shelves, same group (0, the default), one subGroup each
    for (const shelf of SHELVES) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 5));
        mesh.position.set(0, shelf.y, 0);
        ps.bodySystem.addBody(mesh, { bodyType: 'static', group: 0, subGroup: shelf.subGroup });
    }

    // the same cross-colour pairs the example disables when `filterByColor` is on
    for (const [a, b] of CROSS_PAIRS) ps.bodySystem.disableCollision(a, b);
});

function dropBoxes(subGroup: number): BodyState[] {
    const offset = ((GRID - 1) * SPACING) / 2;
    const boxes: BodyState[] = [];
    for (let x = 0; x < GRID; x++) {
        for (let z = 0; z < GRID; z++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
            mesh.position.set(x * SPACING - offset, 14 + subGroup, z * SPACING - offset);
            const handle = ps.bodySystem.addBody(mesh, { group: 0, subGroup });
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

    // long enough for a box starting at y ~ 14-17 under gravity=20 to reach the floor if it fell
    // all the way through, and to fully settle on a shelf otherwise
    settle(300);

    for (const shelf of SHELVES) {
        const boxes = boxesBySubGroup.get(shelf.subGroup)!;
        for (const box of boxes) {
            assert.isAbove(
                box.position.y,
                shelf.y + 0.2,
                `a ${shelf.name} box (subGroup ${shelf.subGroup}) ended at y=${box.position.y.toFixed(2)}, ` +
                    `below its own shelf at y=${shelf.y} - it fell through its own colour's shelf`
            );
            assert.isBelow(
                box.position.y,
                shelf.y + 2,
                `a ${shelf.name} box (subGroup ${shelf.subGroup}) ended at y=${box.position.y.toFixed(2)}, ` +
                    `well above its own shelf at y=${shelf.y} - it never landed`
            );
        }
    }
});
