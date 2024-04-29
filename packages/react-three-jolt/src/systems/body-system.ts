// This class holds the bodies and the management of them
import type Jolt from "jolt-physics";
import {
	//MathUtils,
	//    Matrix4,
	Object3D,
	// Quaternion,
	Vector3,
	InstancedMesh
} from "three";
import * as THREE from "three";
import { Raw } from "../raw";

import { vec3, quat } from "../utils";
import { BodyState } from "./body-state";
import { Layer } from "../constants";
import {
	ShapeSystem,
	getShapeSettingsFromObject,
	generateHeightfieldShapeFromThree,
	createMeshForShape,
	AutoShape
} from "./shape-system";

// TYPES ========================================
export type BodyType = "dynamic" | "static" | "kinematic" | "rig";
export type PendingAction = { action: string; handle: number; value: any };

// We call things "bodySettings" to clarify from shapes or other similar labels
export interface GenerateBodyOptions {
	bodyType?: "dynamic" | "static" | "kinematic" | "rig";
	bodySettings?: Jolt.BodyCreationSettings;
	motionType?: "static" | "kinematic" | "dynamic";
	index?: number;
	shapeType?: AutoShape;
	activation?: "activate" | "deactivate";
	jitter?: THREE.Vector3;
	mass?: number;
	size?: THREE.Vector3;
	group?: number;
	subGroup?: number;
}

// ================================================
export class BodySystem {
	jolt = Raw.module;
	dynamicBodies = new Map<number, BodyState>();
	staticBodies = new Map<number, BodyState>();
	kinematicBodies = new Map<number, BodyState>();

	// pending actions to be called at the begining of a frame
	//todo: type these
	pendingActions: PendingAction[] = [];

	joltPhysicsSystem: Jolt.PhysicsSystem;
	bodyInterface: Jolt.BodyInterface;

	shapeSystem: ShapeSystem;

	// lets defaults be set at the physics system level
	defaultBodySettings: any = {};

	standardGroupFilter = new Raw.module.GroupFilterJS();
	standardCollisionGroup = new Raw.module.CollisionGroup();

	constructor(joltPhysicsSystem: Jolt.PhysicsSystem) {
		// set the interfaces
		this.joltPhysicsSystem = joltPhysicsSystem;
		this.bodyInterface = this.joltPhysicsSystem.GetBodyInterface();

		this.shapeSystem = new ShapeSystem(this.joltPhysicsSystem);

		// Activate the listeners
		this.initializeActivationListeners();
		this.initializeContactListeners();
		this.initializeGroupFilter();
	}
	//* Initializers ===================================
	initializeGroupFilter() {
		this.standardGroupFilter.CanCollide = (inGroup1, inGroup2) => {
			// we have to wrap these to access them
			const group1 = Raw.module.wrapPointer(inGroup1, Raw.module.CollisionGroup);
			const group2 = Raw.module.wrapPointer(inGroup2, Raw.module.CollisionGroup);

			// because either group may be a subgroup we have to test both
			const activeSubGroups = [false, false, false];
			const sameGroup = group1.GetGroupID() === group2.GetGroupID();

			const subGroup1 = group1.GetSubGroupID();
			const subGroup2 = group2.GetSubGroupID();
			activeSubGroups[subGroup1] = true;
			activeSubGroups[subGroup2] = true;

			// group 2 ONLY collides if the groups match, so we need to test it first
			if (activeSubGroups[2] && sameGroup) return true;
			// if the groups are different and group 2 isnt active
			if (!activeSubGroups[2] && !sameGroup) return true;
			// from now on the main group is always the same
			// if both are group 1, they collide
			if (subGroup1 === 1 && subGroup2 === 1) return true;

			//console.log('group filter', group1, group2);
			return false;
		};
		this.standardCollisionGroup.SetGroupFilter(this.standardGroupFilter);
	}

