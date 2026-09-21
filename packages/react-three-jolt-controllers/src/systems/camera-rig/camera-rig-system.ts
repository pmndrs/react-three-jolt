// main items of the camera rigs
//import { Raw } from '@react-three/jolt';
//import type Jolt from 'jolt-physics';

// mostly for the types
import { type anyVec3, Emitter, PhysicsSystem, type Unsubscribe, vec3 } from '@react-three/jolt';
import * as THREE from 'three';
//import { ConstraintSystem } from '@react-three/jolt';

//import { vec3, quat, convertNegativeRadians } from '@react-three/jolt';
import { BodyState } from '@react-three/jolt';

import type { CharacterControllerSystem } from '../character-controller';
import { CameraBoom, type CameraBoomOptions } from './camera-boom';

/**
 * How the rig decides where to point.
 *
 * - `free` (default): the boom only ever turns when the player turns it.
 * - `movement`: the boom eases round to trail the character's horizontal velocity, so running
 *   off in a new direction swings the camera in behind you. This is the "Mario style" camera of
 *   issue #75.
 * - `lookAt`: the boom eases round so `lookAtTarget` stays framed past the character.
 *
 * Neither automatic mode fights the player: a look command parks them for
 * `manualOverrideTimeout` milliseconds, and `movement` only acts while the character is actually
 * moving faster than `movementThreshold`.
 */
export type CameraFollowMode = 'free' | 'movement' | 'lookAt';

/**
 * What `createCamera()` accepts.
 *
 * `position` and `space` are handled explicitly; every other key is written straight onto the
 * new `THREE.PerspectiveCamera` under the same name (`fov`, `near`, `far`, `zoom`, ...), which
 * is why the index signature is here rather than a closed list.
 */
/** What {@link CameraRigManager.createRigPoint} accepts. */
export interface RigPointOptions {
    /** debug mesh colour @default '#767B91' */
    color?: THREE.ColorRepresentation;
}

export interface CameraOptions {
    /** Where the camera starts, in whichever rig space it is added to. */
    position?: anyVec3;
    /** Which rig space to parent it to: `'anchor'`, `'base'` or `'collar'` (default `'base'`). */
    space?: string;
    [key: string]: unknown;
}

/**
 * Everything a {@link CameraRigManager} (and the {@link CameraBoom} it owns) can be configured
 * with. Passing these to the constructor - which is what `useCameraRig(options)` does - is the
 * fix for issue #86: the rig used to be built with its defaults, attached to the physics loop,
 * and only then mutated into shape by whoever created it, so the first frame or two ran against
 * a half-configured boom.
 */
export interface CameraRigOptions extends CameraBoomOptions {
    /** Body the rig follows. Same thing `attach()` does, but before the first step. */
    followTarget?: BodyState;
    /** Offset of the anchor from the followed body. @default (0,2,0) */
    anchorOffset?: anyVec3;
    /** @default 'distance' */
    positionUpdateType?: 'distance' | 'fixed';
    /**
     * Where the rig's `main` camera starts, in rig space. The boom takes its length, pitch and
     * yaw from it, so the rig opens already framed (issue #86). @default (0,0,0)
     */
    cameraPosition?: anyVec3;
    /** Show the rig's debug meshes. @default true */
    debug?: boolean;

