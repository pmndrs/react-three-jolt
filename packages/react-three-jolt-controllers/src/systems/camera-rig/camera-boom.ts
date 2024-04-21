// main items of the camera rigs
//import { Raw } from '@react-three/jolt';
//import type Jolt from 'jolt-physics';
import * as THREE from "three";
// mostly for the types
import type {
	PhysicsSystem,
	RaycastHit,
	Raycaster,
	ShapeCollider,
	ShapecastHit,
	Shapecaster
} from "@react-three/jolt";
//import { ConstraintSystem } from '@react-three/jolt';

//import { vec3, quat, convertNegativeRadians } from '@react-three/jolt';
//import { BodyState } from '@react-three/jolt';

export class CameraBoom {
	physicsSystem: PhysicsSystem;
	raycaster: Raycaster;
	collider: ShapeCollider;
	shapecaster: Shapecaster;
	activeCamera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;

	//props
	lookSpeed = 1;
	zoomSpeed = 1;
	maxHorizontal = THREE.MathUtils.degToRad(90);
	maxVertical = THREE.MathUtils.degToRad(90);
	slerpFactor = 0.5;
	minDistance = 0.1;
	maxDistance = 100;
	allowCameraClipping = false; // temp true to test shapecaster

	//maybe internal props
	camFactor = 0.002;
	zoomFactor = 0.002;
	obstructionBuffer = 0.01;

	// Obstruction props -------------------------
	// minimum distance to be clear of obstru
	clearDistance = 5;
	timeObstructed = 0;
	obstructionTimestamp = 0;

	currentDistance = 5;

	//defaults
	initialDistance = 5;
	initialHeight = 0;

	// targets (for lerping)
	targetDistance = 5;
	targetRotation = 0;
	targetHeight = 0;

	isMoving = false;
	isRotating = false;
	minLerpClearance = 0.01;
	rearcastFactor = 1;

	// camera target in worldspace
	target = new THREE.Vector3(0, 0, 0);

	updateMode: "demand" | "additive" = "demand";

	pivot = new THREE.Object3D();
	cameraSpace = new THREE.Object3D();
	lookVector = new THREE.Vector2(0, 0);

	constructor(base: THREE.Object3D, physicsSystem: PhysicsSystem, _options?: any) {
		this.physicsSystem = physicsSystem;
		this.raycaster = physicsSystem.getRaycaster();
		this.shapecaster = physicsSystem.getShapecaster();
		// set the raycaster to get all results
		this.raycaster.setCollector("all");

		// collider
		this.collider = physicsSystem.getShapeCollider();
		// create the pivot and camera space
		base.add(this.pivot);
		this.pivot.add(this.cameraSpace);
		// move the camera to the initial zPosition
		this.cameraSpace.position.z = this.currentDistance;

		// to debug add a shape to the pivot
		/*
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const cube = new THREE.Mesh(geometry, material);
        this.cameraSpace.add(cube);
        */
	}

	//* Properties ========================================
	get targetWorldSpace() {
		const _tempVec3 = new THREE.Vector3();
		this.pivot.getWorldPosition(_tempVec3);
		return _tempVec3.add(this.target);
	}
	get cameraWorldSpace() {
		const _tempVec3 = new THREE.Vector3();
		if (this.activeCamera) this.activeCamera.getWorldPosition(_tempVec3);
		return _tempVec3;
	}
	get pivotWorldSpace() {
		const _tempVec3 = new THREE.Vector3();
		this.pivot.getWorldPosition(_tempVec3);
		return _tempVec3;
	}

	// assign the camera to the boom
	set camera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
		// save the original position
		const basePosition = camera.position.clone();
		camera.userData.originalPosition = basePosition;
		//TODO initialize moves the rig into position based on the camera
		// this.initialize(basePosition);

