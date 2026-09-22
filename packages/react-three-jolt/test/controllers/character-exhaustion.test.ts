// Issue #210 item 2: `CharacterControllerSystem` emitted both `'exhausted'` and the misspelt
// `'exausted'` as two distinct action strings for what is really the same event (becoming
// exhausted, then recovering), and the option that controls the timing was itself misspelt as
// `exauhstionTimeLimit`. Only `'exhausted'` should ever fire now, and the misspelt option name is
// kept for one release as a deprecated alias of the correctly spelt `exhaustionTimeLimit`.

import { assert, beforeAll, test, vi } from 'vitest';
import { CharacterControllerSystem } from '../../src/controllers/systems/character-controller';
import { initJolt, PhysicsSystem } from '../../src/index';

let ps: PhysicsSystem;

beforeAll(async () => {
    await initJolt();
    ps = new PhysicsSystem('character-exhaustion');
});

test('exauhstionTimeLimit is a deprecated alias of exhaustionTimeLimit', () => {
    const cc = new CharacterControllerSystem(ps);
    try {
        assert.equal(cc.exhaustionTimeLimit, 7000, 'unexpected default');
        assert.equal(cc.exauhstionTimeLimit, 7000, 'the alias should read the same default');

        // setting the misspelt alias must be visible through the correctly spelt property...
        cc.exauhstionTimeLimit = 1234;
        assert.equal(cc.exhaustionTimeLimit, 1234);

        // ...and the other way around
        cc.exhaustionTimeLimit = 4321;
        assert.equal(cc.exauhstionTimeLimit, 4321);
    } finally {
        cc.destroy();
    }
});

test('only "exhausted" fires, never the misspelt "exausted" (issue #209/#210)', () => {
    vi.useFakeTimers();
    try {
        const cc = new CharacterControllerSystem(ps);
        try {
            // short, deterministic timings so the test does not depend on real wall clock time
            cc.runningTimeLimit = 10;
            cc.exhaustionTimeLimit = 20;

            const exhaustedPayloads: unknown[] = [];
            const misspeltPayloads: unknown[] = [];
            cc.on('exhausted', (_action, payload) => exhaustedPayloads.push(payload));
            // `'exausted'` is still a valid (deprecated) CharacterActionName for source
            // compatibility, but the system must never actually emit it.
            cc.on('exausted', (_action, payload) => misspeltPayloads.push(payload));

            cc.startRunning();
            vi.advanceTimersByTime(cc.runningTimeLimit); // becomes exhausted
            vi.advanceTimersByTime(cc.exhaustionTimeLimit); // recovers from exhaustion

            assert.equal(
                exhaustedPayloads.length,
                2,
                'expected exactly two "exhausted" actions: becoming exhausted and recovering'
            );
            assert.equal(misspeltPayloads.length, 0, 'the misspelt "exausted" action still fired');
        } finally {
            cc.destroy();
        }
    } finally {
        vi.useRealTimers();
    }
});
