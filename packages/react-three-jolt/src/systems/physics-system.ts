/* System may not be the correct name as this isn't a part of a ECS
However that will fit better with isaac-mason's sketch
*/
/* The intent of this class is a wrapper around the core physics actions
outside of the react context and limitations. 
we'll expose various parts of the system through the physics component and context 8?
*/

// First version based on isaac-mason's sketch, removing the ECS
// This is the core component that manages and stores the simulation
import { invalidate } from "@react-three/fiber";
import * as THREE from "three";

import type Jolt from "jolt-physics";
import { Raw } from "../raw";
import { BodySystem } from "./body-system";
import { BodyState } from "./body-state";
import { ConstraintSystem } from "./constraint-system";
import { Raycaster, AdvancedRaycaster, Multicaster } from "./queries/raycasters";
import { ShapeCollider } from "./queries/collider";
import { Shapecaster } from "./queries/shapecasters";
import { _matrix4, _position, _quaternion, _rotation, _scale, _vector3 } from "../tmp";
import { quat, vec3, anyVec3 } from "../utils";
import { MathUtils, Quaternion, Vector3 } from "three";
import { Layer, NUM_OBJECT_LAYERS } from "../constants";

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
	public timeStep = 1 / 60;
	public paused = false;
	public debug = false;
	public interpolate = true;

	// This lets us interpolate between physics steps
	// TODO: is storing the body in the map better than the handle?
	private steppingState: {
		accumulator: number;
		previousState: Map<
			number,
			{
				position: THREE.Vector3;
				quaternion: THREE.Quaternion;
			}
		>;
	} = {
		accumulator: 0,
		previousState: new Map()
	};

	maxInterfaces = 3;
	constructor(pid = "0") {
		const jolt = Raw.module;
		//console.log('*** R3/Jolt PhysicsSystem Initialized ***');
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
				console.warn("*** WARNING: Excess Jolt Interfaces Attempted ***");
				console.log("Using first initialized interface");
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

	destroy(pid = "0"): void {
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
		// TODO Fix this TS
		//@ts-ignore
		const timeStepVariable = this.timeStep === "vary";

		if (timeStepVariable) {
			this.variableStep(delta);
		} else {
			this.fixedTimeStep(delta, this.timeStep, this.interpolate);
		}

		const interpolationAlpha =
			timeStepVariable || !this.interpolate
				? 1
				: this.steppingState.accumulator / this.timeStep;
		// Loop over all dynamic bodies
		// NOTE: using "state" to match rapier logic
		const mergedBodies: BodyState[] = [
			...this.bodySystem.dynamicBodies.values(),
			...this.bodySystem.kinematicBodies.values()
		];
		mergedBodies.forEach((state: BodyState) => {
			const body = state.body;

			if (state.isSleeping) return;

			// Get new position and rotation (jolt values)
			const pos = body.GetPosition();
			const rot = body.GetRotation();
			//TODO: Cleanup this looping logic

			/*
			 */
			if (this.interpolate) {
				const previousState = this.steppingState.previousState.get(state.handle);

				if (previousState) {
					// Get previous simulated world position
					_matrix4
						.compose(previousState.position, previousState.quaternion, state.scale)
						.premultiply(state.invertedWorldMatrix)
						.decompose(_position, _rotation, _scale);

					// Apply previous tick position
					//original
					/*
                    if (state.meshType == 'mesh') {
                        //console.log('trying to push onto mesh', state.object);
                        state.object.position.copy(_position);
                        state.object.quaternion.copy(_rotation);
                    }*/
					state.update(_position, _rotation);
				}
			}

			// Get new position
			_matrix4
				.compose(
					vec3.joltToThree(pos as Jolt.Vec3, _vector3),
					quat.joltToThree(rot, _quaternion),
					state.scale
				)
				.premultiply(state.invertedWorldMatrix)
				.decompose(_position, _rotation, _scale);

			if (this.interpolate) {
				state.position.lerp(_position, interpolationAlpha);
				state.rotation.slerp(_rotation, interpolationAlpha);
				state.update(_position, _rotation);
				/* original
                    state.object.position.lerp(_position, interpolationAlpha);
                    state.object.quaternion.slerp(
                        _rotation,
                        interpolationAlpha
                    );
                    */
			} else {
				/* original
                    state.object.position.copy(_position);
                    state.object.quaternion.copy(_rotation);
                    */
				state.update(_position, _rotation);
			}
		});

		// todo: consider sleeping
		invalidate();
	}

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
		this.joltInterface.Step(delta, steps);
		this.triggerStepListener(delta, "post");
		this.currentSubframe = (this.currentSubframe + 1) % 4;
	}
	private fixedTimeStep(delta: number, timeStep: number, interpolate: boolean): void {
		// don't step time forwards if paused
		// Increase accumulator
		this.steppingState.accumulator += delta;

		while (this.steppingState.accumulator >= timeStep) {
			// Set up previous state
			// needed for accurate interpolations if the world steps more than once
			if (interpolate) {
				this.steppingState.previousState = new Map();
				// loop over dynamic bodies

				this.bodySystem.dynamicBodies.forEach((state) => {
					let previousState = this.steppingState.previousState.get(state.handle);

					if (!previousState) {
						previousState = {
							position: new Vector3(),
							quaternion: new Quaternion()
						};
						this.steppingState.previousState.set(state.handle, previousState);
					}

					vec3.joltToThree(state.body.GetPosition() as Jolt.Vec3, previousState.position);
					quat.joltToThree(state.body.GetRotation(), previousState.quaternion);
				});
				this.bodySystem.kinematicBodies.forEach((state) => {
					let previousState = this.steppingState.previousState.get(state.handle);

					if (!previousState) {
						previousState = {
							position: new Vector3(),
							quaternion: new Quaternion()
						};
						this.steppingState.previousState.set(state.handle, previousState);
					}

					vec3.joltToThree(state.body.GetPosition() as Jolt.Vec3, previousState.position);
					quat.joltToThree(state.body.GetRotation(), previousState.quaternion);
				});
			}

			this.stepSimulation(timeStep, 1);

			this.steppingState.accumulator -= timeStep;
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
	triggerStepListener(deltaTime: number, position = "pre"): void {
		const listeners = position === "pre" ? this.preStepListeners : this.postStepListeners;
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
	// Set Gravity
	setGravity(gravity: number | THREE.Vector3): void {
		const newGravity: anyVec3 =
			typeof gravity === "number" ? new Raw.module.Vec3(0, -gravity, 0) : gravity;
		this.physicsSystem.SetGravity(vec3.jolt(newGravity));
		if (this.debug) console.log("gravity set", typeof gravity, vec3.three(newGravity));
	}
}
