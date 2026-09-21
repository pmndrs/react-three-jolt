// This is the core component that manages and stores the simulation

import type Jolt from 'jolt-physics';
// to clear weird TS error
import React, {
    FC,
    ReactNode,
    //  ReactNode,
    useCallback,
    useEffect,
    //useMemo,
    useId,
    // useRef,
    useState
} from 'react';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import * as THREE from 'three';
import { JoltContext, joltContext } from '../context';
import { useMount, useUnmount } from '../hooks';
import { initJolt, Raw } from '../raw';
// physics system import
import { PhysicsSystem } from '../systems/physics-system';
import type { AutoShape } from '../systems/shape-system';
// library imports
import { FrameStepper } from './FrameStepper';

// TODO: Move this to a better place
declare module 'three' {
    interface Mesh {
        shape: string;
        ignore: boolean;
    }
}

// stepping state object
export interface SteppingState {
    accumulator: number;
    previousState: Map<
        Jolt.Body,
        {
            position: THREE.Vector3;
            quaternion: THREE.Quaternion;
        }
    >;
}

// Jolt's own default. Module level so the default prop value keeps a stable identity across
// renders and doesn't retrigger the gravity effect.
const DEFAULT_GRAVITY: [number, number, number] = [0, -9.81, 0];

// Core component
export type PhysicsProps = {
    children: ReactNode;

    /**
     * World gravity. A tuple or `THREE.Vector3` is used as-is; a plain number is read as a
     * downward magnitude, so `gravity={20}` means `[0, -20, 0]`.
     * Reactive: changing it calls `physicsSystem.setGravity` at runtime.
     * @default [0, -9.81, 0]
     */
    gravity?: number | number[] | THREE.Vector3;

    /**
     * Stop stepping the simulation. Rendering and the frame loop carry on, so the scene stays
     * interactive and unpausing resumes from exactly where it stopped.
     * @default false
     */
    paused?: boolean;

    /**
     * Smooth the three.js objects between physics steps instead of snapping them to the most
     * recent one. Removes the stutter you get when the render rate isn't a multiple of the
     * physics rate. Ignored when `timeStep="vary"`, since then every step lands on a frame.
     * @default true
     */
    interpolate?: boolean;

    /**
     * Length of one physics step in seconds, or `"vary"` to step with the render delta
     * instead (clamped to 0.5s, 1-2 substeps). A fixed step is what makes the simulation
     * reproducible; `"vary"` trades that for never falling behind.
     * @default 1 / 60
     */
    timeStep?: number | 'vary';

    /**
     * Most fixed steps one frame may run. Simulation time beyond `maxSubSteps * timeStep` is
     * dropped instead of queued, so a long frame (backgrounded tab, debugger pause) can't
     * snowball into an ever growing backlog. Ignored when `timeStep="vary"`.
     * @default 5
     */
    maxSubSteps?: number;

    /**
     * `useFrame` priority for the physics step, passed straight through. Non-zero takes over
     * r3f's render loop, so you then own rendering — see the r3f docs on `useFrame` priority.
     * Only applies when `updateLoop="follow"`.
     * @default 0
     */
    updatePriority?: number;

    /**
     * `"follow"` steps from r3f's `useFrame` (in sync with rendering, respects `updatePriority`);
     * `"independent"` steps from its own `requestAnimationFrame` loop.
     * @default 'follow'
     */
    updateLoop?: 'follow' | 'independent';

    /** Log lifecycle info and warn when simulation time is dropped. @default false */
    debug?: boolean;

    /**
     * Jolt `BodyCreationSettings` merged into every body created by this world.
     * Applied before any body exists, so it also covers the first frame.
     */
    defaultBodySettings?: any;

    /**
     * Collision shape used for bodies that don't specify one, instead of the per geometry
     * autodetect. `<Physics defaultShape="box">` is the Jolt equivalent of rapier's `colliders`.
     */
    defaultShape?: AutoShape;

    /** A jolt-physics module (or a path to one) to initialise instead of the bundled default. */
    module?: any;
};

