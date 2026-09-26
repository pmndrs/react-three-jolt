// This is the core component that manages and stores the simulation

import type Jolt from 'jolt-physics';
// to clear weird TS error
import React, {
    type ReactNode,
    //  ReactNode,
    useCallback,
    useEffect,
    //useMemo,
    useId,
    useRef,
    useState
} from 'react';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import * as THREE from 'three';
import { JoltContext, joltContext } from '../context';
import { useSystemEvent } from '../hooks';
import { initJolt, Raw } from '../raw';
import type { DefaultBodySettings } from '../systems/body-system';
import type { WorldEventMap } from '../systems/events';
// physics system import
import { deferWorldDestroy, PhysicsSystem } from '../systems/physics-system';
import type { AutoShape, DynamicMeshStrategy } from '../systems/shape-system';
// library imports
import { Debug } from './Debug';
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
    /** Optional so `createElement(Physics, props, ...children)` typechecks as JSX does. */
    children?: ReactNode;

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

    /**
     * Draw a wireframe of every collider in the world, coloured by motion type (#158), and log
     * lifecycle info / warn when simulation time is dropped. Toggling it on for a running scene
     * backfills the existing bodies; toggling it off removes every wireframe and all of the
     * per-frame work with them. Mount `<Debug>` yourself for the overlay's own options.
     * @default false
     */
    debug?: boolean;

    /**
     * Jolt `BodyCreationSettings` merged into every body created by this world.
     * Applied before any body exists, so it also covers the first frame.
     */
    defaultBodySettings?: DefaultBodySettings;

    /**
     * Collision shape used for bodies that don't specify one, instead of the per geometry
     * autodetect. `<Physics defaultShape="box">` is the Jolt equivalent of rapier's `colliders`.
     */
    defaultShape?: AutoShape;

    /**
     * World wide fallback for `<RigidBody dynamicMeshStrategy>` (issue #211): what a dynamic
     * body does with a trimesh shape when it doesn't say for itself. Left out, an unconverted
     * trimesh warns and becomes a convex hull (`'convex'`); `'error'` throws instead, so the
     * mistake is loud; `'decompose'` is reserved and currently throws with an explanation.
     */
    defaultDynamicMeshStrategy?: DynamicMeshStrategy;

    /** A jolt-physics module factory to initialise instead of the bundled default. */
    module?: () => Promise<typeof Jolt>;

    //* World events ----------------------------------------
    // Jolt's contact listener is global, so these are the *cheap* path: one dispatch per pair,
    // where the per body `<RigidBody on*>` props are the fan-out. `target` is the body with the
    // lower handle, so a world wide counter is right without dividing by two.
    /** Any two bodies started touching. Fires once per pair. */
    onCollisionEnter?: WorldEventMap['collisionEnter'];
    /** Any two bodies stopped touching. Fires once per pair. */
    onCollisionExit?: WorldEventMap['collisionExit'];
    /** Any two bodies are still touching. Fires once per pair, per step. */
    onCollisionPersist?: WorldEventMap['collisionPersist'];
    /** Anything started overlapping any sensor. */
    onSensorEnter?: WorldEventMap['sensorEnter'];
    /** Anything stopped overlapping any sensor. */
    onSensorExit?: WorldEventMap['sensorExit'];
    /** Rapier compatible alias for {@link onSensorEnter}. */
    onIntersectionEnter?: WorldEventMap['sensorEnter'];
    /** Rapier compatible alias for {@link onSensorExit}. */
    onIntersectionExit?: WorldEventMap['sensorExit'];
    /** Any body was deactivated by Jolt's sleeping logic. */
    onSleep?: WorldEventMap['sleep'];
    /** Any body was activated. */
    onWake?: WorldEventMap['wake'];
    /**
     * Every simulated body has gone to sleep: the world has stopped moving. Edge triggered off
     * a count the activation listener maintains, so it costs one comparison per step rather
     * than a per-frame scan.
     */
    onSettled?: WorldEventMap['settled'];
    /** The number of awake bodies changed. `(active, total)`. */
    onActivityChange?: WorldEventMap['activityChange'];
};

