// QA repro + regression for issue #302: every box in the CollisionFiltering example fell through
// every shelf, including its own colour. Rebuilds the exact scene from
// apps/examples/src/examples/CollisionFiltering.tsx through the library's public body-system API
// - three static shelves, a fixed pool of falling boxes per shelf (each with its OWN subGroup id,
// matching the example's `boxSubGroup` formula), and the same disableCollision calls the example
// makes when `filterByColor` is on - then steps the world and checks each colour comes to rest on
// its own shelf, and that two boxes of the same colour still stack on one another.
//
// Root cause: Jolt's GroupFilterTable hardcodes "two bodies with the SAME sub group id never
// collide" (Jolt/Physics/Collision/GroupFilterTable.h: `CanCollide` returns false whenever
// `GetSubGroupID()` matches, before it even looks at the bit table) - this is unconditional and
// disableCollision/enableCollision cannot override it. The original example gave a shelf and its
// matching-colour boxes the SAME subGroup (e.g. red shelf and red boxes both subGroup 1), which
// guaranteed they could never touch. The first fix moved boxes to a per-COLOUR subGroup distinct
// from the shelf's - which fixed shelf/box catching, but meant every box of a colour shared ONE
// subGroup, so same-colour boxes could never collide with each other either (they'd silently sink
// through one another instead of stacking). The fix here gives every individual box its own
// subGroup id (`boxSubGroup(colourIndex, slot)`), so same-colour boxes are free to collide with
// each other by default; only each box's two wrong-colour shelves get disabled.
//
// Not a library bug: the group filter, static bodies, and disableCollision's bit-table indexing
// all behave exactly like upstream Jolt (see test/collision-groups.test.ts for the dynamic-vs-
// dynamic cases already covered there).

import * as THREE from 'three';
import { assert, beforeAll, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;
const POOL_SIZE = 5;
const BOX_ID_OFFSET = 10;
const SLOT_SPACING = 1.1;
const SLOT_OFFSETS: [number, number][] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
];

const SHELVES = [
    { name: 'red', subGroup: 1, y: 3 },
    { name: 'green', subGroup: 2, y: 6 },
    { name: 'blue', subGroup: 3, y: 9 }
] as const;

function boxSubGroup(colourIndex: number, slot: number) {
    return BOX_ID_OFFSET + colourIndex * POOL_SIZE + slot + 1;
}

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

    // disable every shelf/colour pair whose colours DON'T match, for every box in the pool (a
    // shelf always collides with its own colour's boxes: they never share a subGroup id, so
    // those pairs are never touched here, and neither are same-colour box/box pairs)
    for (const shelf of SHELVES) {
        for (let colourIndex = 0; colourIndex < SHELVES.length; colourIndex++) {
            if (SHELVES[colourIndex] === shelf) continue;
            for (let slot = 0; slot < POOL_SIZE; slot++) {
                ps.bodySystem.disableCollision(shelf.subGroup, boxSubGroup(colourIndex, slot));
            }
        }
    }
});

function dropPool(colourIndex: number): BodyState[] {
    const shelf = SHELVES[colourIndex];
    const boxes: BodyState[] = [];
    for (let slot = 0; slot < POOL_SIZE; slot++) {
        const [ox, oz] = SLOT_OFFSETS[slot];
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
        mesh.position.set(ox * SLOT_SPACING, 14 + shelf.subGroup, oz * SLOT_SPACING);
        const handle = ps.bodySystem.addBody(mesh, {
            group: 0,
            subGroup: boxSubGroup(colourIndex, slot)
        });
        boxes.push(ps.bodySystem.getBody(handle)!);
    }
    return boxes;
}

function settle(frames: number) {
    for (let i = 0; i < frames; i++) ps.onUpdate(STEP);
}

test('each colour of falling box comes to rest on its own shelf, not the floor', () => {
    const pools = SHELVES.map((_, colourIndex) => dropPool(colourIndex));

    // long enough for a box starting at y ~ 15-17 under gravity=20 to reach the floor if it fell
    // all the way through, and to fully settle on a shelf otherwise
    settle(300);

    SHELVES.forEach((shelf, colourIndex) => {
        for (const box of pools[colourIndex]) {
            assert.isAbove(
                box.position.y,
                shelf.y + 0.2,
                `a ${shelf.name} box ended at y=${box.position.y.toFixed(2)}, below its own ` +
                    `shelf at y=${shelf.y} - it fell through its own colour's shelf`
            );
            assert.isBelow(
                box.position.y,
                shelf.y + 2,
                `a ${shelf.name} box ended at y=${box.position.y.toFixed(2)}, well above its ` +
                    `own shelf at y=${shelf.y} - it never landed`
            );
        }
    });
});

test('two boxes of the same colour still stack on one another instead of sinking through', () => {
    // a fresh, isolated shelf/pair so this doesn't interact with the settled pool above
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 5));
    shelf.position.set(20, 3, 0);
    ps.bodySystem.addBody(shelf, { bodyType: 'static', group: 0, subGroup: 90 });

    const lowerMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    lowerMesh.position.set(20, 3.5, 0);
    const lowerHandle = ps.bodySystem.addBody(lowerMesh, { group: 0, subGroup: 91 });
    const lower = ps.bodySystem.getBody(lowerHandle)!;

    const upperMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    upperMesh.position.set(20, 6, 0);
    const upperHandle = ps.bodySystem.addBody(upperMesh, { group: 0, subGroup: 92 });
    const upper = ps.bodySystem.getBody(upperHandle)!;

    settle(180);

    // lower box rests on the shelf: shelf top (y + 0.25) + half a box (0.25) = shelf.y + 0.5
    assert.closeTo(
        lower.position.y,
        3.5,
        0.2,
        `the lower box did not settle on its shelf, ended at y=${lower.position.y.toFixed(2)}`
    );
    // upper box rests on the lower box: shelf top + 1.5 box heights = shelf.y + 1.0
    assert.closeTo(
        upper.position.y,
        4.0,
        0.2,
        `the upper box did not stack on the lower one (same-colour boxes must still collide ` +
            `with each other), ended at y=${upper.position.y.toFixed(2)}`
    );
});
