/* System may not be the correct name as this isn't a part of a ECS
However that will fit better with isaac-mason's sketch
*/
/* The intent of this class is a wrapper around the core physics actions
outside of the react context and limitations. 
we'll expose various parts of the system through the physics component and context 8?
*/

// First version based on isaac-mason's sketch, removing the ECS
// This is the core component that manages and stores the simulation
import { invalidate } from '@react-three/fiber';
import type Jolt from 'jolt-physics';
import { MathUtils } from 'three';
import { Layer, NUM_BROAD_PHASE_LAYERS, NUM_OBJECT_LAYERS } from '../constants';
import { Raw } from '../raw';
import { _matrix4, _position, _quaternion, _rotation, _scale, _vector3 } from '../tmp';
import { anyVec3, joltScratch, vec3 } from '../utils';
import { BodyState } from './body-state';
import { BodySystem } from './body-system';
import { ConstraintSystem } from './constraint-system';
import { Emitter, type Unsubscribe } from './emitter';
import { type StepCallback, WORLD_EVENT_BITS, type WorldEventMap } from './events';
import { ShapeCollider } from './queries/collider';
import { AdvancedRaycaster, Multicaster, Raycaster } from './queries/raycasters';
import { Shapecaster } from './queries/shapecasters';

// Hoisted so the per-step `forEach` does not allocate a fresh closure for every substep.
const capturePose = (state: BodyState): void => {
    state.capturePose();
};
const resetPoseCache = (state: BodyState): void => {
    state.resetPoseCache();
};

/**
 * Anything with a lifetime tied to a world: a character controller, a camera rig, a vehicle
 * system, a raycaster. Register one with {@link PhysicsSystem.registerDisposable} and
 * `PhysicsSystem.destroy()` will tear it down - while the world is still alive - before it
 * frees the JoltInterface.
 */
export type Disposable = { destroy(): void } | (() => void);

//* Deferred world teardown ==========================================
// React destroys a parent's effects before its children's, so `<Physics>`'s unmount cleanup runs
// *before* the `<RigidBody>` / `useConstraint` / controller cleanups underneath it. Destroying
// the world there would leave every child cleaning up against a dead JoltInterface. `<Physics>`
// therefore schedules the real `destroy()` through here: a microtask queued during React's
// commit runs only once the whole commit (including every child's cleanup) has finished.
//
// The queue is module level - rather than a bare `queueMicrotask` in the component - so that the
// heap guard below can force it to drain before deciding there is no room for another world.
// Otherwise a page (or a test file) that unmounts one `<Physics>` and mounts the next in the
// same tick would be holding two worlds' worth of WASM heap for no reason.
const pendingWorldDestroys = new Set<() => void>();
let flushingWorldDestroys = false;

/** Run `destroy` after the current React commit. Safe to call more than once for one world. */
export function deferWorldDestroy(destroy: () => void): void {
    pendingWorldDestroys.add(destroy);
    queueMicrotask(() => {
        if (!pendingWorldDestroys.delete(destroy)) return;
        destroy();
    });
}

/**
 * Run every teardown {@link deferWorldDestroy} is still holding, right now. Called before
 * allocating a new world, and useful in tests that need the heap settled synchronously.
 */
export function flushDeferredWorldDestroys(): void {
    if (flushingWorldDestroys || pendingWorldDestroys.size === 0) return;
    flushingWorldDestroys = true;
    try {
        for (const destroy of [...pendingWorldDestroys]) {
            if (pendingWorldDestroys.delete(destroy)) destroy();
        }
    } finally {
        flushingWorldDestroys = false;
    }
}

/**
 * WASM heap one `JoltInterface` needs, measured against jolt-physics 1.1.0 with the default
 * `JoltSettings` (10 MB temp allocator + the body/contact managers): 20,191,160 bytes. Rounded
 * up for the margin.
 */
