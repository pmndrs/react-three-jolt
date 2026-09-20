import { readFileSync } from 'node:fs';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import path from 'path';
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

export default [
    {
        input: `./src/index.ts`,
        external,
        output: [
            {
                file: `dist/index.mjs`,
                format: 'es',
                sourcemap: true,
                exports: 'named'
            },
            {
                file: `dist/index.cjs`,
                format: 'cjs',
                sourcemap: true,
                exports: 'named'
            }
        ],
        plugins: [
            nodeResolve(),
            commonjs(),
            typescript({
                tsconfig: path.resolve('tsconfig.json')
            }),
            filesize()
        ],
        // disable three-stdlib eval warning for now
        onwarn: (warning, warn) => {
            if (warning.code === 'EVAL') return;
            warn(warning);
        }
    }
];
