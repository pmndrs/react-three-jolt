import { readFileSync } from 'node:fs';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import filesize from 'rollup-plugin-filesize';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// externalize everything this package declares as a dependency or peerDependency,
// plus subpath imports of three/jolt-physics (e.g. three/addons/*, jolt-physics/wasm-compat),
// so nothing gets bundled into dist by accident when a new import is added.
const external = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    /^three\//,
    /^jolt-physics\//
];

// JS bundle: esbuild only transpiles (no type checking - that's `tsc --noEmit`'s job in the
// `build` script), which is why this no longer needs the TypeScript compiler API and can adopt
// TypeScript 7 / tsgo for typechecking independently of what rollup uses to emit JS.
const jsBundle = {
    input: `./src/index.ts`,
    external,
    output: [
        {
            file: 'dist/index.mjs',
            format: 'es',
            sourcemap: true,
            exports: 'named'
        },
        {
            file: 'dist/index.cjs',
            format: 'cjs',
            sourcemap: true,
            exports: 'named'
        }
    ],
    plugins: [
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
};

// Declaration bundle: reads the per-file `.d.ts` output that `tsc -p tsconfig.build.json`
// produces in dist/types (see the `build` script) and rolls it up into single files, one per
// module condition. This is what stops per-file extensionless relative imports from mattering
// for the "masquerading as CJS" attw check - there's only ever one declaration file per condition.
const dtsBundle = {
    input: './dist/types/index.d.ts',
    external,
    output: [
        { file: 'dist/index.d.ts', format: 'es' },
        { file: 'dist/index.d.mts', format: 'es' },
        { file: 'dist/index.d.cts', format: 'es' }
    ],
    plugins: [dts()]
};

export default [jsBundle, dtsBundle];