	//* Body Management ================================
	// create a body from an object
	createBody(object: Object3D, options: GenerateBodyOptions = {}): Jolt.Body {
		let settings = generateBodySettings(object, options);
		// if there are properties in the default, merge them with settings
		if (Object.keys(this.defaultBodySettings).length > 0) {
			settings = mergeBodyCreationSettings(settings, this.defaultBodySettings);
		}
		// todo: remove this once we change collision group at runtime
		//console.log("options", options);
		if (options.group !== undefined || options.subGroup !== undefined) {
			settings.mCollisionGroup = this.standardCollisionGroup;
			if (options.group !== undefined) {
				settings.mCollisionGroup.SetGroupID(options.group);
			}
			if (options.subGroup !== undefined)
				settings.mCollisionGroup.SetSubGroupID(options.subGroup);
		}

		const body = this.bodyInterface.CreateBody(settings);
		// remove the settings
		this.jolt.destroy(settings);
		return body;
	}
	addBody(object: Object3D, options?: GenerateBodyOptions) {
		const body = this.createBody(object, options);
		//console.log('adding body', object, body);
		return this.addExistingBody(object, body, options);
	}
	// add an EXISTING Jolt body to the system
	addExistingBody(
		object: Object3D | InstancedMesh,
		body: Jolt.Body,
		options?: GenerateBodyOptions
	): number {
		const state = new BodyState(object, body, this.joltPhysicsSystem, this, options?.index);
		// generate the handle
		const handle = body.GetID().GetIndexAndSequenceNumber();
		// console.log('adding body', handle, options, state, object, body);
		// add to the correct map
		if (options?.bodyType === "static") this.staticBodies.set(handle, state);
		else if (options?.bodyType === "kinematic") this.kinematicBodies.set(handle, state);
		else this.dynamicBodies.set(handle, state);

		// allow to add the body but not activate it
		let activationState = Raw.module.EActivation_Activate;
		if (options?.activation) {
			switch (options.activation) {
				case "activate":
					activationState = Raw.module.EActivation_Activate;
					break;
				case "deactivate":
					activationState = Raw.module.EActivation_DontActivate;
					break;
			}
		}

		// VERY IMPORTANT! ADD TO THE ACTUAL SIMULATION
		this.bodyInterface.AddBody(body.GetID(), activationState);
		return handle;
	}
	getBody(handle: number) {
		return (
			this.dynamicBodies.get(handle) ||
			this.staticBodies.get(handle) ||
			this.kinematicBodies.get(handle)
		);
	}
	removeBody(bodyHandle: number, ignoreThree = false) {
		//console.log('Trying to remove body', bodyHandle);
		// get the body so we can process it
		const bodyState = this.getBody(bodyHandle);
		if (!bodyState) return;
		// check if the body exists in the simulation
		// first check the simulation is still here (might be removed after physics is removed)
		if (!this.joltPhysicsSystem) return;
		if (!this.bodyInterface) return;
		const bodyID = bodyState.body.GetID();
		const body = this.joltPhysicsSystem.GetBodyLockInterfaceNoLock().TryGetBody(bodyID);
		if (!body) {
			console.warn("body getter failed during delete", bodyHandle);
			return;
		}

		if (!this.bodyInterface.IsAdded(bodyID)) {
			// console.log('body already removed');
			return;
		}

		// remove the body from the simulation
		this.bodyInterface.RemoveBody(bodyID);
		// destroy it
		this.bodyInterface.DestroyBody(bodyID);
		// remove it from threeJS by removing it from it's parent
		// only if its not an instanced mesh or explicitly told to ignore.
		if (!bodyState.isInstance || ignoreThree) bodyState.object.parent?.remove(bodyState.object);
		// remove it from the maps

		this.dynamicBodies.delete(bodyHandle);
		this.staticBodies.delete(bodyHandle);
		this.kinematicBodies.delete(bodyHandle);
		// console.log('Removed body', bodyHandle);
	}

