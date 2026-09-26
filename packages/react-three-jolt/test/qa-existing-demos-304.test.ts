// Issue #304 (existing-demo polish, browser QA round): two layout bugs the maintainer found by
// actually clicking through the examples, reproduced here against the real WASM module with
// the same numbers the example pages use, so a future regression fails a test instead of just
// looking boring/broken in a browser.
//
// One PhysicsSystem per test (bodies/gravity differ per scenario); each destroys its own world.
import * as THREE from 'three';
import { assert, beforeAll, describe, test } from 'vitest';
import { initJolt } from '../src/raw';
import type { BodyState } from '../src/systems/body-state';
import { PhysicsSystem } from '../src/systems/physics-system';

const STEP = 1 / 60;

beforeAll(async () => {
    await initJolt();
});

function addBox(
    ps: PhysicsSystem,
    size: [number, number, number],
    at: THREE.Vector3,
    options?: Parameters<PhysicsSystem['bodySystem']['addBody']>[1]
) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, options)) as BodyState;
    return { mesh, state };
}

function addSphere(
    ps: PhysicsSystem,
    radius: number,
    at: THREE.Vector3,
    options?: Parameters<PhysicsSystem['bodySystem']['addBody']>[1]
) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 12));
    mesh.position.copy(at);
    const state = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh, options)) as BodyState;
    return { mesh, state };
}

// FloatingPlatforms.tsx -----------------------------------------------------------------------
// The box pile used to spawn every instance at [0, 24, 0] +/- a tiny jitter, straight above the
// center disc, so the other four platforms never caught anything. The fix spreads the spawns
// across all five platform footprints (same t=0 centers the example's `useFrame` drive starts
// from). This reproduces that spread at the system level: one box dropped per platform's spawn
// zone must come to rest on that platform, not fall past it or roll onto a neighbour.
describe('FloatingPlatforms (#304): spawns land on every platform', () => {
    // t = 0 centers of the five kinematic platforms in FloatingPlatforms.tsx
    const PLATFORMS: { name: string; at: THREE.Vector3; size: [number, number, number] }[] = [
        { name: 'liftA', at: new THREE.Vector3(-16, 10, -4), size: [6, 1, 6] },
        { name: 'liftB', at: new THREE.Vector3(16, 10, 4), size: [6, 1, 6] },
        { name: 'conveyorA', at: new THREE.Vector3(0, 1.5, -16), size: [10, 1, 4] },
        { name: 'conveyorB', at: new THREE.Vector3(0, 1.5, 16), size: [10, 1, 4] },
        { name: 'disc', at: new THREE.Vector3(0, 1.5, 0), size: [12, 1, 12] } // cylinder r=6 -> AABB ~12x12
    ];

    for (const platform of PLATFORMS) {
        test(`a cube dropped above ${platform.name} lands on it`, () => {
            const ps = new PhysicsSystem(`floating-platforms-${platform.name}`);
            try {
                ps.setGravity(22);
                addBox(ps, platform.size, platform.at, { bodyType: 'static' });

                // the spawn zone this platform would get once spawns are spread out: same xz,
                // a few units of jitter, dropped from well above the platform's own height.
                const spawnAt = new THREE.Vector3(platform.at.x, platform.at.y + 14, platform.at.z);
                const { state: cube } = addBox(ps, [1, 1, 1], spawnAt, { mass: 15 });

                for (let i = 0; i < 300; i++) ps.onUpdate(STEP);

                assert.closeTo(
                    cube.position.x,
                    platform.at.x,
                    platform.size[0] / 2,
                    `cube dropped above ${platform.name} did not land on it (x)`
                );
                assert.closeTo(
                    cube.position.z,
                    platform.at.z,
                    platform.size[2] / 2,
                    `cube dropped above ${platform.name} did not land on it (z)`
                );
                assert.isAbove(
                    cube.position.y,
                    platform.at.y,
                    `cube dropped above ${platform.name} fell through it`
                );
                cube.destroy();
            } finally {
                ps.destroy();
            }
        });
    }
});

// OneWayPlatform.tsx ----------------------------------------------------------------------
// The platform used to be 14x14 (half extent 7), while the side launchers sit at x = +/-8 with
// a 0.7 radius ball - entirely outside the platform's footprint, so they shot straight up and
// straight back down without ever touching it. Widened to 20x14 (half extent 10 in x) so every
// launcher's column is well inside the platform.
describe('OneWayPlatform (#304): every launcher hits the platform', () => {
    const PLATFORM_Y = 6;
    const PLATFORM_SIZE: [number, number, number] = [20, 0.4, 14]; // matches the fixed example

    for (const x of [-8, 0, 8]) {
        test(`the ball launched at x=${x} lands on the platform`, () => {
            const ps = new PhysicsSystem(`one-way-platform-${x}`);
            try {
                const { state: platform } = addBox(
                    ps,
                    PLATFORM_SIZE,
                    new THREE.Vector3(0, PLATFORM_Y, 0),
                    { bodyType: 'static' }
                );
                platform.onContactValidate((e) => {
                    const other = e.other.body;
                    if (!other) return true;
                    return other.velocity.y <= 0;
                });

                const { state: ball } = addSphere(ps, 0.7, new THREE.Vector3(x, 1, 0));
                ball.velocity = new THREE.Vector3(0, 16, 0);

                // enough steps to pass through, arc over, and settle back onto the platform
                for (let i = 0; i < 240; i++) ps.onUpdate(STEP);

                assert.closeTo(
                    ball.position.x,
                    x,
                    1,
                    `ball launched at x=${x} drifted off its column`
                );
                assert.closeTo(
                    ball.position.y,
                    PLATFORM_Y + 0.2 + 0.7,
                    0.3,
                    `ball launched at x=${x} never came to rest on the platform`
                );
                assert.isBelow(
                    ball.velocity.length(),
                    0.5,
                    `ball launched at x=${x} is still moving - it missed the platform`
                );
                ball.destroy();
            } finally {
                ps.destroy();
            }
        });
    }
});
