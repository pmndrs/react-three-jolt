import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import path from 'path';
import filesize from 'rollup-plugin-filesize';

const external = [
    'jolt-physics',
    '@react-three/fiber',
    '@react-three/drei',
    'three',
    'react',
    'react-dom'
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
        onwarn: function (warning, warn) {
            if (warning.code === 'EVAL') return;
            warn(warning);
        }
    }
];