	// There's probably a better pattern, but im making my own function for this
	public addHeightfield(planeMesh: THREE.Mesh): number {
		//const position = vec3.threeToJolt(planeMesh.position);
		// const quaternion = quat.threeToJolt(planeMesh.quaternion);
		const shapeSettings = generateHeightfieldShapeFromThree(planeMesh);
		//const position = new Raw.module.Vec3(0, -20, 0); // The image tends towards 'white', so offset it down closer to zero
		const quaternion = new Raw.module.Quat(0, 0, 0, 1);
		//@ts-ignore
		const shape: Jolt.HeightFieldShape = shapeSettings.Create().Get();
		const size = shapeSettings.mSampleCount;
		//@ts-ignore  yes it does exist
		const planeWidth = planeMesh.geometry.parameters.width;
		const scale = planeWidth / size;
		const offset = -size * scale * 0.5;
		const position = new Raw.module.Vec3(
			offset + planeMesh.position.x,
			planeMesh.position.y,
			planeMesh.position.z + offset
		);

		const creationSettings = new Raw.module.BodyCreationSettings(
			shape,
			position,
			quaternion,
			Raw.module.EMotionType_Static,
			Layer.NON_MOVING
		);
		const body = this.bodyInterface.CreateBody(creationSettings);
		// cleanup before returning
		this.jolt.destroy(shapeSettings);
		this.jolt.destroy(creationSettings);
		//TODO: One of these causes a crash.
		// this.jolt.destroy(position);
		//this.jolt.destroy(quaternion);
		//this.jolt.destroy(shape);
		return this.addExistingBody(planeMesh, body, { bodyType: "static" });
	}
	//* Body Modification ===================================
	// change the mass of a body
	setMass(bodyHandle: number, mass: number) {
		const body = this.getBody(bodyHandle);
		if (!body) return;
		changeMassInertia(body.body, mass);
	}

	//* Loop Functions ===================================
	createPendingAction(action: string, handle: number, value: any) {
		this.pendingActions.push({ action, handle, value });
	}
	handlePendingActions() {
		if (!this.pendingActions.length) return;
		// { action: string, handle: number, value: any }
		// lets try this first utilizing setters
		this.pendingActions.forEach((action) => {
			const body = this.getBody(action.handle);
			if (!body) return;

			switch (action.action) {
				case "mass":
					body.mass = action.value;
					break;
				case "position":
					body.position = action.value;
					break;
				case "rotation":
					body.rotation = action.value;
					break;
				case "applyTorque":
					body.applyTorque(action.value);
					break;
				case "applyForce":
					body.applyForce(action.value);
					break;
				case "addImpulse":
					body.addImpulse(action.value);
					break;
			}
		});
		// clear the actions
		this.pendingActions = [];
	}

	// Activation Listeners ================================
	//@ts-ignore
	private initializeActivationListeners() {
		const activationListener = new Raw.module.BodyActivationListenerJS();
		//@ts-ignore
		activationListener.OnBodyActivated = (bodyId: Jolt.BodyID) => {
			//@ts-ignore wrapPointer bug
			bodyId = Raw.module.wrapPointer(bodyId, Raw.module.BodyID);
			this.triggerActivationListeners(bodyId.GetIndexAndSequenceNumber());
		};
		//@ts-ignore
		activationListener.OnBodyDeactivated = (bodyId: Jolt.BodyID) => {
			//@ts-ignore wrapPointer bug
			bodyId = Raw.module.wrapPointer(bodyId, Raw.module.BodyID);
			this.triggerActivationListeners(bodyId.GetIndexAndSequenceNumber());
		};

		this.joltPhysicsSystem.SetBodyActivationListener(activationListener);
	}
	private triggerActivationListeners(handle: number) {
		// go through the body system and trigger the activation listeners{
		const body = this.getBody(handle);
		if (!body) return;

		body.activationListeners.forEach((listener) => listener(body));
	}