const INTERFACE_HEAP_COST = 21 * 1024 * 1024;

/**
 * Refuse to build a world there is no heap for, with an error that says what to do about it.
 *
 * The jolt-physics wasm builds ship a fixed 128 MB heap with no growth, so roughly six worlds
 * fit at once and the seventh `new JoltInterface(...)` calls emscripten's `abort(OOM)` - which
 * kills the module for the rest of the page and surfaces as a hang or an unrelated trap much
 * later. That is the real cause of issue #176; the old `maxInterfaces = 3` cap papered over it
 * by silently handing the fourth `<Physics>` the *first* world's interface, so two components
 * shared bodies without either knowing.
 */
function assertHeapRoomForWorld(jolt: typeof Jolt): void {
    // `sGetFreeMemory` is a static on JoltInterface; it is not in every build, so treat a
    // missing or throwing probe as "no information" rather than as a failure.
    let freeMemory: number;
    try {
        const probe = jolt.JoltInterface?.prototype?.sGetFreeMemory;
        if (typeof probe !== 'function') return;
        freeMemory = probe.call(jolt.JoltInterface.prototype);
    } catch {
        return;
    }
    if (!(freeMemory >= 0) || freeMemory >= INTERFACE_HEAP_COST) return;

    // A world whose `<Physics>` has already unmounted may still be queued for teardown.
    flushDeferredWorldDestroys();
    try {
        freeMemory = jolt.JoltInterface.prototype.sGetFreeMemory();
    } catch {
        return;
    }
    if (freeMemory >= INTERFACE_HEAP_COST) return;

    const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    throw new Error(
        `r3/jolt: not enough WASM heap for another physics world - ${mb(freeMemory)} free, ` +
            `about ${mb(INTERFACE_HEAP_COST)} needed, ${Raw.interfaceCount} world(s) already ` +
            'live. Call `destroy()` on a PhysicsSystem you no longer need (unmounting its ' +
            '<Physics> does this for you) before creating another one.'
    );
}

export class PhysicsSystem {
    /**
     * World level events. `beforeStep` / `afterStep` fire once per *substep*, around
     * `joltInterface.Step()`; the contact and activation events are flushed between the step
     * and `afterStep`. Subscribe with `events.on(type, fn)`, which returns the unsubscribe.
     */
    readonly events = new Emitter<WorldEventMap>(WORLD_EVENT_BITS);
    /**
     * Back compat for `removeStepListener(fn)`, which removes by identity. Every deprecated
     * `addPreStepListener` / `addPostStepListener` call records its unsubscribe here so the
     * old removal API keeps working - it now removes *every* entry for that function, where it
     * used to remove at most one per list.
     */
    private legacyStepSubs = new Map<Function, Unsubscribe[]>();
    private currentSubframe = 0;

    joltInterface!: Jolt.JoltInterface;
    // TODO: Rename this to joltPhysicsSystem
    physicsSystem!: Jolt.PhysicsSystem;
    bodyInterface!: Jolt.BodyInterface;
    bodySystem!: BodySystem;
    constraintSystem!: ConstraintSystem;

    /**
     * This world's slot in `Raw`'s interface registry, from a counter that only ever goes up.
     * `Raw.getInterface(id)` resolves it; `destroy()` gives it back. -1 once destroyed.
     */
    interfaceId: number;
    /** Whatever the world was constructed with. Debug label only; it identifies nothing. */
    readonly label: string;

