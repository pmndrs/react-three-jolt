// jolt-physics's wasm-compat/debug-wasm-compat builds `await import("node:module")` to get
// `createRequire` when they detect they are running under Node (they never do that check in a
// browser bundle, so this branch is dead code here) - see this file's use in vite.config.ts.
// A no-op stand-in is enough: it's aliased in so Vite never treats "node:module" as an
// unresolved Node builtin being pulled into a browser bundle, which stops the (harmless but
// noisy) "has been externalized for browser compatibility" warning at build/dev time.
export function createRequire(): (id: string) => never {
    return () => {
        throw new Error('createRequire() is not available in the browser');
    };
}