	// Contact Listeners ===================================
	//@ts-ignore
	private initializeContactListeners() {
		const contactListener = new Raw.module.ContactListenerJS();
		//@ts-ignore
		contactListener.OnContactAdded = (
			body1: Jolt.Body,
			body2: Jolt.Body,
			manifold: Jolt.ContactManifold,
			settings: Jolt.ContactSettings
		) => {
			//@ts-ignore
			body1 = Raw.module.wrapPointer(body1, Raw.module.Body);
			//@ts-ignore
			body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
			const body1Handle = body1.GetID().GetIndexAndSequenceNumber();
			const body2Handle = body2.GetID().GetIndexAndSequenceNumber();
			//@ts-ignore
			manifold = Raw.module.wrapPointer(manifold, Raw.module.ContactManifold);
			//@ts-ignore
			settings = Raw.module.wrapPointer(settings, Raw.module.ContactSettings);
			// get the contact count, if it doesn't exist we are creating it
			const body1State = this.getBody(body1Handle);
			//@ts-ignore
			let isContacting = body1State.isContacting(body2Handle);

			// check the body contact threshold as we may have JUST been in contact
			// even if isCOntacting is 0
			if (isContacting === 0) {
				const timestamp = Date.now();
				const lastFinalRemoval =
					//@ts-ignore it'll come back
					body1State!.contactTimestamps.get(body2Handle);
				if (
					lastFinalRemoval &&
					//@ts-ignore
					timestamp - lastFinalRemoval < body1State.contactThreshold
				) {
					isContacting = 1;
				}
			}

			// add the contact pair
			const numContacts = this.addContactPair(
				body1.GetID().GetIndexAndSequenceNumber(),
				body2.GetID().GetIndexAndSequenceNumber()
			);
			/* This doesn't seem to work

            const subshape1 = manifold.mSubShapeID1;
            const subshape2 = manifold.mSubShapeID2;
            console.log('subshape1', subshape1.GetValue());
            */
			this.triggerContactListeners(
				body1.GetID().GetIndexAndSequenceNumber(),
				body2.GetID().GetIndexAndSequenceNumber(),
				"added",
				isContacting ? "additional" : "new", // 'new' or 'additional'
				numContacts,
				manifold,
				settings
			);
		};
		//@ts-ignore
		contactListener.OnContactPersisted = (
			body1: Jolt.Body,
			body2: Jolt.Body,
			manifold: Jolt.ContactManifold,
			settings: Jolt.ContactSettings
		) => {
			//@ts-ignore
			body1 = Raw.module.wrapPointer(body1, Raw.module.Body);
			//@ts-ignore
			body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
			//@ts-ignore
			manifold = Raw.module.wrapPointer(manifold, Raw.module.ContactManifold);
			//@ts-ignore
			settings = Raw.module.wrapPointer(settings, Raw.module.ContactSettings);
			//@ts-ignore
			const numContacts = this.getBody(
				body1.GetID().GetIndexAndSequenceNumber()
			).isContacting(body2.GetID().GetIndexAndSequenceNumber());
			this.triggerContactListeners(
				body1.GetID().GetIndexAndSequenceNumber(),
				body2.GetID().GetIndexAndSequenceNumber(),
				"persisted",
				"persisted",
				numContacts,
				manifold,
				settings
			);
		};
		// removed uses a weird subshapepair argument
		//@ts-ignore
		contactListener.OnContactRemoved = (subShapePair: Jolt.SubShapeIDPair) => {
			//@ts-ignore
			subShapePair = Raw.module.wrapPointer(subShapePair, Raw.module.SubShapeIDPair);
			const numContacts = this.removeContactPair(
				subShapePair.GetBody1ID().GetIndexAndSequenceNumber(),
				subShapePair.GetBody2ID().GetIndexAndSequenceNumber()
			);
			let isFinalRemoval = false;
			if (!numContacts) {
				const bodyState1 = this.getBody(
					subShapePair.GetBody1ID().GetIndexAndSequenceNumber()
				);
				if (bodyState1)
					//@ts-ignore
					bodyState1.contactTimestamps.set(
						subShapePair.GetBody2ID().GetIndexAndSequenceNumber(),
						Date.now()
					);
				isFinalRemoval = true;
			}
			this.triggerContactListeners(
				subShapePair.GetBody1ID().GetIndexAndSequenceNumber(),
				subShapePair.GetBody2ID().GetIndexAndSequenceNumber(),
				"removed",
				isFinalRemoval ? "final" : "removed",
				numContacts
			);
		};

		// for now we aren't messing with validated but its required
		contactListener.OnContactValidate = () => {
			return Raw.module.ValidateResult_AcceptAllContactsForThisBodyPair;
		};

		this.joltPhysicsSystem.SetContactListener(contactListener);
	}
	private triggerContactListeners(
		body1: number,
		body2: number,
		type: string,
		context: string,
		numContacts?: number,
		manifold?: Jolt.ContactManifold,
		settings?: Jolt.ContactSettings
	) {
		// go through the body system and trigger the contact listeners
		const bodyState1 = this.getBody(body1);
		const bodyState2 = this.getBody(body2);
		if (!bodyState1 || !bodyState2) return;
		// do both bodies
		for (let i = 0; i < 2; i++) {
			const body = i === 0 ? bodyState1 : bodyState2;
			const target =
				type === "added"
					? body.contactAddedListeners
					: type === "persisted"
						? body.contactPersistedListeners
						: body.contactRemovedListeners;
			if (target.length)
				target.forEach((listener) =>
					listener(body1, body2, manifold, settings, numContacts, context)
				);
		}
	}