    // Public properties ----------------------------
    /**
     * Length of one physics step in seconds, or `"vary"` to step with the render delta
     * (clamped, 1-2 substeps). Default `1/60`.
     */
    public timeStep: number | 'vary' = 1 / 60;
    /** When true `onUpdate` returns immediately: time stops, rendering carries on. */
    public paused = false;
    /**
     * True once `destroy()` has freed the JoltInterface. React tears a parent down before
     * its children, so `<Physics>` unmounting gets here before the hooks that own bodies and
     * constraints - everything wasm-facing has to check this before calling into jolt.
     */
    public destroyed = false;
    private _debug = false;
    /** Log lifecycle info, warn when simulation time is dropped, and poison event payloads. */
    get debug(): boolean {
        return this._debug;
    }
    set debug(value: boolean) {
        this._debug = value;
        // BodySystem does not exist yet while the field initialisers run
        if (this.bodySystem) this.bodySystem.debug = value;
    }
    private _interpolate = true;
    /**
     * Interpolate the three.js objects between the last two fixed steps instead of snapping
     * them to the latest one. Ignored when `timeStep` is `"vary"`. Default `true`.
     */
    get interpolate(): boolean {
        return this._interpolate;
    }
    set interpolate(value: boolean) {
        if (value === this._interpolate) return;
        this._interpolate = value;
        // While interpolation was off nothing kept the pose cache current, so the stored poses
        // are arbitrarily old. Drop them, or the first interpolated frame lerps across that gap.
        if (value) this.invalidatePoseCache();
    }

    /**
     * Hard cap on the number of fixed steps a single frame may run. Time beyond
     * `maxSubSteps * timeStep` is dropped rather than queued, which is what stops a long
     * frame from snowballing into an ever growing backlog (the "spiral of death").
     */
    public maxSubSteps = 5;

    /**
     * The most recent (sanitised) render frame delta, in seconds. The fallback step length for
     * callers that need one while `timeStep` is `"vary"` - see `BodyState.moveKinematic`.
     */
    public lastDelta = 1 / 60;

    // This lets us interpolate between physics steps. The poses themselves live on each
    // BodyState (preallocated); all we keep here is the leftover time.
    private steppingState = { accumulator: 0 };

    /** Simulation time not yet consumed by a fixed step, in seconds. */
    get accumulator(): number {
        return this.steppingState.accumulator;
    }

    /**
     * Throw away simulation time that hasn't been stepped yet, so the next frame starts from a
     * clean clock. Worth doing after a long stall the world shouldn't try to catch up on.
     */
    resetAccumulator(): void {
        this.steppingState.accumulator = 0;
    }

    /** Forget every body's cached poses; frames render live poses until the cache refills. */
    invalidatePoseCache(): void {
        this.bodySystem.dynamicBodies.forEach(resetPoseCache);
        this.bodySystem.kinematicBodies.forEach(resetPoseCache);
    }

