import { defineConfig } from 'vitest/config';

// Prefer the `module` (esm) entry of every dependency. Vite's node/ssr resolver otherwise picks
// `main` for packages without an `exports` map and those cjs builds `require('three')`, which
// resolves to three's cjs build while our own sources get three's esm build. Two copies of three
// make `instanceof Object3D` fail on the very scene graph r3f just built for us.
const mainFields = ['module', 'jsnext:main', 'jsnext', 'main'];

export default defineConfig({
    resolve: { mainFields },
    ssr: { resolve: { mainFields } },
    test: {
        environment: 'happy-dom',
        setupFiles: ['./test/setup.ts'],
        // `*.test-d.ts` files assert on types only; the hooks' public signatures are part of
        // their contract (see #78), so they are checked on every run.
        typecheck: {
            enabled: true
        },
        server: {
            deps: {
                // drei is esm but pulls in cjs-only deps (detect-gpu); node's named-export
                // detection gives up on those, vite's interop does not.
                inline: [/@react-three\/drei/]
            }
        }
    }
});
