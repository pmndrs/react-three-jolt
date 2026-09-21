// The jolt-physics WASM module, and the registry of live physics worlds built on it.
// Originally from isaac-mason's sketch:
// https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/raw.ts

import type Jolt from 'jolt-physics';
import { devWarn } from './utils/general';

/**
 * Live `JoltInterface`s by id. Ids are handed out by {@link JoltModule.registerInterface} from a
 * monotonically increasing counter and are never reused, so a stale id can never resolve to
 * somebody else's world.
 *
 * This replaces the old `Raw.joltInterfaces` map, which was keyed by the React `useId()` of the
 * `<Physics>` component (issue #35): that key changes across remounts, so unmount/remount grew
 * the map instead of reusing a slot, and once it held three entries a fourth `<Physics>` was
 * silently handed the *first* world's interface (issue #176).
 */
const interfaces = new Map<number, Jolt.JoltInterface>();
let nextInterfaceId = 1;

/**
 * The jolt-physics module and the worlds built on it.
 *
 * There is exactly one of these per page. The WASM module is inherently global - it owns a
 * single linear memory that every body, shape and constraint lives in - so this is a deliberate
 * module level singleton rather than something threaded through React context. See issue #35.
 */
export const JoltModule = {
    /**
     * The jolt-physics emscripten module: **one per page**, set by {@link initJolt}. Null until
     * the first `<Physics>` (or an explicit `initJolt()`) has resolved.
     *
     * Prefer {@link getJoltModule}, which throws a useful error instead of handing back null.
     */
    module: null! as typeof Jolt,

    /**
     * Take an id for a freshly constructed `JoltInterface`. Called by `PhysicsSystem`'s
     * constructor; every world owns exactly one interface and gives its id back in `destroy()`.
     */
    registerInterface(joltInterface: Jolt.JoltInterface): number {
        const id = nextInterfaceId++;
        interfaces.set(id, joltInterface);
        return id;
    },

    /** The `JoltInterface` for `id`, or undefined once that world has been destroyed. */
    getInterface(id: number): Jolt.JoltInterface | undefined {
        return interfaces.get(id);
    },

    /**
     * Drop `id` from the registry. Frees nothing: the caller destroys the interface itself,
     * this only releases the slot.
     *
     * @returns true when `id` was registered
     */
    releaseInterface(id: number): boolean {
        return interfaces.delete(id);
    },

    /** How many physics worlds are live right now. */
    get interfaceCount(): number {
        return interfaces.size;
    },

    /** Every live interface id, oldest first. Mostly useful for debugging and tests. */
    liveInterfaceIds(): number[] {
        return [...interfaces.keys()];
    }
};

/**
 * @deprecated renamed to {@link JoltModule} (issue #35). This is the same object, kept as an
 * alias so existing `Raw.module` / `Raw.free()` code keeps working.
 */
export const Raw = JoltModule;

/**
 * The jolt-physics module, guaranteed non-null.
 *
 * @throws if `initJolt()` has not resolved yet - i.e. if this is called outside a `<Physics>`
 * tree, or before awaiting `initJolt()` in non-React code.
 */
export const getJoltModule = (): typeof Jolt => {
    if (!JoltModule.module)
        throw new Error(
            'r3/jolt: the jolt-physics module is not initialised. Await `initJolt()` first, or ' +
                'read it from inside a <Physics> tree (`useJolt().jolt`).'
        );
    return JoltModule.module;
};

/**
 * Destroy a WASM object you own. This is the documented way to free anything this library hands
 * back that is described as "owned by the caller" (`vec3.jolt()`, `vec3.rjolt()`, `quat.jolt()`,
 * settings objects, ...).
 *
 * Two rules, both of which this cannot check for you:
 * - **Never** free a value returned *by value* from Jolt (`Body.GetPosition()`,
 *   `Vec3.Normalized()`, `Shape.GetCenterOfMass()`, ...). Those are pointers to a single static
 *   temporary the binder owns.
 * - **Never** free the same object twice. Jolt does not throw on a double free, it silently
 *   frees memory that has already been handed out again.
 *
 * Shapes are the exception: they are reference counted, so use `releaseShape()` instead.
 */
export const free = (value: unknown) => {
    JoltModule.module.destroy(value);
};

// The factory currently backing `JoltModule.module` (undefined when it was loaded via the
// bundled default). Tracked so a repeat call with the *same* factory - `suspend-react`
// re-running, StrictMode's double-invoke, a hot reload - is recognised as a no-op instead of a
// fresh module swap, and so a call with a *different* factory can be told apart from that.
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
 * Swapping to a **different** module while a Physics world already exists
 * (`JoltModule.interfaceCount > 0`) is refused: every body, shape and constraint the live world
 * owns points into the old module's WASM heap, and there is no way to migrate them to a new one.
 * The old behaviour here (`delete Raw.module` and reinitialise) silently stranded that heap with
 * no way to free it and left every live handle dangling. Instead this warns via `devWarn` and
 * keeps the active module - call `initJolt(otherModule)` before any `<Physics>` mounts (or after
 * every one has unmounted), not while one is running.
 */
export const initJolt = async (jolt?: () => Promise<typeof Jolt>) => {
    if (jolt) {
        if (JoltModule.module !== null) {
            if (jolt === activeFactory) return;
            if (JoltModule.interfaceCount > 0) {
                devWarn(
                    'initJolt: ignoring a different jolt-physics module because a Physics world already ' +
                        'exists. Select the module before mounting the first <Physics>, or unmount every ' +
                        'world first - reusing the module that is already active.'
                );
                return;
            }
        }
        activeFactory = jolt;
        JoltModule.module = await jolt();
    } else {
        if (JoltModule.module !== null) return;
        activeFactory = undefined;
        const joltInit = await import('jolt-physics');
        JoltModule.module = await joltInit.default();
    }
};
