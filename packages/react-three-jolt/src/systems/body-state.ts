// This class holds the bodies and the management of them
import type Jolt from "jolt-physics";
import {
	//MathUtils,
	Matrix4,
	Object3D,
	// Quaternion,
	Vector3,
	InstancedMesh
} from "three";
import * as THREE from "three";
import { Raw } from "../raw";

import { vec3, quat, anyVec3 } from "../utils";
import type { BodySystem } from "./body-system";

// Initital body object copied from r3/rapier's state object
export class BodyState {
	meshType: "instancedMesh" | "mesh";
	body: Jolt.Body;
	BodyID: Jolt.BodyID;
	object: Object3D | THREE.InstancedMesh;
	invertedWorldMatrix: Matrix4;
	handle: number;
	index?: number;

	// obstruction and collision
	allowObstruction = true; // temporarily block obstruction
	obstructionType: "any" | "temporal" = "any";
	obstructionTimelimit = 5000;
	allowCollision = false;

	// for conveyor systems willl be replaced with impulse source
	isConveyor = false;
	conveyorVector?: THREE.Vector3;
	isTeleporter = false;
	teleporterVector?: THREE.Vector3;

	//* motionSource Props ===================================
	//todo: should these be on their own class?
	isMotionSource = false;
	motionActive = false;
	useRotation = true;
	motionLinearVector?: THREE.Vector3;
	motionAngularVector?: THREE.Vector3;
	motionType: "linear" | "angular" = "linear";
	motionAsSurfaceVelocity = false;
	/**
	 * Required for instanced rigid bodies. (from r3/rapier)
	 */
	scale: Vector3;

	get isSleeping() {
		return !this.body.IsActive();
	}
	// TODO: change to this one that doesn't require setting meshType
	//const isInstance = (object: any): object is THREE.InstancedMesh => object.isInstancedMesh

	get isInstance() {
		return this.meshType === "instancedMesh";
	}

	// contact pairs
	contacts: Map<number, number> = new Map();
	contactTimestamps: Map<number, number> = new Map();
	contactThreshold = 900;

	// Listeners ----------------------------------
	// TODO: Make Listener callback type for these
	activationListeners: Function[] = [];
	contactAddedListeners: Function[] = [];
	contactRemovedListeners: Function[] = [];
	contactPersistedListeners: Function[] = [];

	// References so we can modify the body directly
	//@ts-ignore
	private joltPhysicsSystem;
	private bodyInterface: Jolt.BodyInterface;
	private bodySystem;
	private collisionGroupChanged = false;

	constructor(
		object: Object3D | InstancedMesh,
		body: Jolt.Body,
		joltPhysicsSystem: Jolt.PhysicsSystem,
		bodySystem: BodySystem,
		index?: number
	) {
		this.object = object;
		this.body = body;
		this.BodyID = body.GetID();
		this.handle = this.BodyID.GetIndexAndSequenceNumber();

		// Instance properties
		this.meshType = object instanceof InstancedMesh ? "instancedMesh" : "mesh";
		this.invertedWorldMatrix = object.matrixWorld.clone().invert();
		if (index !== undefined) this.index = index;
		// not currently used
		this.scale = object.scale.clone();
		// not sure this is a good idea here
		this.object.userData.body = body;
		this.object.userData.bodyHandle = this.handle;

		// set the references for direct manipulation
		this.joltPhysicsSystem = joltPhysicsSystem;
		this.bodySystem = bodySystem;
		this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
	}

	//* Activation & Contact Listeners ===================================
	// add a function to the activationListener Array
	addActivationListener(listener: Function) {
		this.activationListeners.push(listener);
	}
	// remove a function from the activationListener Array
	removeActivationListener(listener: Function) {
		this.activationListeners = this.activationListeners.filter((l) => l !== listener);
	}
	// add a function to one of the contact listener arrays with the function and which as input
	addContactListener(listener: Function, type: "added" | "removed" | "persisted") {
		if (type === "added") this.contactAddedListeners.push(listener);
		if (type === "removed") this.contactRemovedListeners.push(listener);
		if (type === "persisted") this.contactPersistedListeners.push(listener);
	}
	// remove a function from one of the contact listener arrays
	removeContactListener(listener: Function) {
		const indexAdded = this.contactAddedListeners.indexOf(listener);
		const indexRemoved = this.contactRemovedListeners.indexOf(listener);
		const indexPersisted = this.contactPersistedListeners.indexOf(listener);

		if (indexAdded !== -1) {
			this.contactAddedListeners.splice(indexAdded, 1);
		} else if (indexRemoved !== -1) {
			this.contactRemovedListeners.splice(indexRemoved, 1);
		} else if (indexPersisted !== -1) {
			this.contactPersistedListeners.splice(indexPersisted, 1);
		}
	}
	// get the value of a contact pair
	isContacting(handle: number) {
		return this.contacts.get(handle) || 0;
	}
	//* Updates ===============================================
	//this will be called in loop functions
	update(position: anyVec3, rotation: Jolt.Quat | THREE.Quaternion) {
		// if this is a mesh, use basic updates
		if (!this.isInstance) {
			this.object.position.copy(vec3.three(position));
			this.object.quaternion.copy(quat.three(rotation));
			return;
		}
		// we are an instance. we have to build a matrix
		const matrix = new Matrix4();
		matrix.compose(vec3.three(position), quat.three(rotation), this.scale);
		// update the matrix
		this.setMatrix(matrix);
	}