    //* Follow modes (issue #75) --------------------------
    /** How the rig decides where to point. @default 'free' */
    followMode?: CameraFollowMode;
    /** How quickly an automatic mode eases the yaw round, per second. @default 2 */
    rotationSpeed?: number;
    /** Ground speed the character has to beat before `movement` mode steers, m/s. @default 0.5 */
    movementThreshold?: number;
    /** How long a manual look command parks the automatic modes, ms. @default 1000 */
    manualOverrideTimeout?: number;
    /** What `lookAt` mode keeps framed. */
    lookAtTarget?: THREE.Object3D | THREE.Vector3;
    /** Character whose velocity drives `movement` mode. Falls back to the followed body. */
    characterSystem?: CharacterControllerSystem;
}

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

    //* Follow modes (issue #75) ==============================
    /** see {@link CameraFollowMode} */
    followMode: CameraFollowMode = 'free';
    /** how quickly an automatic mode eases the yaw round, per second */
    rotationSpeed = 2;
    /** ground speed the character has to beat before `movement` mode steers, m/s */
    movementThreshold = 0.5;
    /** how long a manual look command parks the automatic modes, ms */
    manualOverrideTimeout = 1000;
    /** what `lookAt` mode keeps framed */
    lookAtTarget?: THREE.Object3D | THREE.Vector3;
    /**
     * The character the rig is following, when there is one. `<CameraRig>` wires this up from
     * the `CharacterControllerContext`; `movement` mode prefers its velocity over the followed
     * body's because the virtual character is not a rigid body and the anchor that stands in for
     * it is kinematic.
     */
    characterSystem?: CharacterControllerSystem;

    // scratch for the follow modes, so the step stays allocation free
    private readonly followVector = new THREE.Vector3();

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
        this.points.forEach((point) => {
            point.object.visible = value;
        });
    }
    get debug() {
        return this.isDebugging;
    }

    constructor(scene: THREE.Scene, physicsSystem: PhysicsSystem, options: CameraRigOptions = {}) {
        this.scene = scene;
        this.physicsSystem = physicsSystem;
        //this.constraintSystem = physicsSystem.constraintSystem;

        this.controls = new CameraBoom(this.base, physicsSystem);

        // create the rigs
        this.scene.add(this.anchor);
        this.scene.add(this.base);
        this.scene.add(this.collar);

        // add debug shapes
        //this.insertDebugShape('anchor', '#FFF689');
        //this.insertDebugShape('collar', '#F7A278');
        //  this.insertDebugShape('base', '#B0413E');

        // Everything - the rig's own options, the boom's, and the main camera - is in place
        // before the loop can step us even once (issue #86).
        this.applyOptions(options, true);
        // attach to the physics system loop
        this.attachToLoop();
        // The world tears its disposables down before it frees the JoltInterface, so a rig that
        // outlives its own component (or is built without one) is still cleaned up (issue #162).
        this.unregisterFromWorld = physicsSystem.registerDisposable(this);
    }

    /** Drops this rig from the physics system's disposables. Replaced in the constructor. */
    private unregisterFromWorld: () => void = () => {};

    //* Options ========================================
    /**
     * Change options on a live rig. The rig is *not* rebuilt: `useCameraRig` memoises the
     * manager and funnels prop changes through here so the camera keeps its pose.
     */
    setOptions(options: CameraRigOptions = {}) {
        if (this.destroyed) return;
        this.applyOptions(options, false);
    }

    private applyOptions(options: CameraRigOptions, initializing: boolean) {
        if (options.anchorOffset !== undefined)
            this.anchorOffset.copy(vec3.three(options.anchorOffset));
        if (options.positionUpdateType !== undefined)
            this.positionUpdateType = options.positionUpdateType;
        if (options.debug !== undefined) this.debug = options.debug;
        if (options.followTarget !== undefined) this.attach(options.followTarget);

        // follow modes (issue #75) --------------------------------------
        if (options.followMode !== undefined) this.followMode = options.followMode;
        if (options.rotationSpeed !== undefined) this.rotationSpeed = options.rotationSpeed;
        if (options.movementThreshold !== undefined)
            this.movementThreshold = options.movementThreshold;
        if (options.manualOverrideTimeout !== undefined)
            this.manualOverrideTimeout = options.manualOverrideTimeout;
        if (options.lookAtTarget !== undefined) this.lookAtTarget = options.lookAtTarget;
        if (options.characterSystem !== undefined) this.characterSystem = options.characterSystem;

        if (initializing) {
            // an externally supplied camera becomes `main`; otherwise build one at the requested
            // rig-space position and let the boom derive its length/pitch/yaw from it
            let camera = options.camera;
            if (camera) this.addCamera('main', camera, 'base');
            else
                camera = this.createCamera('main', {
                    space: 'base',
                    position: vec3.three(options.cameraPosition ?? ORIGIN)
                });
            this.controls.initialize({ ...options, camera });
        } else {
            this.controls.setOptions(options);
        }
    }
    /**
     * Tear the rig down: stop being stepped, free the boom's jolt queries and remove every body
     * and three object the rig created (issue #139). Idempotent.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.unregisterFromWorld();

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
        this.cameras.forEach((camera) => {
            camera.removeFromParent();
        });
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
    attach(body: BodyState | undefined, offset?: THREE.Vector3) {
        //safety bail (a character's rig anchor is undefined until it has been created)
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
        if (this.destroyed) return;
        this.controls.move(lookVector);
    }
    zoom(zoom: number) {
        if (this.destroyed) return;
        this.controls.zoom(zoom);
    }

    //* Cameras ========================================
    // create a camera
    createCamera(name: string, options?: CameraOptions) {
        //TODO: not sure aspect ratio needs to be here
        const camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        if (options) {
            // anything other than `position`/`space` is written straight onto the camera by
            // name; three.js' PerspectiveCamera has no index signature, so the one cast here is
            // what types the dynamic write (it used to be a suppression inside the loop).
            const target = camera as unknown as Record<string, unknown>;
            for (const key in options) {
                //position is being weird
                if (key === 'position') {
                    camera.position.copy(vec3.three(options.position as anyVec3));
                } else target[key] = options[key as keyof CameraOptions];
            }
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
    private handleUpdate(deltaTime: number, _subFrame: number) {
        if (this.destroyed) return;
        this.updateSpaces();
        this.updateFollow(deltaTime);
        if (this.activeCamera && this.controls) this.controls.handleFrameUpdate(deltaTime);
    }

    //* Follow modes (issue #75) ===========================
    /**
     * Ease the boom's yaw toward whatever the current {@link CameraFollowMode} asks for.
     *
     * The PC-style rig only ever translates with the anchor, so running off sideways leaves you
     * staring at the character's ear until you drag the camera round yourself. `movement` mode
     * swings the boom in behind the direction you are actually travelling, which is the camera
     * issue #75 describes.
     */
    private updateFollow(deltaTime: number) {
        if (this.followMode === 'free' || this.destroyed) return;
        // never fight the player's hand: a look command parks us for a while afterwards
        if (this.controls.timeSinceLook < this.manualOverrideTimeout) return;

        const targetYaw = this.followMode === 'movement' ? this.movementYaw() : this.lookAtYaw();
        if (targetYaw === undefined) return;

        const current = this.controls.pivot.rotation.y;
        // atan2(sin, cos) folds the difference into -PI..PI, so we always turn the short way
        const difference = Math.atan2(Math.sin(targetYaw - current), Math.cos(targetYaw - current));
        const ease = Math.min(1, Math.max(0, this.rotationSpeed * deltaTime));
        this.controls.pivot.rotation.y = current + difference * ease;
    }

    /** Yaw that puts the boom - and so the camera - behind where the character is heading. */
    private movementYaw(): number | undefined {
        const velocity = this.followVelocity();
        if (!velocity) return undefined;
        const speedSquared = velocity.x * velocity.x + velocity.z * velocity.z;
        if (speedSquared < this.movementThreshold * this.movementThreshold) return undefined;
        // the camera rides the pivot's +Z, so trailing the character means aiming the boom back
        // down the direction they came from
        return Math.atan2(-velocity.x, -velocity.z);
    }

    /** Yaw that puts the camera on the far side of the anchor from `lookAtTarget`. */
    private lookAtYaw(): number | undefined {
        const lookAtTarget = this.lookAtTarget;
        if (!lookAtTarget) return undefined;
        if ((lookAtTarget as THREE.Object3D).isObject3D)
            (lookAtTarget as THREE.Object3D).getWorldPosition(this.followVector);
        else this.followVector.copy(lookAtTarget as THREE.Vector3);

        const dx = this.anchor.position.x - this.followVector.x;
        const dz = this.anchor.position.z - this.followVector.z;
        // standing on the target leaves no direction to look from
        if (dx * dx + dz * dz < 1e-6) return undefined;
        return Math.atan2(dx, dz);
    }

    /** Horizontal velocity of whatever the rig is following, or undefined if there is nothing. */
    private followVelocity(): THREE.Vector3 | undefined {
        const character = this.characterSystem;
        // the virtual character is not a rigid body; the anchor that stands in for it is
        // kinematic and does not necessarily carry a velocity, so ask the character first
        if (character) return this.followVector.copy(character.linearVelocity);
        if (this.attachment) return this.followVector.copy(this.attachment.velocity);
        return undefined;
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
    createRigPoint(name: string, options?: RigPointOptions): BodyState {
        // issue #227: a destroyed rig has already been dropped from the world's disposables, so
        // creating a body here would be a real Jolt body that nothing ever tears down again.
        if (this.destroyed) return undefined as unknown as BodyState;
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

//* Helpers ================================================
// shared, never mutated: the default rig-space position for the `main` camera
const ORIGIN = new THREE.Vector3(0, 0, 0);

//* Three cleanup helpers ==================================
// three geometries and materials hold GPU resources that are only released by dispose()
const disposeMesh = (object: THREE.Object3D) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material))
        material.forEach((entry) => {
            entry.dispose();
        });
    else material?.dispose();
};

const disposeObject = (object?: THREE.Object3D) => {
    if (!object) return;
    object.removeFromParent();
    object.traverse(disposeMesh);
};
