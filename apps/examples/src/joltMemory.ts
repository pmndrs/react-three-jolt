// Issue #54: a small, always-visible number to watch while leak-hunting. jolt-physics 1.1.0's
// `JoltInterface` declares `sGetTotalMemory()` / `sGetFreeMemory()` in its `.d.ts` without a
// `static` modifier (the "s" prefix is Jolt's own C++ naming convention for static, not a
// TypeScript one) - checked at runtime against both `wasm-compat` and `debug-wasm-compat`
// (jolt-physics 1.1.0): they are bound as *instance* methods, callable on any live
// `JoltInterface`, and both report real, changing numbers on every build we tried, not only the
// debug one. `<JoltMemoryReadout>` still only displays them for `debug-wasm-compat`, per the
// issue's ask, since that's the build meant for this kind of profiling session; nothing here
// requires it.
import type Jolt from 'jolt-physics';

let active: Jolt.JoltInterface | null = null;

/** Called by `<JoltMemoryRegistrar>` (mounted inside `<Physics>`) on mount/unmount. */
export function registerActiveJoltInterface(joltInterface: Jolt.JoltInterface | null): void {
    active = joltInterface;
}

export type JoltMemoryReading = { totalBytes: number; freeBytes: number };

/** Snapshot of the currently active world's WASM heap, or `null` if none is mounted. */
export function readJoltMemory(): JoltMemoryReading | null {
    if (!active) return null;
    try {
        return {
            totalBytes: active.sGetTotalMemory(),
            freeBytes: active.sGetFreeMemory()
        };
    } catch {
        // Belt and braces: an older/other build without these bindings shouldn't crash the demo.
        return null;
    }
}
