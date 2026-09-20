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
import { Layer, NUM_OBJECT_LAYERS } from '../constants';
import { Raw } from '../raw';
import { _matrix4, _position, _quaternion, _rotation, _scale, _vector3 } from '../tmp';
import { anyVec3, vec3 } from '../utils';
import { BodyState } from './body-state';
import { BodySystem } from './body-system';
import { ConstraintSystem } from './constraint-system';
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

export class PhysicsSystem {
    // Step Event Listeners
    private preStepListeners: Function[] = [];
    private postStepListeners: Function[] = [];
    private currentSubframe = 0;

    joltInterface!: Jolt.JoltInterface;
    // TODO: Rename this to joltPhysicsSystem
    physicsSystem!: Jolt.PhysicsSystem;
    bodyInterface!: Jolt.BodyInterface;
    bodySystem!: BodySystem;
    constraintSystem!: ConstraintSystem;

    // Public properties ----------------------------
    /**
     * Length of one physics step in seconds, or `"vary"` to step with the render delta
     * (clamped, 1-2 substeps). Default `1/60`.
     */
    public timeStep: number | 'vary' = 1 / 60;
    /** When true `onUpdate` returns immediately: time stops, rendering carries on. */
    public paused = false;
    public debug = false;
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

    maxInterfaces = 3;
    constructor(pid = '0') {
        const jolt = Raw.module;

        console.log('*** R3/Jolt PhysicsSystem Initialized ***');
        /* setup collisions and broadphase */
        const objectFilter = new jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS);
        objectFilter.EnableCollision(Layer.NON_MOVING, Layer.MOVING);
        objectFilter.EnableCollision(Layer.MOVING, Layer.MOVING);
        objectFilter.DisableCollision(Layer.NON_MOVING, Layer.RIG);
        objectFilter.DisableCollision(Layer.MOVING, Layer.RIG);
        objectFilter.DisableCollision(Layer.RIG, Layer.RIG);

        const BP_LAYER_MOVING = new jolt.BroadPhaseLayer(0);
        const BP_LAYER_NON_MOVING = new jolt.BroadPhaseLayer(1);
        const BP_LAYER_RIG = new jolt.BroadPhaseLayer(2);
        const NUM_BROAD_PHASE_LAYERS = 3;
        const bpInterface = new jolt.BroadPhaseLayerInterfaceTable(
            NUM_OBJECT_LAYERS,
            NUM_BROAD_PHASE_LAYERS
        );
        bpInterface.MapObjectToBroadPhaseLayer(Layer.NON_MOVING, BP_LAYER_NON_MOVING);
        bpInterface.MapObjectToBroadPhaseLayer(Layer.MOVING, BP_LAYER_MOVING);
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

        // if the interface alread exists use it, otherwise make a new one
        if (Raw.joltInterfaces.has(pid)) {
            this.joltInterface = Raw.joltInterfaces.get(pid);
        } else {
            // we need to check ourselves and limit interfaces for memory reasons
            if (Raw.joltInterfaces.size > this.maxInterfaces - 1) {
                // throw a warning about excess
                console.warn('*** WARNING: Excess Jolt Interfaces Attempted ***');
                console.log('Using first initialized interface');
                const interfaces = Raw.joltInterfaces.values();
                this.joltInterface = interfaces.next().value;
            } else {
                this.joltInterface = new jolt.JoltInterface(settings);
                Raw.joltInterfaces.set(pid, this.joltInterface);
            }
        }
        /* get interfaces */

        this.physicsSystem = this.joltInterface.GetPhysicsSystem();
        this.bodyInterface = this.physicsSystem.GetBodyInterface();

        /* cleanup */
        jolt.destroy(settings);
        jolt.destroy(BP_LAYER_NON_MOVING);
        jolt.destroy(BP_LAYER_MOVING);

