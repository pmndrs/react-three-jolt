import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    server: {
        open: true
    },
    resolve: {
        alias: {
            // jolt-physics's wasm-compat/debug-wasm-compat builds do a Node-only
            // `await import("node:module")` (guarded at runtime - the branch only ever runs
            // under Node, never in this browser build) to look up the wasm file's directory.
            // Left alone, Vite/rolldown's resolver still treats it as a real Node builtin being
            // pulled into client code and prints a "has been externalized for browser
            // compatibility" warning on every dev start and build. Aliasing it to a tiny no-op
            // stub removes the dead code path from the resolver's view entirely, so the warning
            // never fires. See README.md's "Choosing a jolt-physics build" section and issue #22.
            'node:module': fileURLToPath(
                new URL('./src/shims/node-module-shim.ts', import.meta.url)
            )
        }
    },
    optimizeDeps: {
        // Also skip jolt-physics in the dev-server's esbuild pre-bundling pass, for the same
        // reason: it does its own scan independent of the `resolve.alias` above.
        exclude: ['jolt-physics']
    }
});