	// Contact Pairing ===================================

	// add contact to body
	private addContactToBody(body: BodyState, contact: number) {
		// see if the contact exists, if so increment it
		//@ts-ignore
		const current = body.contacts.get(contact);
		if (current) {
			//@ts-ignore
			body.contacts.set(contact, current + 1);
			return current + 1;
		}
		// otherwise set it to 1
		//@ts-ignore
		body.contacts.set(contact, 1);
		return 1;
	}
	// remove contact from body
	private removeContactFromBody(body: BodyState, contact: number) {
		//@ts-ignore
		const current = body.contacts.get(contact);
		if (current) {
			if (current === 1) {
				//@ts-ignore
				body.contacts.delete(contact);
				return 0;
			} //@ts-ignore
			body.contacts.set(contact, current - 1);
			return current - 1;
		}
		return 0;
	}

	private addContactPair(body1Handle: number, body2Handle: number) {
		const body1 = this.getBody(body1Handle);
		const body2 = this.getBody(body2Handle);
		// early bail;
		if (!body1 || !body2) return 0;
		// add the contact to both bodies
		this.addContactToBody(body1, body2Handle);
		this.addContactToBody(body2, body1Handle);
		// return the new count
		return body1.isContacting(body2Handle);
	}
	private removeContactPair(body1Handle: number, body2Handle: number) {
		const body1 = this.getBody(body1Handle);
		const body2 = this.getBody(body2Handle);
		// early bail;
		if (!body1 || !body2) return 0;
		// remove the contact from both bodies
		this.removeContactFromBody(body1, body2Handle);
		this.removeContactFromBody(body2, body1Handle);
		// return the new count
		return body1.isContacting(body2Handle);
	}
}

// Jolt Utilities =================================
// merge jolt Settings with optional object
export function mergeBodyCreationSettings(
	settings: Jolt.BodyCreationSettings,
	options?: Jolt.BodyCreationSettings
) {
	if (!options) return settings;
	// loop over the object keys and set the settings
	for (const key in options) {
		// @ts-ignore
		settings[key] = options[key];
	}
	return settings;
}