    /**
     * Every world owns exactly one `JoltInterface`, built here and freed in {@link destroy}.
     *
     * @param label optional debug label, shown in `debug` logs. It used to be the React `useId()`
     * of the owning `<Physics>` and was the key the interface was cached under; interfaces are
     * now keyed by {@link interfaceId} instead, so this identifies nothing (issues #35, #176).
     */
    constructor(label = '0') {
        this.label = label;
        const jolt = Raw.module;
        if (!jolt)
            throw new Error(
                'r3/jolt: new PhysicsSystem() before the jolt-physics module was loaded. ' +
                    'Await `initJolt()` first - <Physics> does this for you.'
            );

        // Bail out with a readable error rather than letting emscripten abort the module.
        assertHeapRoomForWorld(jolt);

        /* setup collisions and broadphase */
        // NOTE: every table below is sized by NUM_OBJECT_LAYERS, which has to cover the *highest*
        // Layer id. Jolt only bounds checks these with asserts that the release wasm compiles
        // out, so a table that is too small corrupts the heap silently (issue #95).
        const objectFilter = new jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
        objectFilter.EnableCollision(Layer.NON_MOVING, Layer.MOVING);
        objectFilter.EnableCollision(Layer.MOVING, Layer.MOVING);
        objectFilter.DisableCollision(Layer.NON_MOVING, Layer.RIG);
        objectFilter.DisableCollision(Layer.MOVING, Layer.RIG);
        objectFilter.DisableCollision(Layer.RIG, Layer.RIG);

        const BP_LAYER_MOVING = new jolt.BroadPhaseLayer(0);
        const BP_LAYER_NON_MOVING = new jolt.BroadPhaseLayer(1);
        const BP_LAYER_RIG = new jolt.BroadPhaseLayer(2);
        const bpInterface = new jolt.BroadPhaseLayerInterfaceTable(
            NUM_OBJECT_LAYERS,
            NUM_BROAD_PHASE_LAYERS
        );
        bpInterface.MapObjectToBroadPhaseLayer(Layer.NON_MOVING, BP_LAYER_NON_MOVING);
        bpInterface.MapObjectToBroadPhaseLayer(Layer.MOVING, BP_LAYER_MOVING);
        // kinematic bodies are created on Layer.MOVING today, but the entry has to be mapped:
        // an unmapped object layer means the broadphase reads a slot nothing ever wrote.
        bpInterface.MapObjectToBroadPhaseLayer(Layer.KINEMATIC, BP_LAYER_MOVING);
        bpInterface.MapObjectToBroadPhaseLayer(Layer.RIG, BP_LAYER_RIG);
        const settings = new jolt.JoltSettings();
        settings.mObjectLayerPairFilter = objectFilter;
        settings.mBroadPhaseLayerInterface = bpInterface;
        settings.mObjectVsBroadPhaseLayerFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(
            settings.mBroadPhaseLayerInterface,
            NUM_BROAD_PHASE_LAYERS,
            settings.mObjectLayerPairFilter,
            NUM_OBJECT_LAYERS
        );

        // One interface per world, always. The old code cached interfaces by `pid` and, past a
        // cap of three, silently handed the caller the *first* world's interface - two <Physics>
        // trees then shared bodies, and the loser's filter tables were orphaned (issues #35/#176).
        this.joltInterface = new jolt.JoltInterface(settings);
        this.interfaceId = Raw.registerInterface(this.joltInterface);

        /* get interfaces */

        this.physicsSystem = this.joltInterface.GetPhysicsSystem();
        this.bodyInterface = this.physicsSystem.GetBodyInterface();

        /* cleanup */
        // NOTE: `settings` is only a shell - the JoltInterface took ownership of the three filter
        // tables inside it and frees them in its own destructor. Destroying them here (or in
        // destroy()) is a double free that traps in wasm. Verified against jolt-physics 1.1.0:
        // free memory returns exactly to baseline after destroying the interface alone.
        jolt.destroy(settings);
        jolt.destroy(BP_LAYER_NON_MOVING);
        jolt.destroy(BP_LAYER_MOVING);
        // the broadphase table copied it, same as the other two; this one was being leaked
        jolt.destroy(BP_LAYER_RIG);

        // start the chain of systems/services
        this.constraintSystem = new ConstraintSystem(this);
        this.bodySystem = new BodySystem(this.physicsSystem);
        // so removing a body also removes the constraints attached to it (issue #82)
        this.bodySystem.constraintSystem = this.constraintSystem;
        // bodies read the world's step timing through this (e.g. moveKinematic's default delta)
        this.bodySystem.world = this;
        // the contact listener needs the world emitter for its zero-cost mask and for
        // dispatching world level events
        this.bodySystem.worldEvents = this.events;
        this.bodySystem.debug = this._debug;
    }

    //* Disposables ===================================
    /**
     * Objects whose lifetime is this world's. Held weakly in spirit (a controller unregisters
     * itself in its own `destroy()`), and torn down first by {@link destroy}.
     */
    private disposables = new Set<Disposable>();