export const Physics: FC<PhysicsProps> = (props) => {
    const {
        children,
        gravity = DEFAULT_GRAVITY,
        paused = false,
        interpolate = true,
        timeStep = 1 / 60,
        maxSubSteps = 5,
        debug = false,
        updatePriority,
        updateLoop = 'follow',
        defaultBodySettings,
        defaultShape,

        //possible module or path?
        module
    } = props;

    // =================================================
    //* Module initialization
    //if the user passed a module path try to load it
    if (module) {
        suspend(() => initJolt(module), ['jolt', module]);
    } else {
        suspend(() => initJolt(), ['jolt']);
    }
    // =================================================
    const jolt = Raw.module;
    const pid = useId();

    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem>();
    const [contextApi, setContextApi] = useState<JoltContext>();

    useMount(() => {
        if (debug) console.log('** Physics Component: ' + pid + ' Mounted **');
        const ps = new PhysicsSystem(pid);
        // these have to be set here to catch bodies created on the very first render
        if (defaultBodySettings) ps.bodySystem.defaultBodySettings = defaultBodySettings;
        if (defaultShape) ps.bodySystem.defaultShape = defaultShape;
        ps.debug = debug;
        ps.paused = paused;
        ps.interpolate = interpolate;
        ps.timeStep = timeStep;
        ps.maxSubSteps = maxSubSteps;
        setPhysicsSystem(ps);
    });

    // setup the step
    const step = useCallback(
        (dt: number) => {
            // TODO: does running a conditional cause a performance hit?
            if (physicsSystem) physicsSystem.onUpdate(dt);
        },
        [physicsSystem]
    );
    // cleanup and destruction of system when component unmounts
    useUnmount(() => {
        if (physicsSystem) physicsSystem.destroy(pid);
    });

    // These will be effects for props to send to the correct systems

    // Gravity is the one prop that can arrive as a fresh object every render (`gravity={[0,-9,0]}`
    // is a new array each time), so depend on its *values* rather than its identity, otherwise
    // every parent render would allocate and free a Jolt vector.
    const gravityKey = Array.isArray(gravity)
        ? gravity.join(',')
        : typeof gravity === 'number'
          ? String(gravity)
          : `${gravity.x},${gravity.y},${gravity.z}`;
    useEffect(() => {
        if (!physicsSystem) return;
        //@ts-ignore number[] vs the tuple/vector union
        physicsSystem.setGravity(gravity);
        // biome-ignore lint/correctness/useExhaustiveDependencies: gravityKey stands in for the value of gravity
    }, [gravityKey, physicsSystem]);

    // Scalar simulation props. Each is written straight through so it takes effect on the very
    // next frame; none of them need the system to be rebuilt.
    useEffect(() => {
        if (physicsSystem) physicsSystem.paused = paused;
    }, [paused, physicsSystem]);
    useEffect(() => {
        if (physicsSystem) physicsSystem.interpolate = interpolate;
    }, [interpolate, physicsSystem]);
    useEffect(() => {
        if (physicsSystem) physicsSystem.timeStep = timeStep;
    }, [timeStep, physicsSystem]);
    useEffect(() => {
        if (physicsSystem) physicsSystem.maxSubSteps = maxSubSteps;
    }, [maxSubSteps, physicsSystem]);
    useEffect(() => {
        if (physicsSystem) physicsSystem.debug = debug;
    }, [debug, physicsSystem]);
    useEffect(() => {
        if (physicsSystem) physicsSystem.bodySystem.defaultShape = defaultShape;
    }, [defaultShape, physicsSystem]);
    useEffect(() => {
        if (physicsSystem && defaultBodySettings)
            physicsSystem.bodySystem.defaultBodySettings = defaultBodySettings;
    }, [defaultBodySettings, physicsSystem]);

    // set the context
    useEffect(() => {
        if (!physicsSystem) return;
        setContextApi({
            jolt,
            physicsSystem,
            bodySystem: physicsSystem.bodySystem,
            joltInterface: physicsSystem.joltInterface,
            paused,
            debug,
            step
        });
    }, [debug, jolt, paused, physicsSystem, step]);

    if (!contextApi || !contextApi.physicsSystem) return null;

    return (
        <joltContext.Provider value={contextApi}>
            <FrameStepper type={updateLoop} onStep={step} updatePriority={updatePriority} />
            {children}
        </joltContext.Provider>
    );
};
