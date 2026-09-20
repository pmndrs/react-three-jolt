// Selects which jolt-physics WASM build the whole app boots with (issue #22 / #54). This is the
// piece that actually exercises `<Physics module={...}>` against real jolt-physics 1.1.0
// entrypoints instead of always taking the bundled default.
//
// The variant is read once from the `?jolt=` query param at module load and never changes at
// runtime without a full page reload (see `setVariantInLocation`) - `initJolt` refuses to swap
// to a different module while a Physics world exists (see raw.ts), and every demo route mounts
// and unmounts its own world as you navigate, so there is no safe moment to hot-swap mid-session
// anyway. A reload is simpler and matches how you'd actually pick a build for a real app: once,
// not per click.
import type Jolt from 'jolt-physics';
// Static `?url` import so Vite always emits `jolt-physics.wasm.wasm` as a built asset and gives us
// its real (possibly hashed) URL, regardless of which variant ends up selected - see README.md's
// "Choosing a jolt-physics build" section for the Next.js/webpack equivalent.
import wasmUrl from 'jolt-physics/jolt-physics.wasm.wasm?url';

export const JOLT_VARIANTS = ['wasm-compat', 'wasm', 'debug-wasm-compat'] as const;
export type JoltVariant = (typeof JOLT_VARIANTS)[number];

export const DEFAULT_JOLT_VARIANT: JoltVariant = 'wasm-compat';

type JoltFactory = () => Promise<typeof Jolt>;

// Each entry is the default export of its own jolt-physics 1.1.0 entrypoint, called exactly the
// way `initJolt()` calls the bundled default. Dynamic `import()` with a literal specifier keeps
// each variant in its own chunk, so picking one doesn't pull the others into the bundle.
const factories: Record<JoltVariant, JoltFactory> = {
    // Zero-config default: WASM embedded as base64 in the JS, so no extra asset to serve. ~3.5MB
    // vs `wasm`'s ~1.79MB per issue #22.
    'wasm-compat': () => import('jolt-physics/wasm-compat').then((m) => m.default()),
    // Smaller download, ships the WASM as its own file - which means something has to tell it
    // where that file is. `locateFile` is emscripten's hook for exactly that: it's called with
    // the file's default name and must return a URL to fetch it from. We hand back the URL Vite
    // resolved for us above.
    wasm: () =>
        import('jolt-physics/wasm').then((m) =>
            m.default({
                locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path)
            })
        ),
    // Same ABI as wasm-compat, built with asserts and the Jolt debug renderer turned on. See
    // `joltMemory.ts` for the one extra thing this build's `JoltInterface` is used for here.
    'debug-wasm-compat': () => import('jolt-physics/debug-wasm-compat').then((m) => m.default())
};

export function getJoltFactory(variant: JoltVariant): JoltFactory {
    return factories[variant] ?? factories[DEFAULT_JOLT_VARIANT];
}

export function isJoltVariant(value: string | null): value is JoltVariant {
    return !!value && (JOLT_VARIANTS as readonly string[]).includes(value);
}

export function readVariantFromLocation(): JoltVariant {
    if (typeof window === 'undefined') return DEFAULT_JOLT_VARIANT;
    const value = new URLSearchParams(window.location.search).get('jolt');
    return isJoltVariant(value) ? value : DEFAULT_JOLT_VARIANT;
}

// Updates `?jolt=` and reloads, so the app boots fresh with `Raw.module` unset and the newly
// selected factory becomes the first (and only) one `initJolt` ever sees this session.
export function setVariantInLocation(variant: JoltVariant): void {
    const url = new URL(window.location.href);
    if (variant === DEFAULT_JOLT_VARIANT) url.searchParams.delete('jolt');
    else url.searchParams.set('jolt', variant);
    window.location.href = url.toString();
}