    /**
     * Tie something to this world's lifetime. `destroy()` will call it - before the world is
     * freed, so it can still remove its bodies and constraints - and anything registered is
     * torn down exactly once.
     *
     * Registering is *not* a substitute for the owner's own cleanup: a `<CharacterController>`
     * that unmounts on its own still destroys its controller, which unregisters it here. This
     * is the safety net for everything still alive when the whole world goes away.
     *
     * @returns an unregister function. Call it from your own `destroy()`.
     */
    registerDisposable(disposable: Disposable): () => void {
        if (this.destroyed) return () => {};
        this.disposables.add(disposable);
        return () => {
            this.disposables.delete(disposable);
        };
    }

    /** How many disposables are registered. Test hook. */
    get disposableCount(): number {
        return this.disposables.size;
    }

    // Set while `destroy()` is walking the world. `destroyed` cannot be used for this: every
    // wasm-facing method keys off it to become a no-op, and the teardown below has to be able
    // to call those methods for real.
    private destroying = false;

    /**
     * Free everything this world owns, in dependency order, and mark it {@link destroyed}.
     *
     * Idempotent: a second call (StrictMode, an explicit `destroy()` plus an unmount, a child
     * that tears itself down afterwards) does nothing.
     *
     * The order matters, top to bottom:
     *  1. stop stepping, so nothing below runs against a half torn down world;
     *  2. registered disposables - controllers, rigs, vehicles - while the world is still live,
     *     so each can remove its own bodies, constraints and listeners normally;
     *  3. constraints, because Jolt dereferences *both* bodies while detaching a constraint, so
     *     every constraint has to go before any body does (issue #82);
     *  4. bodies, which frees the per-body CollisionGroups and closes open contact pairs;
     *  5. event subscriptions, so nothing is dispatched into user code from here on;
     *  6. the JoltInterface, which takes the Jolt PhysicsSystem, the broadphase/object layer
     *     filter tables, the temp allocator and the job system with it;
     *  7. only now the `ContactListenerJS` / `BodyActivationListenerJS` objects, via
     *     `bodySystem.destroy()` - Jolt's PhysicsSystem holds raw pointers to them, so freeing
     *     an installed listener before the interface is a use after free on the next step;
     *  8. the shared scratch vectors, but only when this was the last world on the module.
     *
     * @param _pid ignored. Kept so `destroy(pid)` written against the old API still compiles.
     */
    destroy(_pid?: string): void {
        if (this.destroyed || this.destroying) return;
        this.destroying = true;
        try {
            // 1. time stops here
            this.paused = true;
            this.resetAccumulator();

            // 2. anything that registered itself against this world
            for (const disposable of [...this.disposables]) {
                this.disposables.delete(disposable);
                try {
                    if (typeof disposable === 'function') disposable();
                    else disposable.destroy();
                } catch (error) {
                    // one broken disposable must not strand the rest of the teardown
                    console.error('r3/jolt: a registered disposable threw during destroy', error);
                }
            }
            this.disposables.clear();

            // 3. constraints before bodies
            this.constraintSystem.removeAllConstraints();

            // 4. every body, including ones handed to `addExistingBody`
            this.bodySystem.removeAllBodies();

            // 5. no more dispatching into user code
            this.events.clear();
            this.legacyStepSubs.clear();
            this.bodySystem.clearEvents();

            // 6. the world itself
            Raw.module.destroy(this.joltInterface);
            Raw.releaseInterface(this.interfaceId);
            this.interfaceId = -1;

            // 7. ...and only now the listener objects it was pointing at, plus the rest of the
            // BodySystem's own heap allocations (the ref counted GroupFilterTable - issue #95).
            this.bodySystem.destroy(true);
        } finally {
            this.destroying = false;
            this.destroyed = true;
        }

        // 8. The scratch vectors are shared by every world on this module, so they only go when
        // the last one does. The next accessor call rebuilds them if a world appears again.
        if (Raw.interfaceCount === 0) joltScratch.release();

        if (this._debug) console.log(`*** PhysicsSystem "${this.label}" destroyed ***`);
    }
    // TODO: Loops and steps seems messy
    onUpdate(delta: number): void {
        // A frame callback can outlive the world by one tick (r3f's loop, an independent rAF):
        // stepping a freed JoltInterface traps in wasm, so this check is not optional.
        if (this.destroyed || this.destroying) return;
        if (this.paused) return;
        // Frame deltas are not always sane: a clock reset (r3f's scheduler does this when the
        // loop restarts) can hand us a negative one, and a dropped frame can hand us NaN. Either
        // would sit in the accumulator and stall the simulation for many frames, so drop them.
        if (!(delta > 0)) delta = 0;
        if (delta > 0) this.lastDelta = delta;
        const timeStepVariable = this.timeStep === 'vary';
        // interpolation only means anything when the simulation runs on its own fixed clock;
        // with a variable step the last step already lands exactly on the current frame
        const interpolating = this.interpolate && !timeStepVariable;

        if (timeStepVariable) {
            this.variableStep(delta);
        } else {
            this.fixedTimeStep(delta, this.timeStep as number, interpolating);
        }

        // How far the render frame sits past the last completed physics step, 0..1
        this._frameAlpha = interpolating
            ? this.steppingState.accumulator / (this.timeStep as number)
            : 1;
        this._frameInterpolating = interpolating;

        // Loop over all dynamic and kinematic bodies. Iterating the two maps directly (rather
        // than spreading them into one array) keeps the frame loop allocation free.
        // NOTE: using "state" to match rapier logic
        this.bodySystem.dynamicBodies.forEach(this.syncBodyToObject);
        this.bodySystem.kinematicBodies.forEach(this.syncBodyToObject);
        // Static bodies are never awake, so they are not in the maps above. A static that was
        // moved from the outside (issue #61) registers itself here and is synced exactly once.
        if (this.bodySystem.movedStatics.size) {
            this.bodySystem.movedStatics.forEach(this.syncBodyToObject);
            this.bodySystem.movedStatics.clear();
        }

        // todo: consider sleeping
        invalidate();
    }

