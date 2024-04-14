// main items of the camera rigs
import { Raw } from '../raw';
import Jolt from 'jolt-physics';
import * as THREE from 'three';
// mostly for the types
import { PhysicsSystem } from './physics-system';
import { ConstraintSystem } from './constraint-system';
import { characterControllerSystem } from './character-controller';
//@ts-ignore
import { vec3, quat, convertNegativeRadians } from '../utils/';
import { BodyState } from './';
export class CameraRigManager {
    private physicsSystem: PhysicsSystem;
    private constraintSystem: ConstraintSystem;
    //@ts-ignore
    private characterSystem: characterControllerSystem;
    //@ts-ignore
    private character: Jolt.CharacterVirtual;
    //@ts-ignore
    private anchor: BodyState;
    isAttached = false;

    cameraFollowSpeed = 6;
    recenterTriggerDistance = new THREE.Vector3(3, 5, 3);
    recenterMin = 0.1;
    allowSmoothStart = true;
    allowFollowDelay = false;

    // offset off the anchor of the base
    baseOffset = new THREE.Vector3(0, 2, 0);

    // base is a point that allows drift
    base: BodyState;
    //@ts-ignore pivot is a point that allows vertical rotation
    pivot: BodyState;

    //@ts-ignore mount is where the camera lives
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
    //@ts-ignore
    activeCamera: THREE.Camera;
    target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    targetOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

    // listeners for when the camera changes or updates
    private cameraChangeListeners = [];

    // listener for the loop. we put it here so we can cancel it
    //private loopListener;

    //debugging
    private isDebugging = true;
    set debug(value: boolean) {
        this.isDebugging = value;
        this.points.forEach((point) => (point.object.visible = value));
    }
    get debug() {
        return this.isDebugging;
    }

    // holders for rig points
    points = new Map();
    //@ts-ignore
    collarConstraint: Jolt.HingeConstraint;
    constraints = new Map();

    constructor(scene: THREE.Scene, physicsSystem: PhysicsSystem) {
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
    createCamera(name: string, options?: string) {
        //TODO: not sure aspect ratio needs to be here
        const camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        //@ts-ignore loop over options and set them
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
    setActiveCamera(name: string) {
        const newCam = this.cameras.get(name);
        if (newCam) {
            this.activeCamera = newCam;
            this.triggerCameraChange();
        }
    }
    // get a camera
    getCamera(name: string) {
        return this.cameras.get(name);
    }
    // remove a camera
    removeCamera(name: string) {
        this.cameras.delete(name);
    }
    // create a camera change listener
    onCamera(change: any) {
        //@ts-ignore
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
        this.cameraChangeListeners.forEach((listener: any) => listener(this.activeCamera));
    }

    //attach a camera to a point
    //it does this by making it a child of the threejs object of the point
    attachCameraToPoint(camera: THREE.Camera, point: any) {
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
    attachToCharacter(characterSystem: characterControllerSystem) {
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
        mesh.visible = this.isDebugging;
        const options = {
            bodySettings: {
                mGravityFactor: 0
            }
        };
        const mountHandle = this.physicsSystem.bodySystem.addBody(
            mesh,
            //@ts-ignore
            options
        );
        const mount = this.physicsSystem.bodySystem.getBody(mountHandle);
        //change the mass
        this.physicsSystem.bodySystem.setMass(mountHandle, 0.00001);
        this.scene.add(mesh);
        // little bit of a hack
        //move the mount to where we want
        const basePosition = this.base.position;
        const mountPosition = basePosition.add(new THREE.Vector3(0, 4, 8));
        mount!.position = mountPosition;
        this.mount = mount!;

        // create the pivot
        /*
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
        */
        /*
        // attach the mount to the pivot.
        this.constraints.set(
            'boomArm',
            this.constraintSystem.addConstraint(
                'slider',
                this.points.get('collar'),
                mount,
                {
                    axis: new THREE.Vector3(0, 0, 1),

                    min: 2,
                    max: 10
                }
            )
        );
        */

        // lets start with a fixed constraint to test following
        this.constraintSystem.addConstraint(
            'fixed',
            this.points.get('collar'),
            //@ts-ignore
            mount
        );
    }
    //* Loop Updates and Animations ========================
    // attach to the physics loop
    private attachToLoop() {
        //TODO: consider postStep as there's a slight delay in position even if fixed
        this.physicsSystem.addPreStepListener((deltaTime: number, subFrame: number) =>
            this.handleUpdate(deltaTime, subFrame)
        );
    }
    // detach from the physics loop
    //@ts-ignore
    private detachFromLoop() {
        this.physicsSystem.removeStepListener(this.handleUpdate);
    }

    // handler for when the frame updates
    private handleUpdate(deltaTime: number, _subFrame: number) {
        //console.log('update in cameraRIgh', deltaTime);
        //if we have an anchor update the base position
        this.updateBase(deltaTime);
        this.updateTarget();
        this.updateCameraLookAt();
    }

    // Check if the base should move, if so move it smoothly
    private updateBase(_deltaTime: number) {
        //if we have an anchor update the base position
        if (!this.anchor || !this.isAttached) return;
        const newPosition = this.anchor.position.add(this.baseOffset);
        this.base.position = newPosition;
    }

    //udate the camera target position using the offset and direction
    updateTarget() {
        if (!this.anchor || this.collarConstraint == null) return;
        // for now we will just target the anchor position
        //const rotation = this.getCollarRotation();
        const targetPosition: THREE.Vector3 = this.base.position.clone();
        targetPosition.add(this.targetOffset);
        //console.log('rotation', rotation);
        //console.log('position before axis angle', targetPosition.toArray());
        //targetPosition.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
        this.target = targetPosition;
        //console.log('target', this.target);
    }

    //loop over the cameras and change the target
    updateCameraLookAt() {
        this.cameras.forEach((_camera) => {
            //camera.lookAt(this.target);
        });
    }

    //* Rig Movement ========================================
    // Rotate the collar
    rotateCollar(angle: number) {
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
    rotatePivot(angle: number) {
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
    createRigPoint(name: string, options?: any): BodyState {
        const {
            color = '#767B91',
            // type = 'sphere',
            motionType
        } = options || {};
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
