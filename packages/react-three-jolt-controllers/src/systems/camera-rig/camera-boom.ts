// main items of the camera rigs
//import { Raw } from '@react-three/jolt';
//import type Jolt from 'jolt-physics';
import * as THREE from 'three';
// mostly for the types
import { PhysicsSystem, Raycaster } from '@react-three/jolt';
//import { ConstraintSystem } from '@react-three/jolt';

//import { vec3, quat, convertNegativeRadians } from '@react-three/jolt';
//import { BodyState } from '@react-three/jolt';

export class CameraBoom {
    physicsSystem: PhysicsSystem;
    raycaster: Raycaster;
    activeCamera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;

    //props
    lookSpeed = 1;
    zoomSpeed = 1;
    maxHorizontal = THREE.MathUtils.degToRad(90);
    maxVertical = THREE.MathUtils.degToRad(90);
    enableSlerp = false;
    slerpFactor = 0.5;
    minDistance = 0.1;
    maxDistance = 100;

    //maybe internal props
    camFactor = 0.002;
    zoomFactor = 0.002;

    // minimum distance to be clear of obstru
    clearDistance = 5;

    currentDistance = 5;
    verticalAngle = 0;
    horizontalAngle = 0;

    //defaults
    initialDistance = 5;

    // targets (for lerping)
    targetDistance = 5;
    targetVerticalAngle = 15;
    targetHorizontalAngle = 0;

    // camera target in worldspace
    target = new THREE.Vector3(0, 0, 0);

    updateMode: 'demand' | 'additive' = 'demand';

    pivot = new THREE.Object3D();
    cameraSpace = new THREE.Object3D();
    lookVector = new THREE.Vector2(0, 0);

    constructor(base: THREE.Object3D, physicsSystem: PhysicsSystem, _options?: any) {
        this.physicsSystem = physicsSystem;
        this.raycaster = physicsSystem.getRaycaster();
        // create the pivot and camera space
        base.add(this.pivot);
        this.pivot.add(this.cameraSpace);
        // move the camera to the initial zPosition
        this.cameraSpace.position.z = this.currentDistance;

        // to debug add a shape to the pivot
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const cube = new THREE.Mesh(geometry, material);
        this.cameraSpace.add(cube);
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
    look(lookVector: THREE.Vector2Like) {
        this.lookVector.set(lookVector.x, lookVector.y);
        if (this.updateMode == 'demand') this.handleLookUpdate();
    }
    zoom(factor: number) {
        this.currentDistance = this.currentDistance + factor * this.zoomFactor * this.zoomSpeed;
        //apply min/max
        if (this.currentDistance < this.minDistance) this.currentDistance = this.minDistance;
        if (this.currentDistance > this.maxDistance) this.currentDistance = this.maxDistance;
        if (this.updateMode == 'demand') this.handleZoomUpdate();
    }
    handleLookUpdate() {
        // lookVector is now the delta between previous events
        this.pivot.rotation.y -= this.lookVector.x * this.camFactor * this.lookSpeed;
        const vy =
            this.cameraSpace.rotation.x + this.lookVector.y * this.camFactor * this.lookSpeed;

        // this may become wrong once rotated?
        //this.currentDistance = this.cameraSpace.position.length();

        if (vy >= -0.5 && vy <= 1.5) {
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

    /*
    handleDemandUpdate() {
        this.horizontalAngle = this.lookVector.x * this.maxHorizontal;
        this.verticalAngle = this.lookVector.y * this.maxVertical;
        // rotate the pivot
        if (!this.enableSlerp) {
            this.pivot.rotateY(this.horizontalAngle);
            this.updateVerticalPosition();
            this.camera?.lookAt(this.target);
        }
    }
    */
    // take the distance and vertical angle and set the cameraSpace position
    updateVerticalPosition() {
        this.cameraSpace.position.y = this.currentDistance * Math.sin(this.verticalAngle);
        this.cameraSpace.position.z = this.currentDistance * Math.cos(this.verticalAngle);
    }
}