	//* Direct Manipulation ===================================
	// destroy the body
	destroy(ignoreThree?: boolean) {
		this.bodySystem.removeBody(this.handle, ignoreThree);
	}
	// probably only used for instances
	getMatrix(matrix: Matrix4) {
		if (this.isInstance) {
			const object = this.object as THREE.InstancedMesh;
			object.getMatrixAt(this.index!, matrix);
		} else matrix.copy(this.object.matrixWorld);
		return matrix;
	}
	setMatrix(matrix: Matrix4) {
		if (this.isInstance) {
			const object = this.object as THREE.InstancedMesh;
			object.setMatrixAt(this.index!, matrix);
			object.instanceMatrix.needsUpdate = true;
		} else {
			this.object.matrix.copy(matrix);
			this.object.updateMatrixWorld(true);
		}
		// TODO: determine if we will really use this or not
		/*
        // now that the threeJS object is updated, we need to set the jolt body
        if (!ignoreJolt) {
            const position = this.object.position.clone();
            const rotation = this.object.quaternion.clone();
            this.position = position;
            this.rotation = rotation;
        }
        */
	}

	// Set the body position
	// TODO: NOTE. This is how to correctly cleanup a Jolt Vector
	set position(position) {
		const newPosition = vec3.jolt(position);
		this.bodyInterface.SetPosition(this.BodyID, newPosition, Raw.module.EActivation_Activate);
		Raw.module.destroy(newPosition);
	}
	// get the position of the body and wrap it in a three vector
	getPosition(asJolt?: boolean): THREE.Vector3 | Jolt.Vec3 {
		if (asJolt) return this.bodyInterface.GetPosition(this.BodyID) as Jolt.Vec3;
		return vec3.joltToThree(this.bodyInterface.GetPosition(this.BodyID) as Jolt.Vec3);
	}
	get position(): THREE.Vector3 {
		return this.getPosition() as THREE.Vector3;
	}
	// Set the body rotation
	set rotation(rotation: THREE.Quaternion) {
		const newQuat = quat.jolt(rotation);
		this.bodyInterface.SetRotation(
			this.BodyID,
			// TODO: This is probably leaky
			newQuat,
			Raw.module.EActivation_Activate
		);
		Raw.module.destroy(newQuat);
	}
	// get the rotation of the body and wrap it in a three quaternion
	get rotation(): THREE.Quaternion {
		return quat.joltToThree(this.body.GetRotation());
	}
	// set both position and rotation
	setPositionAndRotation(position: THREE.Vector3, rotation: THREE.Quaternion) {
		this.position = position;
		this.rotation = rotation;
	}
	// physics related getters and setters
	// get the velocity of the body
	get velocity() {
		return vec3.three(this.body.GetLinearVelocity());
	}
	// set the velocity of the body
	set velocity(velocity: Vector3) {
		const newVec = vec3.jolt(velocity);
		this.body.SetLinearVelocity(newVec);
		Raw.module.destroy(newVec);
	}
	// get the angular velocity of the body
	get angularVelocity() {
		return vec3.three(this.body.GetAngularVelocity());
	}
	// set the angular velocity of the body
	set angularVelocity(angularVelocity: Vector3) {
		const newVec = vec3.jolt(angularVelocity);
		this.body.SetAngularVelocity(newVec);
		Raw.module.destroy(newVec);
	}
	get color(): THREE.Color {
		// if we are a mesh, get the material color of the mesh
		if (!this.isInstance) {
			//@ts-ignore color does exist
			return (this.object as THREE.Mesh).material.color;
		}
		// if we are an instance, get the color of the instanced mesh
		const _color = new THREE.Color();
		(this.object as InstancedMesh).getColorAt(this.index!, _color);
		return _color;
	}
	set color(color: THREE.Color | string | number) {
		color = color instanceof THREE.Color ? color : new THREE.Color(color);
		// if we are a mesh, set the material color of the mesh
		if (!this.isInstance) {
			//@ts-ignore
			(this.object as THREE.Mesh).material.color = color;
		}
		// if we are an instance, set the color of the instanced mesh
		(this.object as InstancedMesh).setColorAt(this.index!, color);
	}