export function generateBodySettings(
	object: Object3D | Jolt.ShapeSettings,
	options: GenerateBodyOptions = {}
): Jolt.BodyCreationSettings {
	const jolt = Raw.module;
	const isObject = object instanceof Object3D;
	// can I move this into the args?
	const { bodyType = "dynamic", shapeType } = options;
	// Generate or pass along the shape settings
	const shapeSettings = isObject ? getShapeSettingsFromObject(object, shapeType) : object;
	if (!shapeSettings) throw new Error("No shape settings found");
	// Due to a Jolt limitation we cant just pass the settings and have to generate the shape here
	const shape = shapeSettings.Create().Get();
	// TODO: do we need to destroy the shapeSettings?
	// jolt.destroy(shapeSettings);

	// create position and quaternion from three to jolt
	let position: any = new THREE.Vector3();
	let quaternion: any = new THREE.Quaternion();
	if (isObject) {
		position.copy(object.position);
		quaternion.copy(object.quaternion);
	}
	// Jitter fixes a problem where rapidly created bodies jam each other
	// also allows nice effects like fountains when creating bodies
	if (options.jitter) {
		// jitter is a vector3 with a max distance
		// generate a new vector3 with a random value between 0 and the jitter value for each axis
		const jitter = new THREE.Vector3(
			Math.random() * options.jitter.x,
			Math.random() * options.jitter.y,
			Math.random() * options.jitter.z
		);
		position.add(jitter);
		// jitter the rotation too
		quaternion.setFromEuler(
			new THREE.Euler(
				Math.random() * options.jitter.x,
				Math.random() * options.jitter.y,
				Math.random() * options.jitter.z
			)
		);
	}
	// reset the items to jolt types
	position = vec3.threeToJolt(position);
	quaternion = quat.threeToJolt(quaternion);

	// type bases on bodyType (Dynamic by default)
	let layer, motionType;
	switch (bodyType) {
		case "static":
			motionType = jolt.EMotionType_Static;
			layer = Layer.NON_MOVING;
			break;
		case "kinematic":
			motionType = jolt.EMotionType_Kinematic;
			layer = Layer.MOVING;
			break;
		case "rig":
			motionType = jolt.EMotionType_Dynamic;
			layer = Layer.RIG;
			//rigs need to have no gravity
			// TODO fix these type warnings
			/*
            if (!options?.mGravityFactor) {
                if (!options?.bodySettings) options.bodySettings = {};
                options!.bodySettings.mGravityFactor = 0;
            }*/
			break;

		default:
			motionType = jolt.EMotionType_Dynamic;
			layer = Layer.MOVING;
	}
	// if the user specefied a motionType we need to override the last switch
	if (options?.motionType) {
		switch (options.motionType) {
			case "static":
				motionType = jolt.EMotionType_Static;
				break;
			case "kinematic":
				motionType = jolt.EMotionType_Kinematic;
				break;
			default:
				motionType = jolt.EMotionType_Dynamic;
				layer = Layer.MOVING;
		}
	}
	// create the settings
	const settings = mergeBodyCreationSettings(
		new jolt.BodyCreationSettings(shape, position, quaternion, motionType, layer),
		options.bodySettings
	);
	// Trimesh override to add mass and inertia
	// see: https://jrouwe.github.io/JoltPhysics/#dynamic-mesh-shapes
	if (shapeType === "trimesh" && motionType === jolt.EMotionType_Dynamic) {
		settings.mOverrideMassProperties =
			Raw.module.EOverrideMassProperties_MassAndInertiaProvided;
		// if the object is an object we need to get the size from it
		let size;
		let mass = options?.mass || 200;
		if (isObject) {
			const box = new THREE.Box3().setFromObject(object);
			size = box.getSize(new Vector3());
		} else {
			size = options?.size || new THREE.Vector3(1, 1, 1);
		}
		//size = new jolt.Vec3(1, 1, 1);
		//console.log('trimesh size', size, mass);
		settings.mMassPropertiesOverride.SetMassAndInertiaOfSolidBox(vec3.jolt(size), mass);
	}
	// destroy the position and quaternion
	jolt.destroy(position);
	jolt.destroy(quaternion);
	// return the settings
	return settings;
}

