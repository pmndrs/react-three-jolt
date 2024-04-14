import Jolt from 'jolt-physics';
import { createContext } from 'react';
import type { BodySystem } from './systems/body-system';
import type { PhysicsSystem } from './systems/physics-system';

export type JoltContext = {
    jolt: typeof Jolt;
    physicsSystem: PhysicsSystem;
    bodySystem: BodySystem;
    joltInterface: Jolt.JoltInterface;
    paused: boolean;
    debug: boolean;
    step: (dt: number) => void;
};

export const joltContext = createContext<JoltContext>(null!);