		//reset the camera to a 0 position
		camera.position.set(0, 0, 0);
		this.cameraSpace.add(camera);
		this.activeCamera = camera;
		this.handleLookUpdate();
		console.log("set camera");
	}
	get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined {
		return this.activeCamera;
	}
	//take a position and set the rotation and camera space value based on it
	initialize(targetPosition: THREE.Vector3) {
		// the position is in worldspace
		// get the worldspace position of the pivot
		const _tempVec3 = new THREE.Vector3();
		this.pivot.getWorldPosition(_tempVec3);
		const targetWorldPosition = targetPosition.clone();
		targetWorldPosition.applyMatrix4(this.pivot.matrixWorld);
		const direction = targetWorldPosition.sub(_tempVec3);
		const rotation = Math.atan2(direction.y, direction.x);
		this.pivot.rotation.y = rotation;

		// set the camera space position

		this.cameraSpace.position.y = targetPosition.y;
		this.cameraSpace.position.z = targetPosition.z;
		this.currentDistance = this.cameraSpace.position.length();
		//rotate the camera space to look at the origin
		//this.cameraSpace.lookAt(_tempVec3);
	}

	// look comand takes x/y vector in -1 to 1 range
	move(lookVector: THREE.Vector2Like) {
		this.lookVector.set(lookVector.x, lookVector.y);
		if (this.updateMode === "demand") this.handleLookUpdate();
	}
	zoom(factor: number) {
		this.currentDistance = this.currentDistance + factor * this.zoomFactor * this.zoomSpeed;
		this.targetDistance = this.currentDistance;
		//apply min/max
		if (this.currentDistance < this.minDistance) this.currentDistance = this.minDistance;
		if (this.currentDistance > this.maxDistance) this.currentDistance = this.maxDistance;
		if (this.updateMode === "demand") this.handleZoomUpdate();
	}
	rotate(changeValue: number) {
		this.pivot.rotation.y += changeValue;
	}
	setRotation(value: number, force?: boolean) {
		this.targetRotation = value;
		if (force) this.pivot.rotation.y = value;
		else this.isRotating = true;
	}
	setDistance(value: number, force?: boolean) {
		this.targetDistance = value;
		if (force) {
			this.currentDistance = value;
			if (this.updateMode === "demand") this.handleZoomUpdate();
		} else this.isMoving = true;
	}

	//* Update movements ========================================
	handleLookUpdate() {
		// lookVector is now the delta between previous events
		this.pivot.rotation.y -= this.lookVector.x * this.camFactor * this.lookSpeed;
		const vy =
			this.cameraSpace.rotation.x + this.lookVector.y * this.camFactor * this.lookSpeed;

		if (vy >= -1.5 && vy <= 0.5) {
			this.cameraSpace.rotation.x = vy;
			this.cameraSpace.position.y = this.currentDistance * Math.sin(-vy);
			this.cameraSpace.position.z = this.currentDistance * Math.cos(-vy);
		}
	}

	handleZoomUpdate() {
		//reset the look vector
		const vy = this.cameraSpace.rotation.x;
		this.cameraSpace.position.y = this.currentDistance * Math.sin(-vy);

		this.cameraSpace.position.z = this.currentDistance * Math.cos(-vy);
	}

	// handle the frame update call from a rig
	handleFrameUpdate() {
		// handle additive mode (gamepad and joystick controls)
		// TODO  do additive mode
		// do the obstruction test
		if (!this.activeCamera) return;
		if (!this.allowCameraClipping) {
			// do the collision test
			this.doCollisionTest();
			//this.doObstructionTest();
		}
		// handle the distance update
		this.handleDistanceUpdate();
	}
	// frame driven distance handle
	handleDistanceUpdate() {
		if (this.isMoving) {
			this.currentDistance = THREE.MathUtils.lerp(
				this.currentDistance,
				this.clearDistance,
				this.slerpFactor
			);
			if (Math.abs(this.currentDistance - this.clearDistance) < this.minLerpClearance) {
				this.currentDistance = this.clearDistance;
				this.isMoving = false;
			}
			if (this.updateMode === "demand") this.handleZoomUpdate();
		}
	}

	//* Collision detection ========================================
	// do the obstruction test
	doObstructionTest() {
		// cast the ray
		const obstructions = this.castObstructionRay();
		// if there are none clear any timers and bail
		if (!obstructions) {
			//clear the timer
			this.timeObstructed = 0;
			// move us back to the target distance
			if (this.clearDistance !== this.targetDistance) {
				this.clearDistance = this.targetDistance;
				this.isMoving = true;
			}
			return;
		}
		const now = Date.now();
		// set a timestamp with a little offset so next frame it clears
		if (this.timeObstructed === 0) this.obstructionTimestamp = now - 0.001;

		this.timeObstructed = now - this.obstructionTimestamp;

		// get the minimum clear distance
		this.clearDistance =
			// @ts-ignore
			this.pivotWorldSpace.clone().distanceTo(obstructions[0].position) -
			this.obstructionBuffer;
		// go through the obstructions, get their bodies, and check if any dont allow obstruction
		for (const obstruction of obstructions as RaycastHit[]) {
			//@ts-ignore
			const body = this.physicsSystem.bodySystem.getBody(obstruction.bodyHandle);
			if (body) {
				// check if we dont allow obstruction
				if (body.allowObstruction === false) this.isMoving = true;

				// check if we are beyond the obstruction time
				if (
					body.obstructionType === "temporal" &&
					this.timeObstructed > body.obstructionTimelimit
				)
					this.isMoving = true;
			}
		}
	}

	// check if we are colliding and if the body allows that, if not, move us
	doCollisionTest() {
		// cast the collider
		const collision = this.checkCollision();
		// if there are none bail
		if (!collision) return;
		//@ts-ignore get the body collided. we know this is single...
		const body = this.physicsSystem.bodySystem.getBody(collision.bodyHandle);
		if (body && body.allowCollision === false) {
			// do a shapecast to this point
			const obstruction = this.castObstructionShape();
			if (obstruction) {
				// get the distance to the obstruction
				const distance = this.pivotWorldSpace.distanceTo(obstruction.position);
				// set the clear distance to this distance
				this.clearDistance = distance - this.obstructionBuffer;
				this.isMoving = true;
			}
			//this.currentDistance = this.clearDistance;
			//if (this.updateMode === "demand") this.handleZoomUpdate();
		}
	}

	// cast vertical ray from minimum height and return min and max height
	castGroundRay() {}
	// test if the camera is obstructed
	castObstructionRay() {
		// if this has anything it will return a result otherwise null
		// we need to add an offset to the direction
		const origin = this.targetWorldSpace;
		const direction = this.cameraWorldSpace.clone().sub(origin).normalize();
		const destination = this.cameraWorldSpace
			.clone()
			.add(direction.multiplyScalar(this.rearcastFactor));
		return this.raycaster.castBetween(origin, destination);
	}
	castObstructionShape(): ShapecastHit | undefined {
		// if this has anything it will return a result otherwise null
		// we need to add an offset to the direction
		const origin = this.targetWorldSpace;
		const direction = this.cameraWorldSpace.clone().sub(origin).normalize();
		const destination = this.cameraWorldSpace
			.clone()
			.add(direction.multiplyScalar(this.rearcastFactor));
		// we know without setting to all this will be a single result
		return this.shapecaster.castBetween(origin, destination) as ShapecastHit | undefined;
	}
	// test if the camera space is colliding with anything
	checkCollision() {
		// set the collider to the camera world position
		this.collider.position = this.cameraWorldSpace;
		// cast the collider
		return this.collider.cast();
	}
}