// React 19 native convention (#49): a plain function component, no `React.FC` annotation.
export function Physics(props: PhysicsProps) {
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
        defaultDynamicMeshStrategy,

        onCollisionEnter,
        onCollisionExit,
        onCollisionPersist,
        onSensorEnter,
        onSensorExit,
        onIntersectionEnter,
        onIntersectionExit,
        onSleep,
        onWake,
        onSettled,
        onActivityChange,

        //possible module or path?
        module
    } = props;

    // =================================================
    //* Module initialization
    // One unconditional `suspend` call, keyed on the module (issue #137). Branching the hook
    // itself on `module` being defined changed the number of hooks between renders the moment
    // the prop was toggled, which React rejects outright.
    suspend(() => (module ? initJolt(module) : initJolt()), ['jolt', module ?? 'default']);
    // =================================================
    const jolt = Raw.module;
    const pid = useId();

    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem>();
    const [contextApi, setContextApi] = useState<JoltContext>();

    // The world this component is currently using. A ref as well as state, because the unmount
    // cleanup below runs after the commit and needs to know which world is live *now*, not which
    // one the closure that registered the cleanup was rendered with.
    const liveSystem = useRef<PhysicsSystem | undefined>(undefined);

    // #57: was `useMount` - a plain `useEffect` with `[]` deps runs exactly once per mount, same
    // as the old hook, without the extra indirection.
    useEffect(() => {
        if (debug) console.log('** Physics Component: ' + pid + ' Mounted **');
        const ps = new PhysicsSystem(pid);
        // these have to be set here to catch bodies created on the very first render
        if (defaultBodySettings) ps.bodySystem.defaultBodySettings = defaultBodySettings;
        if (defaultShape) ps.bodySystem.defaultShape = defaultShape;
        if (defaultDynamicMeshStrategy)
            ps.bodySystem.defaultDynamicMeshStrategy = defaultDynamicMeshStrategy;
        ps.debug = debug;
        ps.paused = paused;
        ps.interpolate = interpolate;
        ps.timeStep = timeStep;
        ps.maxSubSteps = maxSubSteps;
        liveSystem.current = ps;
        setPhysicsSystem(ps);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, deliberately not reactive - every prop read here is applied once, at construction; later prop changes are each their own effect below.
    }, []);

    // setup the step
    const step = useCallback(
        (dt: number) => {
            // TODO: does running a conditional cause a performance hit?
            if (physicsSystem) physicsSystem.onUpdate(dt);
        },
        [physicsSystem]
    );
    // Cleanup and destruction of the world when the component unmounts.
    //
    // React runs a parent's effect cleanup BEFORE its children's, so destroying the world here
    // and now would free the JoltInterface while every `<RigidBody>`, `useConstraint` and
    // controller underneath still has its own cleanup to run - they would all be cleaning up
    // against a dead world (issue #162). Deferring to a microtask puts the teardown after the
    // whole commit, so the children tear themselves down first, against a world that is still
    // alive, and `PhysicsSystem.destroy()` then finds (and frees) only what is genuinely left.
    //
    // StrictMode's mount -> unmount -> mount happens inside that window, so the callback checks
    // that the world it captured is still the one in use. It never is after a remount (the
    // second mount builds a fresh `PhysicsSystem`), which is exactly right: the captured world
    // really is orphaned and really should be freed. The check is what stops a future change
    // that *reuses* the world across a remount from killing the live one.
    useEffect(() => {
        return () => {
            const dying = liveSystem.current;
            if (!dying) return;
            if (debug) console.log('** Physics Component: ' + pid + ' Unmounted **');
            // clear it first: a remount inside the deferral window puts its own world back here,
            // and that - not this one - is the world that must survive.
            liveSystem.current = undefined;
            deferWorldDestroy(() => {
                if (liveSystem.current === dying) return;
                dying.destroy();
            });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only teardown - see the comment above.
    }, []);

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
        physicsSystem.setGravity(gravity);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- gravityKey stands in for the value of gravity
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
    useEffect(() => {
        if (physicsSystem)
            physicsSystem.bodySystem.defaultDynamicMeshStrategy = defaultDynamicMeshStrategy;
    }, [defaultDynamicMeshStrategy, physicsSystem]);

    //* World events ------------------------------------
    // Each of these is an effect whose cleanup is the unsubscribe; handler identity is not a
    // dependency, so inline arrows do not resubscribe on every render.
    useSystemEvent(physicsSystem, 'collisionEnter', onCollisionEnter);
    useSystemEvent(physicsSystem, 'collisionExit', onCollisionExit);
    useSystemEvent(physicsSystem, 'collisionPersist', onCollisionPersist);
    useSystemEvent(physicsSystem, 'sensorEnter', onSensorEnter ?? onIntersectionEnter);
    useSystemEvent(physicsSystem, 'sensorExit', onSensorExit ?? onIntersectionExit);
    useSystemEvent(physicsSystem, 'sleep', onSleep);
    useSystemEvent(physicsSystem, 'wake', onWake);
    useSystemEvent(physicsSystem, 'settled', onSettled);
    useSystemEvent(physicsSystem, 'activityChange', onActivityChange);

    // set the context
    useEffect(() => {
        if (!physicsSystem) return;
        setContextApi({
            jolt,
            physicsSystem,
            bodySystem: physicsSystem.bodySystem,
            joltInterface: physicsSystem.joltInterface,
            events: physicsSystem.events,
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
            {/* The wireframe collider overlay (#158). Rendered after the stepper so its
                `useFrame` subscription is made second and it draws the poses of the step that
                just ran; mounting it is the only cost `debug` adds to the frame loop. */}
            {debug && <Debug />}
        </joltContext.Provider>
    );
}
