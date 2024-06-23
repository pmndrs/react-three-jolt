// This is a helper to load and pass around the global Jolt object
// pulled from isaac-mason's sketch
// https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/raw.ts

import type Jolt from "jolt-physics";

export const Raw = { module: null! as typeof Jolt, joltInterfaces: new Map() };

export const free = (value: unknown) => {
	Raw.module.destroy(value);
};

export const initJolt = async (jolt?: typeof Jolt) => {
	if (jolt) {
		// this will let us overrite, however, it spins up new every time we do so

		// console.log("** Setting Raw to local Jolt **");
		if (Raw.module !== null) {
			// how can we destroy the old one?
			//@ts-ignore
			delete Raw.module;
		}
		Raw.module = await jolt();
	} else {
		if (Raw.module !== null) return;
		const joltInit = await import("jolt-physics");
		Raw.module = await joltInit.default();
	}
};