	//* Physics Properties ----------------------------------
	// sensors
	get isSensor() {
		return this.body.IsSensor();
	}
	set isSensor(isSensor: boolean) {
		this.body.SetIsSensor(isSensor);
	}
	//friction
	get friction() {
		return this.body.GetFriction();
	}
	set friction(friction: number) {
		this.body.SetFriction(friction);
	}
	//restitution
	set restitution(restitution: number) {
		this.body.SetRestitution(restitution);
	}
	get restitution() {
		return this.body.GetRestitution();
	}
	get angularDamping() {
		return this.body.GetMotionProperties().GetAngularDamping();
	}
	set angularDamping(damping: number) {
		this.body.GetMotionProperties().SetAngularDamping(damping);
	}
	get linearDamping() {
		return this.body.GetMotionProperties().GetLinearDamping();
	}
	set linearDamping(damping: number) {
		this.body.GetMotionProperties().SetLinearDamping(damping);
	}
	get gravityFactor() {
		return this.body.GetMotionProperties().GetGravityFactor();
	}
	set gravityFactor(factor: number) {
		this.body.GetMotionProperties().SetGravityFactor(factor);
	}
	get mass() {
		return this.body.GetShape().GetMassProperties().mMass;
	}
	set mass(mass: number) {
		this.bodySystem.setMass(this.handle, mass);
	}

	//* Group Filtering ----------------------------------
	get group() {
		return this.body.GetCollisionGroup().GetGroupID();
	}
	set group(group: number) {
		// if we aren't using the core collisionGroup we need to change to it
		/* we can't use this yet becuase the SetCollisionGroup method isnt exposed
		if (!this.collisionGroupChanged) {
			this.body.SetCollisionGroup(this.bodySystem.standardCollisionGroup);
			this.collisionGroupChanged = true;
		}
		*/

		// set the group
		this.body.GetCollisionGroup().SetGroupID(group);
	}
	get subGroup() {
		return this.body.GetCollisionGroup().GetSubGroupID();
	}
	set subGroup(subGroup: number) {
		this.body.GetCollisionGroup().SetSubGroupID(subGroup);
	}

	//* Force Manipulation ----------------------------------
	// apply a force to the body
	applyForce(force: Vector3) {
		const newVec = vec3.jolt(force);
		this.body.AddForce(newVec);
		Raw.module.destroy(newVec);
	}
	// apply a torque to the body
	applyTorque(torque: Vector3) {
		const newVec = vec3.jolt(torque);
		this.body.AddTorque(newVec);
		Raw.module.destroy(newVec);
	}
	// add impulse to the body
	addImpulse(impulse: Vector3) {
		//console.log("adding impulse", impulse);
		const newVec = vec3.jolt(impulse);
		this.body.AddImpulse(newVec);
		Raw.module.destroy(newVec);
	}
	//move kinematic
	moveKinematic(position: Vector3, rotation: THREE.Quaternion, deltaTime = 0) {
		const newVec = vec3.jolt(position);
		const newQuat = rotation ? quat.jolt(rotation) : new Raw.module.Quat(0, 0, 0, 1);

		this.bodyInterface.MoveKinematic(this.BodyID, newVec, newQuat, deltaTime);
		Raw.module.destroy(newVec);
		Raw.module.destroy(newQuat);
	}