    // alpha/mode for the current frame, read by `syncBodyToObject`. Kept as fields so the sync
    // callback can be a single long lived function instead of a closure allocated every frame.
    private _frameAlpha = 1;
    private _frameInterpolating = false;

    /**
     * How far the current render frame sits past the last completed physics step, 0..1. `1`
     * when the frame lands exactly on a step, which is always the case with interpolation off.
     * Anything drawing its own view of the world (the `<Physics debug>` overlay) reads this so
     * it lands on the same pose the bodies' meshes were given.
     */
    get frameAlpha(): number {
        return this._frameAlpha;
    }
    /** True when this frame's object poses were interpolated rather than read live. */
    get frameInterpolating(): boolean {
        return this._frameInterpolating;
    }

    /**
     * Push one body's physics pose onto its three.js object. Either the interpolated pose
     * between the last two fixed steps, or the body's live pose. Allocation free.
     */
    private syncBodyToObject = (state: BodyState): void => {
        // A static body is never "active", so `isSleeping` is always true for one; it only
        // reaches this through the moved-statics drain above, which is exactly when it does
        // need a sync (issue #61).
        if (state.isSleeping && !state.isStatic) return;

        // World space physics pose for this frame -> _vector3 / _quaternion
        if (this._frameInterpolating && state.poseCacheValid) {
            state.getInterpolatedPose(this._frameAlpha, _vector3, _quaternion);
        } else {
            state.readPose(_vector3, _quaternion);
        }

        // Convert that into the object's parent space -> _matrix4
        _matrix4
            // activeScale rather than the `scale` getter: same value, but typed as a Vector3
            .compose(_vector3, _quaternion, state.activeScale)
            .premultiply(state.invertedWorldMatrix);

        // #168: with `matrixAutoUpdate` off, `_matrix4` above already *is* the object's local
        // matrix - write it straight through and skip decomposing it into position/quaternion/
        // scale only for `update()` to recompose them right back into a matrix a moment later.
        // Only meaningful for a non-instance object (an instance's transform is never driven by
        // position/quaternion in the first place).
        if (state.matrixAutoUpdate === false && !state.isInstance) {
            state.setLocalMatrix(_matrix4);
            return;
        }

        _matrix4.decompose(_position, _rotation, _scale);
        state.update(_position, _rotation);
    };

