// This is a helper to load and pass around the global Jolt object
// pulled from isaac-mason's sketch
// https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/raw.ts

import type Jolt from 'jolt-physics';
import { devWarn } from './utils/general';

export const Raw = { module: null! as typeof Jolt, joltInterfaces: new Map() };

export const free = (value: unknown) => {
    Raw.module.destroy(value);
};

// The factory currently backing `Raw.module` (undefined when it was loaded via the bundled
// default). Tracked so a repeat call with the *same* factory - `suspend-react` re-running,
// StrictMode's double-invoke, a hot reload - is recognised as a no-op instead of a fresh module
// swap, and so a call with a *different* factory can be told apart from that.
let activeFactory: (() => Promise<typeof Jolt>) | undefined;

/**
 * Initialise (or select) the jolt-physics WASM module backing every `<Physics>` world.
 *
 * - Called with no argument: loads the bundled default (the `jolt-physics` entrypoint, i.e.
 *   `wasm-compat`) once and reuses it for every later no-argument call.
 * - Called with `jolt`: the default export of any jolt-physics entrypoint - `jolt-physics/wasm`,
 *   `/debug-wasm-compat`, `/asm`, `/wasm-multithread`, ... (see the README for the full list and
 *   the bundler setup each one needs). The first call with a given factory reference initialises
 *   it; a later call with that *same* reference reuses the existing module.
 *
 * Swapping to a **different** module while a Physics world already exists (`Raw.joltInterfaces`
 * is non-empty) is refused: every body, shape and constraint the live world owns points into the
 * old module's WASM heap, and there is no way to migrate them to a new one. The old behaviour
 * here (`delete Raw.module` and reinitialise) silently stranded that heap with no way to free it
 * and left every live handle dangling. Instead this warns via `devWarn` and keeps the active
 * module - call `initJolt(otherModule)` before any `<Physics>` mounts (or after every one has
 * unmounted), not while one is running.
 */
export const initJolt = async (jolt?: () => Promise<typeof Jolt>) => {
    if (jolt) {
        if (Raw.module !== null) {
            if (jolt === activeFactory) return;
            if (Raw.joltInterfaces.size > 0) {
                devWarn(
                    'initJolt: ignoring a different jolt-physics module because a Physics world already ' +
                        'exists. Select the module before mounting the first <Physics>, or unmount every ' +
                        'world first - reusing the module that is already active.'
                );
                return;
            }
        }
        activeFactory = jolt;
        Raw.module = await jolt();
    } else {
        if (Raw.module !== null) return;
        activeFactory = undefined;
        const joltInit = await import('jolt-physics');
        Raw.module = await joltInit.default();
    }
};
