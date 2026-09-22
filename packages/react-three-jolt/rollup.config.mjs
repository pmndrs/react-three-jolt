import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import filesize from 'rollup-plugin-filesize';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const root = path.dirname(fileURLToPath(import.meta.url));

// externalize everything this package declares as a dependency or peerDependency,
// plus subpath imports of three/jolt-physics (e.g. three/addons/*, jolt-physics/wasm-compat),
// so nothing gets bundled into dist by accident when a new import is added.
const external = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    /^three\//,
    /^jolt-physics\//
];

/**
 * The package's entry points. `addons` and `controllers` are subpath exports
 * (`@react-three/jolt/controllers`) rather than separate packages: they were always released as
 * one unit, and core is a module level singleton that must never be duplicated in a dependency
 * tree - see the note on `JoltModule` in src/raw.ts.
 *
 * Each gets its own bundle, so importing the root pulls no controller or addon code.
 */
const entries = [
    { name: 'index', input: './src/index.ts', types: './dist/types/index.d.ts' },
    { name: 'addons', input: './src/addons/index.ts', types: './dist/types/addons/index.d.ts' },
    {
        name: 'controllers',
        input: './src/controllers/index.ts',
        types: './dist/types/controllers/index.d.ts'
    }
];

const ENTRY_MODULE = {
    core: path.join(root, 'src/index.ts'),
    addons: path.join(root, 'src/addons/index.ts')
};

/**
 * `addons` and `controllers` reach core through a relative import (`../../index`), because they
 * live in the same source tree. Left alone, rollup would inline core into each of them - three
 * copies of the `Raw` singleton in one published package, which is exactly the failure the
 * single-package layout exists to prevent.
 *
 * Resolving those relative imports to the *published* bare specifier instead, and marking them
 * external, means `dist/controllers.mjs` imports `@react-three/jolt` the same way a consumer
 * would. Returning a bare id here (rather than externalising the file path and rewriting it with
 * `output.paths`) matters: rollup treats a rewritten file path as relative and emits
 * `./@react-three/jolt`, which resolves to nothing.
 */
function externalSiblings(name) {
    return {
        name: 'external-siblings',
        resolveId(source, importer) {
            if (!importer) return null;
            let resolved = path.resolve(path.dirname(importer), source);
            if (!path.extname(resolved)) resolved += '.ts';

            if (name !== 'index' && resolved === ENTRY_MODULE.core) {
                return { id: pkg.name, external: true };
            }
            if (name === 'controllers' && resolved === ENTRY_MODULE.addons) {
                return { id: `${pkg.name}/addons`, external: true };
            }
            return null;
        }
    };
}

// JS bundle: esbuild only transpiles (no type checking - that's `tsc --noEmit`'s job in the
// `build` script), which is why this no longer needs the TypeScript compiler API and can adopt
// TypeScript 7 / tsgo for typechecking independently of what rollup uses to emit JS.
const jsBundle = ({ name, input }) => ({
    input,
    external,
    output: [
        {
            file: `dist/${name}.mjs`,
            format: 'es',
            sourcemap: true,
            exports: 'named'
        },
        {
            file: `dist/${name}.cjs`,
            format: 'cjs',
            sourcemap: true,
            exports: 'named'
        }
    ],
    plugins: [
        externalSiblings(name),
        nodeResolve(),
        commonjs(),
        esbuild({
            target: 'es2022',
            tsconfig: 'tsconfig.json'
        }),
        filesize()
    ],
    // disable three-stdlib eval warning for now
    onwarn: (warning, warn) => {
        if (warning.code === 'EVAL') return;
        warn(warning);
    }
});

// Declaration bundle: reads the per-file `.d.ts` output that `tsc -p tsconfig.build.json`
// produces in dist/types (see the `build` script) and rolls it up into single files, one per
// module condition. This is what stops per-file extensionless relative imports from mattering
// for the "masquerading as CJS" attw check - there's only ever one declaration file per condition.
//
// The declarations deliberately do *not* externalise the siblings: a `.d.ts` carries no runtime
// weight, and inlining core's types into `controllers.d.ts` keeps each entry point's types
// self-contained rather than making consumers' resolvers walk back through the package.
const dtsBundle = ({ name, types }) => ({
    input: types,
    external,
    output: [
        { file: `dist/${name}.d.ts`, format: 'es' },
        { file: `dist/${name}.d.mts`, format: 'es' },
        { file: `dist/${name}.d.cts`, format: 'es' }
    ],
    plugins: [dts()]
});

export default [...entries.map(jsBundle), ...entries.map(dtsBundle)];