// TODO: my base generators require three objects. perhaps abastract out or make better names

// Change a bodies mass settings after already being created
// src:PhoenixIllusion @ https://github.com/jrouwe/JoltPhysics.js/discussions/112
function changeMassInertia(body: Jolt.Body, mass: number) {
	const motionProps = body.GetMotionProperties();
	const massProps = body.GetShape().GetMassProperties();
	massProps.ScaleToMass(mass); //<--- newly exposed function
	motionProps.SetMassProperties(Raw.module.EAllowedDOFs_All, massProps);
}
/* og
export function changeMassInertia(body: Jolt.Body, mass: number) {
    const motionProps = body.GetMotionProperties();
    const massProps = body.GetShape().GetMassProperties();
    const inertia = massProps.mInertia;
    let mass_scale = massProps.mMass;
    if (mass_scale > 0) {
        mass_scale = mass / massProps.mMass;
    } else {
        mass_scale = mass;
    }
    inertia.SetAxisX(inertia.GetAxisX().Mul(mass_scale));
    inertia.SetAxisY(inertia.GetAxisY().Mul(mass_scale));
    inertia.SetAxisZ(inertia.GetAxisZ().Mul(mass_scale));
    massProps.mMass = mass;
    massProps.mInertia = inertia;
    motionProps.SetMassProperties(Raw.module.EAllowedDOFs_All, massProps);
}
*/

// When debugging we need to create a three debug object
// initially pulled from Jolt Demo,
export function getThreeObjectForBody(body: Jolt.Body, color = "#E07A5F") {
	let shape = body.GetShape();
	// lets see if we can get the material color by the shape
	// TODO this isn't in Jolt.js yet.

	//const physicsMaterial: Jolt.PhysicsMaterial = shape.GetMaterial();
	//const pmColor = physicsMaterial.GetDebugColor();
	const material = new THREE.MeshPhongMaterial({
		color: color,
		wireframe: true
	});

	let threeObject;

	let extent;
	switch (shape.GetSubType()) {
		case Raw.module.EShapeSubType_Box:
			shape = Raw.module.castObject(shape, Raw.module.BoxShape);
			//@ts-ignore
			extent = vec3.three(shape.GetHalfExtent()).multiplyScalar(2);
			threeObject = new THREE.Mesh(
				new THREE.BoxGeometry(extent.x, extent.y, extent.z, 1, 1, 1),
				material
			);
			break;
		case Raw.module.EShapeSubType_Sphere:
			shape = Raw.module.castObject(shape, Raw.module.SphereShape);
			threeObject = new THREE.Mesh(
				//@ts-ignore
				new THREE.SphereGeometry(shape.GetRadius(), 32, 32),
				material
			);
			break;
		case Raw.module.EShapeSubType_Capsule:
			shape = Raw.module.castObject(shape, Raw.module.CapsuleShape);
			threeObject = new THREE.Mesh(
				new THREE.CapsuleGeometry(
					//@ts-ignore
					shape.GetRadius(),
					//@ts-ignore
					2 * shape.GetHalfHeightOfCylinder(),
					20,
					10
				),
				material
			);
			break;
		case Raw.module.EShapeSubType_Cylinder:
			shape = Raw.module.castObject(shape, Raw.module.CylinderShape);
			threeObject = new THREE.Mesh(
				new THREE.CylinderGeometry(
					//@ts-ignore
					shape.GetRadius(),
					//@ts-ignore
					shape.GetRadius(),
					//@ts-ignore
					2 * shape.GetHalfHeight(),
					20,
					1
				),
				material
			);
			break;
		default:
			threeObject = new THREE.Mesh(createMeshForShape(shape), material);
			break;
	}

	threeObject.position.copy(vec3.three(body.GetPosition()));
	threeObject.quaternion.copy(quat.joltToThree(body.GetRotation()));

	return threeObject;
}