	//* Motion Source ----------------------------------
	// activate the impulse source
	activateMotionSource(linearVector = new THREE.Vector3(), angularVector?: THREE.Vector3) {
		this.motionActive = true;
		this.isMotionSource = true;
		this.motionType = angularVector ? "angular" : "linear";
		this.motionLinearVector = linearVector;
		if (angularVector) this.motionAngularVector = angularVector;
		// if you want to use the normal for a bouncepad call it separately

		// add the listeners
		this.addContactListener(this.motionAddedListener, "added");
		this.addContactListener(this.motionAddedListener, "persisted");
	}
	motionAddedListener = (
		body1Handle: number,
		body2Handle: number,
		manifold: Jolt.ContactManifold,
		settings: Jolt.ContactSettings
	) => {
		// get the body states of the two bodies
		const body1 = this.bodySystem.getBody(body1Handle);
		const body2 = this.bodySystem.getBody(body2Handle);
		if (!body1 || !body2) return;
		// get body rotations
		const rotation1 = body1.rotation;
		const rotation2 = body2.rotation;
		const targetBody = body1.isMotionSource ? body2 : body1;
		const sourceBody = body1.isMotionSource ? body1 : body2;

		//if this is a teleporter
		if (sourceBody.isTeleporter) {
			//the target position is the linear vector
			const target = sourceBody.motionLinearVector;
			this.bodySystem.createPendingAction("position", targetBody.handle, target);
			// if the angle is set we'll use that for rotation
			if (sourceBody.motionAngularVector)
				this.bodySystem.createPendingAction(
					"rotation",
					targetBody.handle,
					sourceBody.motionAngularVector
				);
			// bail
			return undefined;
		}
		// we need to determine which type of force to add
		//let doLinear = false;
		//if (body1.isMotionSource && body1.motionType === "linear") doLinear = true;
		//if (body2.isMotionSource && body2.motionType === "linear") doLinear = true;

		if (sourceBody.motionType === "linear") {
			// get the linear vector
			const linearVector =
				body1.motionLinearVector?.clone() ||
				body2.motionLinearVector?.clone() ||
				new THREE.Vector3(-10, 0, 0);
			if (sourceBody.motionAsSurfaceVelocity) {
				// this seems like the wrong way to do this but I'll follow the original example
				// Determine the world space surface velocity of both bodies
				const cLocalSpaceVelocity = linearVector?.clone();
				const body1LinearSurfaceVelocity = body1.isMotionSource
					? cLocalSpaceVelocity.applyQuaternion(rotation1)
					: new THREE.Vector3(0, 0, 0);
				const body2LinearSurfaceVelocity = body2.isMotionSource
					? cLocalSpaceVelocity.applyQuaternion(rotation2)
					: new THREE.Vector3(0, 0, 0);
				const v = body2LinearSurfaceVelocity.sub(body1LinearSurfaceVelocity);
				settings.mRelativeLinearSurfaceVelocity.Set(v.x, v.y, v.z);
			} else {
				// do it as an impulse
				// THis could be dangerous because it uses the bodyInterface to apply impulse
				if (this.useRotation) linearVector.applyQuaternion(sourceBody.rotation);
				targetBody.addImpulse(linearVector);
			}
		}
		// angular
		if (sourceBody.motionType === "angular") {
			if (sourceBody.motionAsSurfaceVelocity) {
				const cLocalSpaceAngularVelocity = new THREE.Vector3(
					0,
					THREE.MathUtils.degToRad(10.0),
					0
				);
				const body1AngularSurfaceVelocity = body1.isMotionSource
					? cLocalSpaceAngularVelocity.applyQuaternion(rotation1)
					: new THREE.Vector3(0, 0, 0);
				const body2AngularSurfaceVelocity = body2.isMotionSource
					? cLocalSpaceAngularVelocity.applyQuaternion(rotation2)
					: new THREE.Vector3(0, 0, 0);

				// Note that the angular velocity is the angular velocity around body 1's center of mass, so we need to add the linear velocity of body 2's center of mass
				const COM1 = vec3.three(body1.body.GetCenterOfMassPosition());
				const COM2 = vec3.three(body2.body.GetCenterOfMassPosition());
				const body2LinearSurfaceVelocity = body2.isMotionSource
					? body2AngularSurfaceVelocity.cross(COM1.clone().sub(COM2))
					: new THREE.Vector3(0, 0, 0);

				// Calculate the relative angular surface velocity
				const rls = body2LinearSurfaceVelocity;
				settings.mRelativeLinearSurfaceVelocity.Set(rls.x, rls.y, rls.z);
				const ras = body2AngularSurfaceVelocity.sub(body1AngularSurfaceVelocity);
				settings.mRelativeAngularSurfaceVelocity.Set(ras.x, ras.y, ras.z);
			} else {
				const angularVector =
					body1.motionAngularVector?.clone() ||
					body2.motionAngularVector?.clone() ||
					new THREE.Vector3(0, 0, 0);
				this.bodySystem.createPendingAction(
					"applyTorque",
					targetBody.handle,
					angularVector
				);
			}
		}
	};
	motionRemovedListener = (
		body1: Jolt.BodyID,
		body2: Jolt.BodyID,
		manifold: Jolt.ContactManifold,
		settings: Jolt.ContactSettings
	) => {};
}