        // start the chain of systems/services
        this.constraintSystem = new ConstraintSystem(this);
        this.bodySystem = new BodySystem(this.physicsSystem);
    }

    destroy(pid = '0'): void {
        // console.log('Request to destroy PhysicsSystem', pid);
        // check if it exists in the global
        if (Raw.joltInterfaces.has(pid)) {
            Raw.module.destroy(this.joltInterface);
            Raw.joltInterfaces.delete(pid);
            // console.log('*** PhysicsSystem:' + pid + ' destroyed ***');
        }
    }
    // TODO: Loops and steps seems messy
    onUpdate(delta: number): void {
        if (this.paused) return;
        // Frame deltas are not always sane: a clock reset (r3f's scheduler does this when the
        // loop restarts) can hand us a negative one, and a dropped frame can hand us NaN. Either
        // would sit in the accumulator and stall the simulation for many frames, so drop them.
        if (!(delta > 0)) delta = 0;
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
        this.frameAlpha = interpolating
            ? this.steppingState.accumulator / (this.timeStep as number)
            : 1;
        this.frameInterpolating = interpolating;

        // Loop over all dynamic and kinematic bodies. Iterating the two maps directly (rather
        // than spreading them into one array) keeps the frame loop allocation free.
        // NOTE: using "state" to match rapier logic
        this.bodySystem.dynamicBodies.forEach(this.syncBodyToObject);
        this.bodySystem.kinematicBodies.forEach(this.syncBodyToObject);

        // todo: consider sleeping
        invalidate();
    }

    // alpha/mode for the current frame, read by `syncBodyToObject`. Kept as fields so the sync
    // callback can be a single long lived function instead of a closure allocated every frame.
    private frameAlpha = 1;
    private frameInterpolating = false;

    /**
     * Push one body's physics pose onto its three.js object. Either the interpolated pose
     * between the last two fixed steps, or the body's live pose. Allocation free.
     */
    private syncBodyToObject = (state: BodyState): void => {
        if (state.isSleeping) return;

        // World space physics pose for this frame -> _vector3 / _quaternion
        if (this.frameInterpolating && state.poseCacheValid) {
            state.getInterpolatedPose(this.frameAlpha, _vector3, _quaternion);
        } else {
            state.readPose(_vector3, _quaternion);
        }

        // Convert that into the object's parent space -> _position / _rotation
        _matrix4
            // activeScale rather than the `scale` getter: same value, but typed as a Vector3
            .compose(_vector3, _quaternion, state.activeScale)
            .premultiply(state.invertedWorldMatrix)
            .decompose(_position, _rotation, _scale);

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

    // Step the physics simulation
    private stepSimulation(delta: number, steps: number) {
        this.triggerStepListener(delta);
        this.bodySystem.handlePendingActions();
        this.joltInterface.Step(delta, steps);
        this.triggerStepListener(delta, 'post');
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
    addPreStepListener(listener: Function): void {
        this.preStepListeners.push(listener);
    }
    addPostStepListener(listener: Function): void {
        this.postStepListeners.push(listener);
    }
    // remove a listener from either the pre or post step
    removeStepListener(listener: Function): void {
        const preIndex = this.preStepListeners.indexOf(listener);
        if (preIndex !== -1) {
            this.preStepListeners.splice(preIndex, 1);
        }
        const postIndex = this.postStepListeners.indexOf(listener);
        if (postIndex !== -1) {
            this.postStepListeners.splice(postIndex, 1);
        }
    }
    triggerStepListener(deltaTime: number, position = 'pre'): void {
        const listeners = position === 'pre' ? this.preStepListeners : this.postStepListeners;
        for (const listener of listeners) {
            listener(deltaTime, this.currentSubframe);
        }
    }

    //* Raycasters ===================================
    getRaycaster() {
        return new Raycaster(this.physicsSystem, this.joltInterface);
    }
    getAdvancedRaycaster() {
        return new AdvancedRaycaster(this.physicsSystem, this.joltInterface);
    }
    getMulticaster() {
        return new Multicaster(this.physicsSystem, this.joltInterface);
    }
    // -- Shapecaster
    getShapecaster() {
        return new Shapecaster(this.physicsSystem, this.joltInterface);
    }
    //* Colliders ===================================
    getShapeCollider() {
        return new ShapeCollider(this.physicsSystem, this.joltInterface);
    }

    //* Utility methods ----------------------------
    /**
     * Set world gravity. A plain number is read as a downward magnitude
     * (`9.81` -> `[0, -9.81, 0]`); a tuple, THREE.Vector3 or Jolt vector is used as-is.
     */
    setGravity(gravity: number | anyVec3): void {
        const newGravity: anyVec3 =
            typeof gravity === 'number' ? new Raw.module.Vec3(0, -gravity, 0) : gravity;
        const joltGravity = vec3.jolt(newGravity);
        this.physicsSystem.SetGravity(joltGravity);
        if (this.debug) console.log('gravity set', typeof gravity, vec3.three(newGravity));
        // This used to leak one Jolt.Vec3 per call, and it is called from a react effect.
        // Only free what we allocated here: a Jolt vector handed in by the caller stays theirs,
        // and `vec3.jolt` may or may not have copied it, hence the identity check.
        if (joltGravity !== newGravity) Raw.module.destroy(joltGravity);
        if (typeof gravity === 'number') Raw.module.destroy(newGravity);
    }
}