    private variableStep(delta: number): void {
        // Max of 0.5 to prevent tunneling / instability
        const deltaTime = MathUtils.clamp(delta, 0, 0.5);

        // When running below 55 Hz, do 2 steps instead of 1
        const numSteps = deltaTime > 1.0 / 55.0 ? 2 : 1;

        // Step the physics world
        this.stepSimulation(deltaTime, numSteps);
    }

    /**
     * One substep, and the one place the event ordering is defined:
     *
     * `beforeStep` -> pending actions -> `Step()` -> queued contact/activation events ->
     * `afterStep`.
     *
     * Everything Jolt hands us from inside `Step()` is written to a queue and dispatched here,
     * so a user handler is never running while Jolt owns the world: it can add bodies, apply
     * impulses and remove things, and the only Jolt-internal work that happens synchronously
     * inside the step is the `ValidateResult` return and the `ContactSettings` writes.
     */
    private stepSimulation(delta: number, steps: number) {
        this.events.emit('beforeStep', delta, this.currentSubframe);
        // the substep's own dt, so standing kinematic targets are re-aimed with the real step
        // length rather than a frame delta (issue #194)
        this.bodySystem.handlePendingActions(delta);
        this.joltInterface.Step(delta, steps);
        this.bodySystem.flushEvents();
        this.events.emit('afterStep', delta, this.currentSubframe);
        this.currentSubframe = (this.currentSubframe + 1) % 4;
    }
    private fixedTimeStep(delta: number, timeStep: number, interpolate: boolean): void {
        // don't step time forwards if paused
        // Increase accumulator
        this.steppingState.accumulator += delta;

        // Clamp the backlog. A frame that took much longer than the timestep (a tab coming back
        // from the background, a debugger pause, a big asset decode) would otherwise queue up
        // an unbounded number of substeps, each of which makes the next frame longer still.
        // Dropping the excess simulation time is the standard escape from that spiral.
        const maxAccumulated = timeStep * this.maxSubSteps;
        if (this.steppingState.accumulator > maxAccumulated) {
            const dropped = this.steppingState.accumulator - maxAccumulated;
            this.steppingState.accumulator = maxAccumulated;
            if (this.debug)
                console.warn(
                    `*** R3/Jolt: dropped ${dropped.toFixed(4)}s of simulation time; a frame ` +
                        `needed more than maxSubSteps (${this.maxSubSteps}) physics steps ***`
                );
        }

        while (this.steppingState.accumulator >= timeStep) {
            this.stepSimulation(timeStep, 1);
            this.steppingState.accumulator -= timeStep;

            // Snapshot the pose this step produced. capturePose shifts the previous snapshot
            // down, so afterwards every body holds the two poses the render frame interpolates
            // between. Needed inside the loop (not once after it) so a frame that runs several
            // substeps still interpolates across the *last* one only.
            if (interpolate) {
                this.bodySystem.dynamicBodies.forEach(capturePose);
                this.bodySystem.kinematicBodies.forEach(capturePose);
            }
        }
    }

    // Listeners ===================================
    /** Run `fn(deltaTime, subframe)` before each substep. Returns the unsubscribe. */
    onBeforeStep(fn: StepCallback): Unsubscribe {
        return this.events.on('beforeStep', fn);
    }
    /** Run `fn(deltaTime, subframe)` after each substep and its event flush. Returns the unsubscribe. */
    onAfterStep(fn: StepCallback): Unsubscribe {
        return this.events.on('afterStep', fn);
    }

