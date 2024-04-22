/* We do this as a class so it's not bound to a react component
so much and can be reused for things like NPC's */

import * as THREE from "three";
import { MathUtils } from "three";
import type Jolt from "jolt-physics";
import { _matrix4, _position, _quaternion, _rotation, _scale, _vector3 } from "../tmp";
import {
	Raw,
	Layer,
	PhysicsSystem,
	quat,
	vec3,
	generateBodySettings,
	BodySystem
} from "@react-three/jolt";

interface CharacterFilters {
	objectVsBroadPhaseLayerFilter?: Jolt.ObjectVsBroadPhaseLayerFilter;
	objectLayerPairFilter?: Jolt.ObjectLayerPairFilter;
	movingBPFilter?: Jolt.DefaultBroadPhaseLayerFilter;
	movingLayerFilter?: Jolt.DefaultObjectLayerFilter;
	bodyFilter: Jolt.BodyFilter;
	shapeFilter: Jolt.ShapeFilter;
}

export class CharacterControllerSystem {
	joltInterface: Jolt.JoltInterface;
	physicsSystem: PhysicsSystem;
	bodySystem: BodySystem;

	// DO NOT MESS WITH THESE
	filters: CharacterFilters = {
		objectVsBroadPhaseLayerFilter: undefined,
		objectLayerPairFilter: undefined,
		movingBPFilter: undefined,
		movingLayerFilter: undefined,
		bodyFilter: new Raw.module.BodyFilter(),
		shapeFilter: new Raw.module.ShapeFilter()
	};

	private actionListeners = [];
	//private stateListeners = [];

	// configurable options

	characterHeightStanding = 2;
	characterRadiusStanding = 1;
	characterHeightCrouching = 1;
	characterRadiusCrouching = 0.8;

	// Character movement properties
	controlMovementDuringJump = true; ///< If false the character cannot change movement direction in mid air
	characterSpeed = 6;
	characterSpeedCrouched = 3.0;
	characterSpeedTired = 2.0;
	jumpSpeed = 15.0;

	enableCharacterInertia = true;
	// if the body turns on move input
	enableCharacterRotation = true;
	enableWalkStairs = true;
	enableStickToFloor = true;

	// Allows
	upRotationX = 0;
	upRotationZ = 0;
	predictiveContactDistance = 0.1;

	direction = new THREE.Vector3(0, 0, 0);
	velocity = new THREE.Vector3(0, 0, 0);

	public threeObject: any;

	// **Primary Holder Object ***
	character!: Jolt.CharacterVirtual;
	//rig anchor
	anchor: any;
	anchorID: any;
	// State properties ------------------------------
	isCrouched = false;
	allowSliding = false;
	allowSprinting = false;
	jumpLimit = 2;
	jumpDegradeFactor = 0.5;
	// to be removed --------------------------------
	geometry = new THREE.BoxGeometry(1, 1, 1);
	material = new THREE.MeshPhongMaterial({ color: 0xffff00 });
	threeCharacter = new THREE.Mesh(this.geometry, this.material);
	//-------------------------------------------

	private updateSettings = new Raw.module.ExtendedUpdateSettings();

	// private properties
	//active speed allows variable running speeds
	private activeSpeed = 6;
	// shapes of the character
	private activeStandingShape!: Jolt.Shape;
	private activeCrouchingShape!: Jolt.Shape;
	standingGeometry!: THREE.BufferGeometry;
	crouchingGeometry!: THREE.BufferGeometry;

	private characterContactListener: any;
	// Rotation properties
	currentRotation = new THREE.Quaternion();
	targetRotation = new THREE.Quaternion();
	maxRotationSpeed = 0.1; //radians per frame
	currentRotationSlerp = 0;
	isRotating = false;

	// movement vectors
	private movementInput = new THREE.Vector3();
	private desiredVelocity = new THREE.Vector3();
	private jumpCounter = 0;
	private isJumping = false;
	lerpFactor = 0.4;

	// testing props
	oldPosition = new THREE.Vector3();

	// Temp variables
	//TODO remove this for global temps
	private _tmpVec3 = new Raw.module.Vec3();

