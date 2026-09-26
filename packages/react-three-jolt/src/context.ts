import type Jolt from 'jolt-physics';
import { createContext } from 'react';
import type { BodySystem } from './systems/body-system';
import type { Emitter } from './systems/emitter';
import type { WorldEventMap } from './systems/events';
import type { PhysicsSystem } from './systems/physics-system';
import type { SoftBodySystem } from './systems/soft-body-system';

export type JoltContext = {
    jolt: typeof Jolt;
    physicsSystem: PhysicsSystem;
    bodySystem: BodySystem;
    softBodySystem: SoftBodySystem;
    joltInterface: Jolt.JoltInterface;
    /** World level events: `events.on("collisionEnter", fn)` returns the unsubscribe. */
    events: Emitter<WorldEventMap>;
    paused: boolean;
    debug: boolean;
    step: (dt: number) => void;
};

export const joltContext = createContext<JoltContext>(null!);
