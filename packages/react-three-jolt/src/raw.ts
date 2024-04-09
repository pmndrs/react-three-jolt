// This is a helper to load and pass around the global Jolt object
// pulled from isaac-mason's sketch
// https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/raw.ts

import type Jolt from 'jolt-physics';

export const Raw = { module: null! as typeof Jolt };

export const free = (value: unknown) => {
    Raw.module.destroy(value);
};

export const initJolt = async (jolt?: typeof Jolt) => {
    if (Raw.module !== null) return;

    if (jolt) {
        Raw.module = await jolt();
    } else {
        const joltInit = await import('jolt-physics');
        // debug module
        //const joltInit = await import('../jolt/jolt-physics.wasm-compat.js');
        console.log('*** JOLT IMPORT SUCESSFUL ***');
        Raw.module = await joltInit.default();
        console.log('*** JOLT INIT SUCESSFUL ***');
    }
};