    /**
     * @deprecated use {@link onBeforeStep}, which is the same thing with a usable return value.
     */
    addPreStepListener(listener: Function): Unsubscribe {
        return this.trackLegacyStepSub(listener, this.events.on('beforeStep', listener as never));
    }
    /**
     * @deprecated use {@link onAfterStep}.
     */
    addPostStepListener(listener: Function): Unsubscribe {
        return this.trackLegacyStepSub(listener, this.events.on('afterStep', listener as never));
    }
    /**
     * Remove every pre and post step subscription made for `listener`.
     *
     * @deprecated removal by function identity cannot work for the inline arrows every caller
     * actually passes. Keep the `Unsubscribe` returned by {@link onBeforeStep} instead.
     */
    removeStepListener(listener: Function): void {
        const subs = this.legacyStepSubs.get(listener);
        if (!subs) return;
        this.legacyStepSubs.delete(listener);
        for (const off of subs) off();
    }
    private trackLegacyStepSub(listener: Function, off: Unsubscribe): Unsubscribe {
        const subs = this.legacyStepSubs.get(listener);
        if (subs) subs.push(off);
        else this.legacyStepSubs.set(listener, [off]);
        return off;
    }
    /**
     * @deprecated internal; emit through {@link events} instead.
     */
    triggerStepListener(deltaTime: number, position = 'pre'): void {
        this.events.emit(
            position === 'pre' ? 'beforeStep' : 'afterStep',
            deltaTime,
            this.currentSubframe
        );
    }

    //* Raycasters ===================================
    // Every factory below allocates WASM filters against this world's JoltInterface, so none of
    // them may run once it has been freed. The caller owns what it gets back and must `destroy()`
    // it (the hooks do); `registerDisposable` is there for anything longer lived.
    private assertAlive(what: string): void {
        if (this.destroyed)
            throw new Error(`r3/jolt: ${what} on a destroyed PhysicsSystem ("${this.label}")`);
    }
    getRaycaster() {
        this.assertAlive('getRaycaster()');
        return new Raycaster(this.physicsSystem, this.joltInterface);
    }
    getAdvancedRaycaster() {
        this.assertAlive('getAdvancedRaycaster()');
        return new AdvancedRaycaster(this.physicsSystem, this.joltInterface);
    }
    getMulticaster() {
        this.assertAlive('getMulticaster()');
        return new Multicaster(this.physicsSystem, this.joltInterface);
    }
    // -- Shapecaster
    getShapecaster() {
        this.assertAlive('getShapecaster()');
        return new Shapecaster(this.physicsSystem, this.joltInterface);
    }
    //* Colliders ===================================
    getShapeCollider() {
        this.assertAlive('getShapeCollider()');
        return new ShapeCollider(this.physicsSystem, this.joltInterface);
    }

    //* Utility methods ----------------------------
    /**
     * Set world gravity. A plain number is read as a downward magnitude
     * (`9.81` -> `[0, -9.81, 0]`); a tuple, THREE.Vector3 or Jolt vector is used as-is.
     */
    setGravity(gravity: number | anyVec3): void {
        // `<Physics gravity=...>`'s effect can fire after the world has gone (a prop change in
        // the same commit that unmounts it), and SetGravity on a freed PhysicsSystem traps.
        if (this.destroyed) return;
        // `SetGravity` takes a Vec3Arg and copies it. This used to allocate two WASM vectors per
        // call (a `new Vec3` and the one `vec3.jolt` made of it) and destroy neither; it runs
        // from a useEffect on every `gravity` prop change, so use the shared scratch vector.
        const newGravity: anyVec3 = typeof gravity === 'number' ? [0, -gravity, 0] : gravity;
        this.physicsSystem.SetGravity(joltScratch.vec3(newGravity));
        if (this.debug) console.log('gravity set', typeof gravity, vec3.three(newGravity));
    }
}