	constructor(physicsSystem: PhysicsSystem) {
		this.physicsSystem = physicsSystem;
		this.joltInterface = physicsSystem.joltInterface;
		this.bodySystem = physicsSystem.bodySystem;
		// Filters
		this.filters.objectVsBroadPhaseLayerFilter =
			this.joltInterface.GetObjectVsBroadPhaseLayerFilter();
		this.filters.objectLayerPairFilter = this.joltInterface.GetObjectLayerPairFilter();
		this.filters.movingBPFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
			this.filters.objectVsBroadPhaseLayerFilter,
			Layer.MOVING
		);
		this.filters.movingLayerFilter = new Raw.module.DefaultObjectLayerFilter(
			this.filters.objectLayerPairFilter,
			Layer.MOVING
		);

		// Init the character contact listener
		this.initCharacterContactListener();
		// Set a default shape size (know it will be overwritten by the user
		this.setCapsule(1, 2);
		this.initCharacter();
		this.physicsSystem.addPreStepListener((deltaTime: number) =>
			this.prePhysicsUpdate(deltaTime)
		);
	}
	// cleanup
	destroy() {
		console.log("Character wants to destroy...");
		//todo: destroy the character
	}
	//* Properties ========================================
	get shape() {
		return this.character.GetShape();
	}
	set shape(shape: Jolt.Shape) {
		this.character.SetShape(
			shape,
			1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
			//@ts-ignore
			this.filters.movingBPFilter,
			this.filters.movingLayerFilter,
			this.filters.bodyFilter,
			this.filters.shapeFilter,
			this.joltInterface.GetTempAllocator()
		);
	}
	get standingShape() {
		return this.activeStandingShape;
	}
	set standingShape(shape: Jolt.Shape) {
		this.activeStandingShape = shape;
		//TODO create geometry based on this shape for debugging
	}
	get crouchingShape() {
		return this.activeCrouchingShape;
	}
	set crouchingShape(shape: Jolt.Shape) {
		this.activeCrouchingShape = shape;
		//TODO create geometry based on this shape for debugging
	}

	// Position and movement ------------------------------
	get linearVelocity(): THREE.Vector3 {
		return vec3.three(this.character.GetLinearVelocity());
	}
	set linearVelocity(value: THREE.Vector3) {
		const newVec = vec3.jolt(value);
		this.character.SetLinearVelocity(newVec);
		Raw.module.destroy(newVec);
	}
	get position(): THREE.Vector3 {
		return vec3.three(this.character.GetPosition());
	}
	set position(value: THREE.Vector3) {
		const newVec = vec3.jolt(value);
		this.character.SetPosition(newVec);
		Raw.module.destroy(newVec);
	}
	get rotation(): THREE.Quaternion {
		return quat.three(this.character.GetRotation());
	}
	set rotation(value: THREE.Quaternion) {
		const newQuat = quat.jolt(value);
		this.character.SetRotation(newQuat);
		Raw.module.destroy(newQuat);
	}
	//read-only
	get worldTransform(): THREE.Matrix4 {
		const transform = this.character.GetWorldTransform();
		//TODO are these references or new objects that need destroying?
		const position = vec3.three(transform.GetTranslation());
		const rotation = quat.three(transform.GetQuaternion());
		return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
	}
	// read-only
	get centerOfMassTransform(): THREE.Matrix4 {
		const transform = this.character.GetCenterOfMassTransform();
		//TODO are these references or new objects that need destroying?
		const position = vec3.three(transform.GetTranslation());
		const rotation = quat.three(transform.GetQuaternion());
		return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
	}
	get mass(): number {
		return this.character.GetMass();
	}
	set mass(value: number) {
		this.character.SetMass(value);
	}
	get maxStrength(): number {
		return this.character.GetMaxStrength();
	}
	// from character base --------------------------------
	get maxCosSlopeAngle(): number {
		return this.character.GetCosMaxSlopeAngle();
	}
	set maxSlopeAngle(value: number) {
		this.character.SetMaxSlopeAngle(value);
	}
	get up(): THREE.Vector3 {
		return vec3.three(this.character.GetUp());
	}
	set up(value: THREE.Vector3) {
		const newVec = vec3.jolt(value);
		this.character.SetUp(newVec);
		Raw.module.destroy(newVec);
	}
	// Ground Properties ----------------------------------
	//Tell if we are flying, sliding, etc (Read-only)
	get groundState(): string | undefined {
		const joltState = this.character.GetGroundState();
		switch (joltState) {
			case Raw.module.EGroundState_OnGround:
				return "OnGround";
			case Raw.module.EGroundState_OnSteepGround:
				return "OnSteepGround";
			case Raw.module.EGroundState_InAir:
				return "InAir";
			case Raw.module.EGroundState_NotSupported:
				return "NotSupported";
		}
		return undefined;
		//TODO do we need to destroy joltState?
	}
	get isSupported(): boolean {
		return this.character.IsSupported();
	}
	get groundNormal(): THREE.Vector3 {
		return vec3.three(this.character.GetGroundNormal());
	}
	get groundPosition(): THREE.Vector3 {
		return vec3.three(this.character.GetGroundPosition());
	}
	get groundVelocity(): THREE.Vector3 {
		return vec3.three(this.character.GetGroundVelocity());
	}
	get groundMaterial(): any {
		return this.character.GetGroundMaterial();
	}
	get groundBodyHandle(): any {
		return this.character.GetGroundBodyID().GetIndexAndSequenceNumber();
		//TODO do we need to destroy the bodyID?
	}

	// Rare ----------------------------------------------
	get penetrationRecoverySpeed(): number {
		return this.character.GetPenetrationRecoverySpeed();
	}
	set penetrationRecoverySpeed(value: number) {
		this.character.SetPenetrationRecoverySpeed(value);
	}
	// read-only
	get characterPadding(): number {
		return this.character.GetCharacterPadding();
	}
	get maxNumHits(): number {
		return this.character.GetMaxNumHits();
	}
	set maxNumHits(value: number) {
		this.character.SetMaxNumHits(value);
	}
	get shapeOffset(): THREE.Vector3 {
		return vec3.three(this.character.GetShapeOffset());
	}
	set shapeOffset(value: THREE.Vector3) {
		const newVec = vec3.jolt(value);
		this.character.SetShapeOffset(newVec);
		Raw.module.destroy(newVec);
	}

	//* Contact Listeners =================================

	initCharacterContactListener() {
		this.characterContactListener = new Raw.module.CharacterContactListenerJS();
		this.characterContactListener.OnAdjustBodyVelocity = (
			_character: Jolt.CharacterVirtual,
			body2: Jolt.Body,
			linearVelocity: Jolt.Vec3,
			_angularVelocity: Jolt.Vec3
		) => {
			//@ts-ignore wrapPointer TS error
			body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
			//@ts-ignore
			linearVelocity = Raw.module.wrapPointer(linearVelocity, Raw.module.Vec3);
			// this is where the movement from conveyor belts and other things can be added
		};
		this.characterContactListener.OnContactValidate = (
			character: Jolt.CharacterVirtual,
			bodyID2: Jolt.BodyID,
			_subShapeID2: Jolt.SubShapeID
		) => {
			//@ts-ignore wrapPointer TS error
			bodyID2 = Raw.module.wrapPointer(bodyID2, Raw.module.Body);
			//@ts-ignore wrapPointer TS error
			character = Raw.module.wrapPointer(character, Raw.module.Body);
			// this seems to be a space to trigger sensors
			return true;
		};
		this.characterContactListener.OnContactAdded = (
			_character: Jolt.CharacterVirtual,
			_bodyID2: Jolt.BodyID,
			_subShapeID2: Jolt.SubShapeID,
			_contactPosition: Jolt.Vec3,
			_contactNormal: Jolt.Vec3,
			_settings: any
		) => {
			// not using this at the moment
		};
		this.characterContactListener.OnContactSolve = (
			character: any,
			_bodyID2: Jolt.BodyID,
			_subShapeID2: Jolt.SubShapeID,
			_contactPosition: Jolt.Vec3,
			contactNormal: Jolt.Vec3,
			contactVelocity: Jolt.Vec3,
			_contactMaterial: Jolt.PhysicsMaterial,
			_characterVelocity: Jolt.Vec3,
			newCharacterVelocity: Jolt.Vec3
		) => {
			character = Raw.module.wrapPointer(character, Raw.module.Body);
			//@ts-ignore wrapPointer TS error
			contactVelocity = Raw.module.wrapPointer(contactVelocity, Raw.module.Vec3);
			//@ts-ignore
			newCharacterVelocity = Raw.module.wrapPointer(newCharacterVelocity, Raw.module.Vec3);
			//@ts-ignore
			contactNormal = Raw.module.wrapPointer(contactNormal, Raw.module.Vec3);

			if (
				!this.allowSliding &&
				contactVelocity.IsNearZero() &&
				!this.character.IsSlopeTooSteep(contactNormal)
			) {
				// Dont allow the character to slide
				newCharacterVelocity.SetX(0);
				newCharacterVelocity.SetY(0);
				newCharacterVelocity.SetZ(0);
			}
		};
	}
	// create the core character
	initCharacter() {
		const settings = new Raw.module.CharacterVirtualSettings();
		settings.mMass = 1000;
		settings.mMaxSlopeAngle = MathUtils.degToRad(45.0);
		settings.mMaxStrength = 100;
		settings.mShape = this.standingShape;
		settings.mBackFaceMode = Raw.module.EBackFaceMode_CollideWithBackFaces;
		settings.mCharacterPadding = 0.02;
		settings.mPenetrationRecoverySpeed = 1;
		settings.mPredictiveContactDistance = this.predictiveContactDistance;
		settings.mSupportingVolume = new Raw.module.Plane(
			Raw.module.Vec3.prototype.sAxisY(),
			-this.characterRadiusStanding
		);
		this.character = new Raw.module.CharacterVirtual(
			settings,
			Raw.module.RVec3.prototype.sZero(),
			Raw.module.Quat.prototype.sIdentity(),
			this.physicsSystem.physicsSystem
		);
		this.character.SetListener(this.characterContactListener);

		//this.threeCharacter.geometry = this.threeStandingGeometry;
		this.threeCharacter.userData.body = this.character;
		this.shape = this.standingShape;
		// create the rig anchor
		this.createAnchor();
		// TODO: Destroy all the jolt stuff now its created
	}

	// create the anchor object for rigs
	private createAnchor() {
		const shapeSettings = new Raw.module.SphereShapeSettings(0.5);
		const bodySettings = generateBodySettings(shapeSettings, {
			bodyType: "kinematic"
		});
		const anchor = this.physicsSystem.bodyInterface.CreateBody(bodySettings);
		anchor.SetIsSensor(true);
		this.anchorID = anchor.GetID();
		// we have to generate a correct bodyState
		const anchorHandle = this.physicsSystem.bodySystem.addExistingBody(
			new THREE.Object3D(),
			anchor
		);
		this.anchor = this.physicsSystem.bodySystem.getBody(anchorHandle);

		// cleanup
		Raw.module.destroy(shapeSettings);
		Raw.module.destroy(bodySettings);
	}
	// set the capsule shape for the character
	setCapsule(radius: number, height: number) {
		this.characterHeightStanding = height;
		this.characterRadiusStanding = radius;
		this.characterHeightCrouching = height * 0.5;
		this.characterRadiusCrouching = radius * 0.5;
		const positionStanding = new Raw.module.Vec3(
			0,
			0.5 * this.characterHeightStanding + this.characterRadiusStanding,
			0
		);
		const positionCrouching = new Raw.module.Vec3(
			0,
			0.5 * this.characterHeightCrouching + this.characterRadiusCrouching,
			0
		);
		const rotation = Raw.module.Quat.prototype.sIdentity();
		// TODO: prettier butchers this
		this.standingShape = new Raw.module.RotatedTranslatedShapeSettings(
			positionStanding,
			rotation,
			new Raw.module.CapsuleShapeSettings(
				0.5 * this.characterHeightStanding,
				this.characterRadiusStanding
			)
		)
			.Create()
			.Get();
		this.crouchingShape = new Raw.module.RotatedTranslatedShapeSettings(
			positionCrouching,
			rotation,
			new Raw.module.CapsuleShapeSettings(
				0.5 * this.characterHeightCrouching,
				this.characterRadiusCrouching
			)
		)
			.Create()
			.Get();
		// TODO: Destroy all the jolt stuff now its created
	}

	prePhysicsUpdate(deltaTime: number) {
		// locks the character in a up position
		const characterUp = vec3.joltToThree(this.character.GetUp());
		// TODO: consider angular velocity to slightly rotate (wolfram GDC2014)
		this.applyRotation();
		this.applyMovement(deltaTime);
		// Most of the next few actions are applying gravity/force to the character
		// prevents odd hovering
		if (!this.enableStickToFloor) {
			this.updateSettings.mStickToFloorStepDown = Raw.module.Vec3.prototype.sZero();
		} else {
			const vec = characterUp
				.clone()
				.multiplyScalar(-this.updateSettings.mStickToFloorStepDown.Length());
			this.updateSettings.mStickToFloorStepDown.Set(vec.x, vec.y, vec.z);
		}

		if (!this.enableWalkStairs) {
			this.updateSettings.mWalkStairsStepUp = Raw.module.Vec3.prototype.sZero();
		} else {
			const vec = characterUp
				.clone()
				.multiplyScalar(this.updateSettings.mWalkStairsStepUp.Length());
			this.updateSettings.mWalkStairsStepUp.Set(vec.x, vec.y, vec.z);
		}
		characterUp.multiplyScalar(-this.physicsSystem.physicsSystem.GetGravity().Length());

		this.character.ExtendedUpdate(
			deltaTime,
			this.character.GetUp(),
			this.updateSettings,
			//@ts-ignore
			this.filters.movingBPFilter,
			this.filters.movingLayerFilter,
			this.filters.bodyFilter,
			this.filters.shapeFilter,
			this.joltInterface.GetTempAllocator()
		);
		// TODO this is where we slerp the character

		// move the three object
		this.threeCharacter.position.lerp(
			vec3.three(this.character.GetPosition()),
			this.lerpFactor
		);
		this.threeCharacter.quaternion.slerp(
			quat.three(this.character.GetRotation()),
			this.lerpFactor
		);
		// update the anchor
		this.anchor.setPositionAndRotation(
			this.threeCharacter.position,
			this.threeCharacter.quaternion
		);
	}
	// Movement Functions ------------------------------
	setRotation(rotation: THREE.Quaternion) {
		this.targetRotation = rotation;
		this.currentRotationSlerp = 0;
		this.isRotating = true;
	}
	private applyRotation() {
		if (this.isRotating) {
			this.currentRotationSlerp += this.maxRotationSpeed;
			if (this.currentRotationSlerp >= 1) {
				this.currentRotationSlerp = 1;
				this.isRotating = false;
			}
			this.currentRotation.slerp(this.targetRotation, this.currentRotationSlerp);

			this.character.SetRotation(quat.threeToJolt(this.currentRotation));
		}
	}
	// set the movement input
	move(direction: THREE.Vector3) {
		this.movementInput = direction;
		// rotate based on the direction
		if (this.enableCharacterRotation && direction.length() > 0)
			this.setRotation(
				new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction)
			);
	}

	// move the character in space
	private applyMovement(deltaTime = 1) {
		//TODO: resolve a way to remove this clone
		const movementDirection = this.movementInput.clone();
		//const jump = this.isJumping;

		// can the user defy physics and move while airborne
		// also if the user passes a direction (allows jump without direction input)
		const playerControlsHorizontalVelocity =
			this.controlMovementDuringJump || this.character.IsSupported();
		if (playerControlsHorizontalVelocity) {
			// True if the player intended to move
			this.allowSliding = !(movementDirection.length() < 1.0e-12);
			// Smooth the player input
			if (this.enableCharacterInertia) {
				this.desiredVelocity.multiplyScalar(0.75);
				//TODO this add is why we need the clone
				this.desiredVelocity.add(movementDirection.multiplyScalar(0.25 * this.activeSpeed));
			} else {
				this.desiredVelocity.copy(movementDirection).multiplyScalar(this.activeSpeed);
			}
		} else {
			// While in air we allow sliding
			this.allowSliding = true;
		}
		// Maintain the up orientation
		this._tmpVec3.Set(this.upRotationX, 0, this.upRotationZ);
		const characterUpRotation = Raw.module.Quat.prototype.sEulerAngles(this._tmpVec3);
		this.character.SetUp(characterUpRotation.RotateAxisY());
		// this is overriding our existing rotation
		//this.character.SetRotation(characterUpRotation);
		const upRotation = quat.joltToThree(characterUpRotation);

		this.character.UpdateGroundVelocity();
		const characterUp = vec3.joltToThree(this.character.GetUp());
		const linearVelocity = vec3.joltToThree(this.character.GetLinearVelocity());
		const currentVerticalVelocity = characterUp
			.clone()
			.multiplyScalar(linearVelocity.dot(characterUp));
		const groundVelocity = vec3.joltToThree(this.character.GetGroundVelocity());
		const gravity = vec3.joltToThree(this.physicsSystem.physicsSystem.GetGravity());

		let newVelocity: any;
		const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y < 0.1;

		// If on ground and not moving away from ground
		if (
			this.character.GetGroundState() === Raw.module.EGroundState_OnGround && // If on ground
			(this.enableCharacterInertia
				? movingTowardsGround // Inertia enabled: And not moving away from ground
				: !this.character.IsSlopeTooSteep(this.character.GetGroundNormal()))
		) {
			// reset the jump counter
			this.jumpCounter = 0;
			// Inertia disabled: And not on a slope that is too steep
			// Assume velocity of ground when on ground
			newVelocity = groundVelocity;
		} else newVelocity = currentVerticalVelocity.clone();

		//
		// JUMP. Double jump or on the ground
		//
		if (this.isJumping) {
			if (this.jumpCounter < this.jumpLimit) {
				this.jumpCounter++;
				//console.log('jumping, jump count:', this.jumpCounter);
				this.triggerActionListeners("jump", this.jumpCounter);

				newVelocity.add(characterUp.multiplyScalar(this.jumpSpeed));
				this.isJumping = false;
			}
		}

		// Gravity
		newVelocity.add(gravity.multiplyScalar(deltaTime).applyQuaternion(upRotation));

		if (playerControlsHorizontalVelocity) {
			// Player input
			// console.log('player velocity', this.desiredVelocity);
			newVelocity.add(this.desiredVelocity.clone().applyQuaternion(upRotation));
		} else {
			// Preserve horizontal velocity
			const currentHorizontalVelocity = linearVelocity.sub(currentVerticalVelocity);
			newVelocity.add(currentHorizontalVelocity);
		}

		this._tmpVec3.Set(newVelocity.x, newVelocity.y, newVelocity.z);
		//const difference = newVelocity.clone().sub(this.oldPosition);
		//console.log('difference', difference);
		// console.log('new velocity', newVelocity);
		this.character.SetLinearVelocity(this._tmpVec3);
		//this.oldPosition = newVelocity.clone();
	}
	// TODO Fix this
	setCrouched = (crouched: boolean, forceUpdate: boolean) => {
		if (crouched !== this.isCrouched || forceUpdate) {
			let newShape: any;
			//let newGeometry;
			if (crouched) {
				newShape = this.crouchingShape;
				//newGeometry = this.threeCrouchingGeometry;
			} else {
				newShape = this.standingShape;
				//newGeometry = this.threeStandingGeometry;
			}
			if (
				this.character.SetShape(
					newShape,
					1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
					//@ts-ignore
					this.filters.movingBPFilter,
					this.filters.movingLayerFilter,
					this.filters.bodyFilter,
					this.filters.shapeFilter,
					this.joltInterface.GetTempAllocator()
				)
			) {
				// Accept the new shape only when the SetShape call was successful
				this.isCrouched = crouched;
				//threeCharacter.geometry = newGeometry;
			}
		}
	};

	// Primary Movement functions =============================
	jump() {
		this.isJumping = true;
		// TODO, is this still needed?
		setTimeout(() => {
			this.isJumping = false;
		}, 100);
	}
	startRunning(speed?: any) {
		const newSpeed = speed || this.characterSpeed * 2;
		this.activeSpeed = newSpeed;
		//notify
		this.triggerActionListeners("startRunning", newSpeed);
	}
	stopRunning() {
		this.activeSpeed = this.characterSpeed;
		this.triggerActionListeners("stopRunning");
	}
	// Action Listener Functions ----------------------------
	addActionListener = (listener: any) => {
		//@ts-ignore
		this.actionListeners.push(listener);
	};
	removeActionListener = (listener: any) => {
		this.actionListeners = this.actionListeners.filter((l) => l !== listener);
	};
	triggerActionListeners = (action: any, payload?: any) => {
		//@ts-ignore
		this.actionListeners.forEach((listener) => listener(action, payload));
	};
	// watch function takes an action and a callback and adds the correct listener
	watch = (action: any, callback: any) => {
		const listener = (a: any) => {
			if (a === action) callback();
		};
		this.addActionListener(listener);
		return () => this.removeActionListener(listener);
	};

	//* Util functions ----------------------------------

	isSlopeTooSteep(normal: THREE.Vector3) {
		return this.character.IsSlopeTooSteep(vec3.threeToJolt(normal));
	}
}
