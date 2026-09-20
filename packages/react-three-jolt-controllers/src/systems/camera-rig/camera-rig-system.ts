// main items of the camera rigs
//import { Raw } from '@react-three/jolt';
//import type Jolt from 'jolt-physics';

// mostly for the types
import { Emitter, PhysicsSystem, type Unsubscribe, vec3 } from '@react-three/jolt';
import * as THREE from 'three';
//import { ConstraintSystem } from '@react-three/jolt';

//import { vec3, quat, convertNegativeRadians } from '@react-three/jolt';
import { BodyState } from '@react-three/jolt';

import { CameraBoom } from './camera-boom';

export type CameraChangeCallback = (
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined
) => void;
type CameraRigEventMap = { camera: CameraChangeCallback };

//activate camera controls
export class CameraRigManager {
    private physicsSystem: PhysicsSystem;
    //private constraintSystem: ConstraintSystem;

    isAttached = false;

    // offset off the anchor from the body
    anchorOffset = new THREE.Vector3(0, 2, 0);
    // how the movement will be updated
    positionUpdateType: 'distance' | 'fixed' = 'distance';
    camerMoveLerpFactor = 1;

    //rig spaces -------------------------------
    anchor = new THREE.Object3D();
    base = new THREE.Object3D();
    collar = new THREE.Object3D();

    mount?: BodyState;
    attachment?: BodyState;

    controls: CameraBoom;

    // holders for rig points
    points = new Map();
    constraints = new Map();

    //threeJS scene needed to add points to
    scene: THREE.Scene;

    // cameras ---------------------------------
    cameras: Map<string, THREE.PerspectiveCamera | THREE.OrthographicCamera> = new Map();
    activeCamera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;

    target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    targetOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

    // listeners for when the camera changes or updates
    private events = new Emitter<CameraRigEventMap>();

    /** true once `destroy()` has run */
    private destroyed = false;

    /**
     * The function handed to `onBeforeStep`. Removal is by the returned unsubscribe now
     * (issue #187), not by identity - which is what used to break: `detachFromLoop()` passed
     * `this.handleUpdate`, a different function object than the inline arrow that was actually
     * registered, so it silently did nothing and the rig kept stepping after `destroy()`
     * (issue #139). Kept hoisted so reattaching does not build a fresh closure.
     */
    private readonly handlePreStep = (deltaTime: number, subFrame: number) =>
        this.handleUpdate(deltaTime, subFrame);

    //debugging
    private isDebugging = true;
    set debug(value: boolean) {
        this.isDebugging = value;
        this.points.forEach((point) => (point.object.visible = value));
    }
    get debug() {
        return this.isDebugging;
    }

