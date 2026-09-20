// Allocation tracking for the Jolt WASM heap.
//
// embind gives us no way to ask "how many objects are alive?", and destroying an object twice
// does *not* throw - it silently frees memory a second time, which is why the `vec3.jolt()`
// passthrough of issue #76 showed up as unrelated out of bounds errors much later. This wraps
// `Raw.module` in a Proxy so tests can count live objects and turn a double free into a loud,
// immediate failure.
//
// Usage:
//   const alloc = installAllocTracker(Raw);   // after initJolt()
//   const before = alloc.live();
//   ...code under test...
//   expect(alloc.live()).toBe(before);
//   alloc.uninstall();
//
// `raw` is passed in rather than imported so the same helper works for the controllers package,
// which talks to the built `@react-three/jolt` bundle and therefore a different `Raw` object.
//
// Only `new Jolt.X()` is an allocation. jolt-physics is built with emscripten's WebIDL binder,
// where a C++ function returning "by value" hands back a pointer to a single static temporary
// per function: `Jolt.RMat44.prototype.sRotationTranslation()` returns the same address every
// time, the previous result is overwritten, and destroying it frees memory the binder owns.
// Those never appear in `live()`, and destroying one shows up in `foreignDestroys()`.

export type RawHolder = { module: any };

export type AllocTracker = {
    /** Number of tracked objects currently alive. */
    live(): number;
    /** Live counts broken down by constructor name. */
    liveByType(): Record<string, number>;
    /** Every tracked object still alive, newest last. */
    liveDetails(): { type: string; ptr: number }[];
    /** Objects constructed through the tracker since it was installed. */
    allocated(): number;
    /** `destroy()` calls the tracker has seen. */
    destroyed(): number;
    /** Destroys of pointers the tracker never allocated (value returns from Jolt, mostly). */
    foreignDestroys(): number;
    /** Restore the untracked module. */
    uninstall(): void;
};

// The value types that show up in the per-frame paths. Keeping the list small matters: every
// name here is handed to callers as a Proxy instead of the real constructor, and embind helpers
// such as `castObject` want the genuine article.
export const DEFAULT_TRACKED_TYPES = ['Vec3', 'RVec3', 'Quat', 'Mat44', 'RMat44'];

export type AllocTrackerOptions = {
    /** Constructor names to intercept. Defaults to {@link DEFAULT_TRACKED_TYPES}. */
    types?: string[];
    /**
     * Throw when the same wrapper object is destroyed twice (default true). This is exactly the
     * shape of the #76 bug: a helper hands back the caller's object, the caller frees it, and
     * then the real owner frees it again.
     */
    throwOnDoubleDestroy?: boolean;
};

export function installAllocTracker(
    raw: RawHolder,
    options: AllocTrackerOptions = {}
): AllocTracker {
    const { types = DEFAULT_TRACKED_TYPES, throwOnDoubleDestroy = true } = options;

    const target = raw.module;
    if (!target) throw new Error('installAllocTracker: Jolt module is not initialised yet');

    const live = new Map<number, { type: string; obj: unknown }>();
    // wrapper identity, so a double free is caught without guessing about pointer reuse
    const destroyedObjects = new WeakSet<object>();
    const constructorProxies = new Map<string, unknown>();
    let allocatedCount = 0;
    let destroyedCount = 0;
    let foreignCount = 0;

    const pointerOf = (obj: unknown): number => {
        try {
            return target.getPointer(obj);
        } catch {
            return -1;
        }
    };

    const track = <T>(name: string, obj: T): T => {
        const ptr = pointerOf(obj);
        if (ptr > 0) {
            live.set(ptr, { type: name, obj });
            allocatedCount++;
        }
        return obj;
    };

    const trackedConstructor = (name: string) => {
        const existing = constructorProxies.get(name);
        if (existing) return existing;
        const ctor = target[name];
        if (typeof ctor !== 'function') return ctor;
        const proxy = new Proxy(ctor, {
            construct(ctorTarget: any, args: any[]) {
                return track(name, new ctorTarget(...args)) as object;
            }
        });
        constructorProxies.set(name, proxy);
        return proxy;
    };

    const trackedDestroy = (obj: unknown) => {
        if (obj && typeof obj === 'object') {
            if (destroyedObjects.has(obj as object)) {
                const ptr = pointerOf(obj);
                if (throwOnDoubleDestroy)
                    throw new Error(
                        `double destroy: this wrapper (ptr ${ptr}) was already destroyed. ` +
                            'Something freed an object it does not own - see issue #76.'
                    );
            }
            destroyedObjects.add(obj as object);
        }
        const ptr = pointerOf(obj);
        const entry = ptr > 0 ? live.get(ptr) : undefined;
        if (entry && entry.obj === obj) live.delete(ptr);
        else foreignCount++;
        destroyedCount++;
        return target.destroy(obj);
    };

    const proxy = new Proxy(target, {
        get(moduleTarget: any, prop: string | symbol, receiver: unknown) {
            if (prop === 'destroy') return trackedDestroy;
            if (typeof prop === 'string' && types.includes(prop)) return trackedConstructor(prop);
            return Reflect.get(moduleTarget, prop, receiver);
        }
    });

    raw.module = proxy;

    return {
        live: () => live.size,
        liveByType: () => {
            const counts: Record<string, number> = {};
            for (const { type } of live.values()) counts[type] = (counts[type] ?? 0) + 1;
            return counts;
        },
        liveDetails: () => [...live.entries()].map(([ptr, { type }]) => ({ type, ptr })),
        allocated: () => allocatedCount,
        destroyed: () => destroyedCount,
        foreignDestroys: () => foreignCount,
        uninstall: () => {
            raw.module = target;
        }
    };
}
