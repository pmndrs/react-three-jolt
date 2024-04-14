// main items of the camera rigs
import { Raw } from '../raw';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
// mostly for the types
import { PhysicsSystem } from './physics-system';
import { ConstraintSystem } from './constraint-system';
import { characterControllerSystem } from './character-controller';
import { vec3, quat, convertNegativeRadians } from '../utils/general';
import { BodyState } from './body-system';
export class CameraRigManager {
    private physicsSystem: PhysicsSystem;
    private constraintSystem: ConstraintSystem;
    private characterSystem: characterControllerSystem;
    private character: Jolt.CharacterVirtual;
    private anchor: BodyState;
    isAttached = false;

    cameraFollowSpeed = 6;
    recenterTriggerDistance = new THREE.Vector3(3, 5, 3);
    recenterMin = 0.1;
    allowSmoothStart = true;
    allowFollowDelay = true;

    private timeRecentering = 0;
    private isRecentering = false;

    // offset off the anchor of the base
    baseOffset = new THREE.Vector3(0, 2, 0);

    // base is a point that allows drift
    base: BodyState;
    // pivot is a point that allows vertical rotation
    pivot: BodyState;

    //mount is where the camera lives
    mount: BodyState;

    //threeJS scene
    scene: THREE.Scene;
    //boom properties --------------------------
    minBoomLength = 0.5;
    maxBoomLength = 5;
    currentBoomLength = 2;
    minBoomAngle = 0;
    maxBoomAngle = Math.PI / 2;
    currentBoomAngle = Math.PI / 4;

    // cameras ---------------------------------
    cameras: Map<string, THREE.Camera> = new Map();
    activeCamera: THREE.Camera;
    target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    targetOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

    // listeners for when the camera changes or updates
    private cameraChangeListeners = [];

    // listener for the loop. we put it here so we can cancel it
    private loopListener;

    //debugging
    private isDebugging = false;
    set debug(value: boolean) {
        this.isDebugging = value;
        this.points.forEach((point) => (point.object.visible = value));
    }
    get debug() {
        return this.isDebugging;
    }

    // holders for rig points
    points = new Map();
    collarConstraint: Jolt.HingeConstraint;
    constraints = new Map();

    constructor(scene, physicsSystem) {
        this.scene = scene;
        this.physicsSystem = physicsSystem;
        this.constraintSystem = physicsSystem.constraintSystem;
        // attach to the physics system loop
        this.attachToLoop();
        // create the root point
        this.base = this.createRigPoint('base', {
            color: '#08A045',
            motionType: 'kinematic'
        });

        //this.createCollar();
    }

    //* Cameras ========================================
    // create a camera
    createCamera(name, options?) {
        //TODO: not sure aspect ratio needs to be here
        const camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        // loop over options and set them
        if (options) for (const key in options) camera[key] = options[key];
        // add to list
        this.addCamera(name, camera);
        // if there is no active camera set this to it
        // TODO: Determine if we should set the camera if there isn't one
        // I worry it will cause a flash
        //if (!this.activeCamera) this.setActiveCamera(name);
        return camera;
    }
    // allow an external camera to be added
    addCamera(name: string, camera: THREE.Camera) {
        // add the camera to the scene
        this.scene.add(camera);
        this.cameras.set(name, camera);
    }
    // set the active camera
    setActiveCamera(name) {
        const newCam = this.cameras.get(name);
        if (newCam) {
            this.activeCamera = newCam;
            this.triggerCameraChange();
        }
    }
    // get a camera
    getCamera(name) {
        return this.cameras.get(name);
    }
    // remove a camera
    removeCamera(name) {
        this.cameras.delete(name);
    }
    // create a camera change listener
    onCamera(change) {
        this.cameraChangeListeners.push(change);
        // return a function to remove the listener
        return () => {
            this.cameraChangeListeners = this.cameraChangeListeners.filter(
                (listener) => listener !== change
            );
        };
    }
    // trigger the camera change listeners
    private triggerCameraChange() {
        console.log('triggering camera change', this.activeCamera);
        this.cameraChangeListeners.forEach((listener) => listener(this.activeCamera));
    }

    //attach a camera to a point
    //it does this by making it a child of the threejs object of the point
    attachCameraToPoint(camera, point) {
        point.object.add(camera);
    }
    //* Anchor attachment ===================================
    attach(body: BodyState) {
        this.anchor = body;
        this.isAttached = true;
    }
    detach() {
        // we dont to this so we can reattach
        //   this.anchor = null;
        this.isAttached = false;
    }
    reAttach() {
        if (this.anchor) this.isAttached = true;
    }
    attachToCharacter(characterSystem) {
        this.characterSystem = characterSystem;
        this.character = characterSystem.character;
        this.attach(characterSystem.anchor);

        this.createCollar();
        this.createMount();
        // create the basic camera
        const camera = this.createCamera('main');
        //attach the camera to the mount
        // right now mount isnt a point
        /*
        this.attachCameraToPoint(
            this.getCamera('main'),
            this.points.get('pivot')
        );
        */
        this.mount.object.add(camera);
        this.setActiveCamera('main');
    }
    //* Rig Points ========================================
    // create a collar
    /* The collar attaches directly to the base and can rotate
    along the y axis. The boom attaches to the collar. 

    */

