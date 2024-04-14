import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import path from 'path';
import filesize from 'rollup-plugin-filesize';

export default [
    {
        input: `./src/index.ts`,
        external: ['@react-three/fiber', 'three', 'react', 'react-dom', 'jolt-physics'],
        inlineDynamicImports: true, // Add this line
        output: [
            {
                file: `dist/index.mjs`,
                //dir: 'dist',
                format: 'es',
                sourcemap: true,
                exports: 'named'
            },
            {
                file: `dist/index.cjs`,
                //dir: 'dist',
                format: 'cjs',
                sourcemap: true,
                exports: 'named'
            }
        ],
        plugins: [
            terser(),
            nodeResolve(),
            commonjs(),
            typescript({
                tsconfig: path.resolve(`tsconfig.json`),
                sourceMap: true,
                inlineSources: true
            }),
            filesize()
        ],
        // disable three-stdlib eval warning for now
        onwarn: function (warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
        }
    }
];