    constructor(scene: THREE.Scene, physicsSystem: PhysicsSystem) {
        this.scene = scene;
        this.physicsSystem = physicsSystem;
        //this.constraintSystem = physicsSystem.constraintSystem;

        this.controls = new CameraBoom(this.base, physicsSystem);

        // attach to the physics system loop
        this.attachToLoop();
        // create the rigs
        this.scene.add(this.anchor);
        this.scene.add(this.base);
        this.scene.add(this.collar);

        // add debug shapes
        //this.insertDebugShape('anchor', '#FFF689');
        //this.insertDebugShape('collar', '#F7A278');
        //  this.insertDebugShape('base', '#B0413E');

        this.createCamera('main', { space: 'base', position: new THREE.Vector3(4, 4, 4) });
        // put the camera into the control boom
        this.controls.camera = this.getCamera('main') as THREE.PerspectiveCamera;
    }
    /**
     * Tear the rig down: stop being stepped, free the boom's jolt queries and remove every body
     * and three object the rig created (issue #139). Idempotent.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        this.detachFromLoop();
        // the boom owns a raycaster, a shapecaster and a shape collider - ~25 wasm objects
        this.controls?.destroy();

        // rig points are real bodies in the simulation
        this.points.forEach((point) => {
            const mesh = point?.object as THREE.Object3D | undefined;
            this.physicsSystem.bodySystem.removeBody(point.handle);
            disposeObject(mesh);
        });
        this.points.clear();
        this.constraints.clear();

        // remove the cameras
        this.cameras.forEach((camera) => camera.removeFromParent());
        this.cameras.clear();
        this.activeCamera = undefined;
        // camera-change listeners live on the Emitter now (issue #50/#187)
        this.events.clear();

        // remove the rigs (and any debug shapes parented to them)
        for (const space of [this.anchor, this.base, this.collar]) {
            this.scene.remove(space);
            space.traverse(disposeMesh);
            space.clear();
        }
        this.attachment = undefined;
        this.mount = undefined;
        this.isAttached = false;
    }

    // Temoporary debug shapes in spaces
    insertDebugShape(space = 'base', color = '#58355E') {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: color })
        );
        switch (space) {
            case 'anchor':
                this.anchor.add(mesh);
                break;
            case 'collar':
                this.collar.add(mesh);
                break;
            default:
                this.base.add(mesh);
        }
    }

    //* Anchor attachment ===================================
    attach(body: BodyState, offset?: THREE.Vector3) {
        //safety bail
        if (!body) return;
        if (offset) this.anchorOffset = offset;
        this.attachment = body;
        this.isAttached = true;
    }
    detach() {
        // disable the anchor constraint
        this.isAttached = false;
    }
    reAttach() {
        if (this.attachment) this.isAttached = true;
    }

    //* Camera Boom ========================================
    moveBoom(lookVector: THREE.Vector2Like) {
        this.controls.move(lookVector);
    }
    zoom(zoom: number) {
        this.controls.zoom(zoom);
    }

    //* Cameras ========================================
    // create a camera
    createCamera(name: string, options?: any) {
        //TODO: not sure aspect ratio needs to be here
        const camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        //@ts-ignore loop over options and set them
        if (options)
            for (const key in options) {
                //position is being weird
                if (key == 'position') {
                    camera.position.copy(vec3.three(options[key]));
                    //@ts-ignore
                } else camera[key] = options[key];
            }
        // add to list
        this.addCamera(name, camera, options?.space);
        // if there is no active camera set this to it
        // TODO: Determine if we should set the camera if there isn't one
        // I worry it will cause a flash
        //if (!this.activeCamera) this.setActiveCamera(name);
        return camera;
    }
    // allow an external camera to be added
    addCamera(
        name: string,
        camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
        space?: string
    ) {
        this.cameras.set(name, camera);
        if (space) this.addCameraToSpace(camera, space);
        else this.scene.add(camera);

        //look at the target
        camera.lookAt(this.target);
    }
    // set the active camera
    setActiveCamera(name: string) {
        const newCam = this.cameras.get(name);
        if (newCam) {
            this.activeCamera = newCam;

            this.triggerCameraChange();
        }
    }
    resetCameraSpace(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
        if (camera.userData.originalSpace)
            this.addCameraToSpace(camera, camera.userData.originalSpace);
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
    onCamera(change: CameraChangeCallback): Unsubscribe {
        return this.events.on('camera', change);
    }
    // trigger the camera change listeners
    private triggerCameraChange() {
        this.events.emit('camera', this.activeCamera);
    }

    //attach a camera to a point
    //it does this by making it a child of the threejs object of the point
    addCameraToSpace(camera: THREE.Camera, space = 'base') {
        switch (space) {
            case 'anchor':
                this.anchor.add(camera);
                break;
            case 'collar':
                this.collar.add(camera);
                break;
            default:
                this.base.add(camera);
        }
        // because cameraControls cant operate in child space, we need to know the original space
        camera.userData.originalSpace = space;
    }

    //* Loop Updates and Animations ========================
    /** Unsubscribe for the pre-step callback; a no-op until `attachToLoop` runs. */
    private stepUnsubscribe: () => void = () => {};
    // attach to the physics loop
    private attachToLoop() {
        //TODO: consider postStep as there's a slight delay in position even if fixed
        this.stepUnsubscribe();
        this.stepUnsubscribe = this.physicsSystem.onBeforeStep(this.handlePreStep);
    }
    // detach from the physics loop
    // This used to call `removeStepListener(this.handleUpdate)` - a different object than the
    // arrow that was actually subscribed - so it silently did nothing and `destroy()` left the
    // rig stepping forever.
    private detachFromLoop() {
        this.stepUnsubscribe();
        this.stepUnsubscribe = () => {};
    }

    // handler for when the frame updates
    private handleUpdate(_deltaTime: number, _subFrame: number) {
        if (this.destroyed) return;
        this.updateSpaces();
        if (this.activeCamera && this.controls) this.controls.handleFrameUpdate();
    }

    updateSpaces() {
        if (!this.attachment) return;
        // update the anchor position and rotation
        this.anchor.position.copy(this.attachment.position).add(this.anchorOffset);
        this.anchor.quaternion.copy(this.attachment.rotation);

        // The base just copies the position of the anchor
        this.base.position.copy(this.anchor.position);

        // the collar copies the position of the anchor
        this.collar.position.copy(this.anchor.position);
        // then copies the y axis rotation of the anchor
        const newQuat = this.anchor.quaternion.clone();
        newQuat.x = 0;
        newQuat.z = 0;
        this.collar.quaternion.copy(newQuat);
    }

    //TODO move this to the body system
    //create rig points
    createRigPoint(name: string, options?: any): BodyState {
        const {
            color = '#767B91'
            // type = 'sphere',
            //motionType
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
            bodyType: 'dynamic',
            motionType: 'dynamic'
        });
        const point = this.physicsSystem.bodySystem.getBody(pointHandle);
        // TODO resolve the rig layer issue. this blocks collisions but is a hack
        point!.body.SetIsSensor(true);
        // console.log('Creating Rig Point', name, point, color, motionType);
        this.points.set(name, point);
        return point!;
    }
}

//* Three cleanup helpers ==================================
// three geometries and materials hold GPU resources that are only released by dispose()
const disposeMesh = (object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
};

const disposeObject = (object?: THREE.Object3D) => {
    if (!object) return;
    object.removeFromParent();
    object.traverse(disposeMesh);
};