    createCollar() {
        const collar = this.createRigPoint('collar', { color: '#0098DE' });
        const joint = this.constraintSystem.addConstraint('hinge', this.base, collar, {
            axis: new THREE.Vector3(0, 1, 0),
            normal: new THREE.Vector3(0, 0, 1),

            spring: {
                strength: 1
            }
        });
        // TODO convert this to the constraint map
        this.collarConstraint = Raw.module.castObject(joint, Raw.module.HingeConstraint);
    }

    //create the camera mount
    createMount() {
        const geometry = new THREE.SphereGeometry(0.2, 32, 32);
        const material = new THREE.MeshBasicMaterial({ color: '#F2E94E' });
        const mesh = new THREE.Mesh(geometry, material);
        const options = {
            bodySettings: {
                mGravityFactor: 0
            }
        };
        const mountHandle = this.physicsSystem.bodySystem.addBody(mesh, options);
        const mount = this.physicsSystem.bodySystem.getBody(mountHandle);
        //change the mass
        this.physicsSystem.bodySystem.setMass(mountHandle, 0.00001);
        this.scene.add(mesh);
        // little bit of a hack
        //move the mount to where we want
        const basePosition = this.base.getPosition();
        const mountPosition = basePosition.add(new THREE.Vector3(0, 4, 4));
        mount!.setPosition(mountPosition);
        this.mount = mount;

        // create the pivot
        const pivot = this.createRigPoint('pivot', { color: '#F2E94E' });
        // attach the pivot to the collar with a hinge
        const pivotConstraint = this.constraintSystem.addConstraint(
            'hinge',
            this.points.get('collar'),
            pivot,
            {
                axis: new THREE.Vector3(1, 0, 0),
                min: -Math.PI / 2,
                max: Math.PI / 2 - 0.2,
                spring: {
                    strength: 12
                }
            }
        );
        this.constraints.set(
            'pivot',
            Raw.module.castObject(pivotConstraint, Raw.module.HingeConstraint)
        );

        // attach the mount to the pivot.
        this.constraints.set(
            'boomArm',
            this.constraintSystem.addConstraint('slider', pivot, mount, {
                axis: new THREE.Vector3(0, 0, 1),

                min: 2,
                max: 7,
                spring: {
                    strength: 12
                }
            })
        );

        // lets start with a fixed constraint to test following
        /*this.constraintSystem.addConstraint(
            'fixed',
            this.points.get('collar'),
            mount
        );
        */
    }
    //* Loop Updates and Animations ========================
    // attach to the physics loop
    private attachToLoop() {
        //TODO: consider postStep as there's a slight delay in position even if fixed
        this.physicsSystem.addPreStepListener((deltaTime, subFrame) =>
            this.handleUpdate(deltaTime, subFrame)
        );
    }
    // detach from the physics loop
    private detachFromLoop() {
        this.physicsSystem.removeStepListener(this.handleUpdate);
    }

    // handler for when the frame updates
    private handleUpdate(deltaTime, subFrame) {
        //console.log('update in cameraRIgh', deltaTime);
        //if we have an anchor update the base position
        this.updateBase(deltaTime);
        this.updateTarget();
        this.updateCameraLookAt();
    }

    // Check if the base should move, if so move it smoothly
    private updateBase(deltaTime) {
        //if we have an anchor update the base position
        if (!this.anchor || !this.isAttached) return;
        // only check if we should recenter if not already trying
        if (!this.isRecentering) this.isRecentering = this.shouldRecenter();
        if (this.isRecentering) {
            const basePosition = this.base.getPosition().sub(this.baseOffset);
            const anchorPosition = this.anchor.getPosition();

            // smoothly update the base position
            this.smoothRecenter(deltaTime);
            //disable centering if we are close to equeal
            // TODO: pretier makes this look ugly
            if (anchorPosition.distanceTo(basePosition) < this.recenterMin) {
                this.isRecentering = false;
                this.timeRecentering = 0;
            }
        }
    }
    //smothly recenter the base to the anchor using the camera follow speed
    private smoothRecenter(deltaTime) {
        //TODO: consider performance impact of constantly requesting vs passing
        const basePosition = this.base.getPosition();
        const anchorPosition = this.anchor.getPosition().add(this.baseOffset);

        //smoothing factor so it doesn't drag fast immidiately
        //TODO consider a refcator to make this more readable
        const smoothFactor = this.allowSmoothStart
            ? this.timeRecentering < 1
                ? this.timeRecentering / 1
                : 1
            : 1;
        this.timeRecentering += deltaTime;
        const newPosition = !this.allowFollowDelay
            ? anchorPosition
            : basePosition.lerp(anchorPosition, smoothFactor * deltaTime * this.cameraFollowSpeed);
        this.base.setPosition(newPosition);
    }

