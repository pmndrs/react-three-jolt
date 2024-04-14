// This is a helper to load and pass around the global Jolt object
// pulled from isaac-mason's sketch
// https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/raw.ts

import type Jolt from 'jolt-physics';

export const Raw = { module: null! as typeof Jolt, joltInterfaces: new Map() };

export const free = (value: unknown) => {
    Raw.module.destroy(value);
};

export const initJolt = async (jolt?: typeof Jolt) => {
    if (Raw.module !== null) return;

    if (jolt) {
        console.log('** Setting Raw to local Jolt **');
        Raw.module = await jolt();
    } else {
        const joltInit = await import('jolt-physics');
        Raw.module = await joltInit.default();
    }
};