    // TODO: This seems like a heavy function
    // detects if the two points are beyond the trigger distance
    private shouldRecenter() {
        const basePosition = this.base.getPosition().sub(this.baseOffset);
        const anchorPosition = this.anchor.getPosition();

        let shouldTrigger = false;
        // doing it this way lets us compare each axis
        const anchorTuple = anchorPosition.toArray();
        const baseTuple = basePosition.toArray();
        const triggerTuple = this.recenterTriggerDistance.toArray();

        //check each axis
        for (let i = 0; i < 3; i++) {
            const distance = Math.abs(anchorTuple[i] - baseTuple[i]);
            if (distance > triggerTuple[i]) shouldTrigger = true;
        }
        return shouldTrigger;
    }
    //udate the camera target position using the offset and direction
    updateTarget() {
        if (!this.anchor || this.collarConstraint == null) return;
        // for now we will just target the anchor position
        const rotation = this.getCollarRotation();
        const targetPosition: THREE.Vector3 = this.anchor.getPosition().clone();
        targetPosition.add(this.targetOffset);
        //console.log('rotation', rotation);
        //console.log('position before axis angle', targetPosition.toArray());
        targetPosition.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
        this.target = targetPosition;
        //console.log('target', this.target);
    }

    //loop over the cameras and change the target
    updateCameraLookAt() {
        this.cameras.forEach((camera) => {
            camera.lookAt(this.target);
        });
    }

    //* Rig Movement ========================================
    // Rotate the collar
    rotateCollar(angle) {
        // rotate using the motor
        // we set the state because "look" movement uses velocity
        this.collarConstraint.SetMotorState(Raw.module.EMotorState_Position);
        this.collarConstraint.SetTargetAngle(angle);
    }
    alignCollar() {
        //get the angle of the anchor
        const anchorRotation = this.anchor.body
            .GetRotation()
            .GetRotationAngle(new Raw.module.Vec3(0, 1, 0));
        //rotate the collar to match
        console.log('aligning collar', anchorRotation);
        this.rotateCollar(anchorRotation);
    }
    getCollarRotation(): number {
        // const collar = this.constraints.get('collar');
        const collar = this.collarConstraint;
        if (collar) return collar.GetCurrentAngle() || 0;
        return 0;
    }
    // I'm putting the getters/setters here instead of before the constructor, might change
    get yaw() {
        return THREE.MathUtils.radToDeg(this.getCollarRotation());
    }
    set yaw(value) {
        this.rotateCollar(THREE.MathUtils.degToRad(value));
    }
    rotatePivot(angle) {
        //rotate using the motor
        const pivotConstraint = this.constraints.get('pivot');
        pivotConstraint.SetMotorState(Raw.module.EMotorState_Position);
        pivotConstraint.SetTargetAngle(angle);
    }
    alignPivot() {
        // reset the pivot to 0 rotation
        this.rotatePivot(0);
    }
    getPivotRotation() {
        return this.constraints.get('pivot').GetCurrentAngle();
    }
    get pitch() {
        return THREE.MathUtils.radToDeg(this.getPivotRotation());
    }
    set pitch(value) {
        this.rotatePivot(THREE.MathUtils.degToRad(value));
    }

    //TODO move this to the body system
    //create rig points
    createRigPoint(name, options?): BodyState {
        const { color = '#767B91', type = 'sphere', motionType } = options || {};
        /* / TODO Cylinder throws errors
        const geometry =
            type == 'sphere'
                ? new THREE.SphereGeometry(0.8, 32, 32)
                : new THREE.CylinderGeometry(0.8, 1, 0.8, 32);
        */
        const geometry = new THREE.BoxGeometry(0.8, 0.8, 3);
        const material = new THREE.MeshBasicMaterial({ color: color });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = this.isDebugging;
        //mesh.position.set(0, 0, 0);
        this.scene.add(mesh);
        const pointHandle = this.physicsSystem.bodySystem.addBody(mesh, {
            bodyType: 'rig',
            motionType
        });
        const point = this.physicsSystem.bodySystem.getBody(pointHandle);
        // TODO resolve the rig layer issue. this blocks collisions but is a hack
        point!.body.SetIsSensor(true);
        console.log('Creating Rig Point', name, point, color, motionType);
        this.points.set(name, point);
        return point!;
    }
}
