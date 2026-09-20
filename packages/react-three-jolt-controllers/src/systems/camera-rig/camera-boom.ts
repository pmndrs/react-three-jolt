// main items of the camera rigs

// mostly for the types
import {
    type anyVec3,
    createShapeFromSettings,
    type PhysicsSystem,
    Raw,
    type Raycaster,
    type RaycastHit,
    releaseShape,
    type ShapeCollider,
    type Shapecaster,
    type ShapecastHit,
    vec3
} from '@react-three/jolt';
import * as THREE from 'three';

/**
 * Options for a {@link CameraBoom}. Every one of these used to be set by mutating the boom after
 * it had been constructed (and, through `useCameraRig`, a frame or two after it had already been
 * stepped), which is what issue #86 is about: pass them to the constructor, to
 * {@link CameraBoom.initialize} or to {@link CameraRigManager}'s options instead and the boom is
 * fully configured before the first `handlePreStep`.
 */
export interface CameraBoomOptions {
    /** Boom length: how far the camera sits from the pivot, in metres. @default 5 */
    distance?: number;
    /** Closest the boom may be zoomed in, in metres. @default 0.1 */
    minDistance?: number;
    /** Furthest the boom may be zoomed out, in metres. @default 100 */
    maxDistance?: number;
    /** Starting boom pitch in radians. Negative looks down at the target. @default 0 */
    pitch?: number;
    /** Lowest pitch a look command may reach, in radians. @default -1.5 */
    minPitch?: number;
    /** Highest pitch a look command may reach, in radians. @default 0.5 */
    maxPitch?: number;
    /** Starting boom yaw in radians, measured about the world up axis. @default 0 */
    yaw?: number;
    /** Radius of the sphere used for the camera's collision test, in metres. @default 0.3 */
    collisionRadius?: number;
    /** Lerp factor used while the boom moves to a new length, 0..1. @default 0.5 */
    smoothing?: number;
    /** Multiplier on look (pointer/stick) input. @default 1 */
    lookSpeed?: number;
    /** Multiplier on zoom (wheel) input. @default 1 */
    zoomSpeed?: number;
    /** Skip the collision, obstruction and shapecast tests entirely. @default false */
    allowCameraClipping?: boolean;
    /** Gap kept between the camera and whatever obstructs it, in metres. @default 0.01 */
    obstructionBuffer?: number;
    /** Point the boom frames, relative to the pivot. @default (0,0,0) */
    target?: anyVec3;
    /** `demand` recomputes the camera pose on every command, `additive` once per frame. @default 'demand' */
    updateMode?: 'demand' | 'additive';
    /**
     * Camera to attach to the boom. When it sits somewhere other than the origin the boom takes
     * its length, pitch and yaw from that position, so `<CameraRig cameraPosition={[4,4,4]} />`
     * starts framed instead of snapping on the first frame (issue #86). An explicit `distance`,
     * `pitch` or `yaw` still wins.
     */
    camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
}

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
    /** lowest pitch `handleLookUpdate` will let the camera space reach, radians */
    minPitch = -1.5;
    /** highest pitch `handleLookUpdate` will let the camera space reach, radians */
    maxPitch = 0.5;
    maxShapecastingTime = 5000;
    allowCameraClipping = false;
    limitShapecasting = false;

    //maybe internal props
    camFactor = 0.002;
    zoomFactor = 0.002;
    obstructionBuffer = 0.01;

    // Obstruction props -------------------------
    // minimum distance to be clear of obstru
    clearDistance = 5;
    timeObstructed = 0;
    timeShapecasting = 0;
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
    isShapecasting = false;
    minLerpClearance = 0.01;
    rearcastFactor = 1;

    // camera target in worldspace
    target = new THREE.Vector3(0, 0, 0);

    updateMode: 'demand' | 'additive' = 'demand';

    pivot = new THREE.Object3D();
    cameraSpace = new THREE.Object3D();
    lookVector = new THREE.Vector2(0, 0);

    /** radius currently realised in `collider.shape`, so setOptions can skip a no-op rebuild */
    private colliderRadius?: number;

    private destroyed = false;

    constructor(base: THREE.Object3D, physicsSystem: PhysicsSystem, options?: CameraBoomOptions) {
        this.physicsSystem = physicsSystem;
        this.raycaster = physicsSystem.getRaycaster();
        this.shapecaster = physicsSystem.getShapecaster();
        // set the raycaster to get all results
        this.raycaster.setCollector('all');

        // collider
        this.collider = physicsSystem.getShapeCollider();
        // create the pivot and camera space
        base.add(this.pivot);
        this.pivot.add(this.cameraSpace);
        // everything a caller passed is in place before the boom is ever stepped (issue #86)
        this.initialize(options);
    }

    /**
     * Free the three query objects the boom owns (issue #139). The raycaster, shapecaster and
     * collider each hold roughly a dozen wasm allocations - filters, collectors, settings - and
     * nothing used to free them, so every rig leaked ~25 jolt objects.
     *
     * Idempotent: `Raw.module.destroy()` does not throw on an already freed pointer, it silently
     * frees it a second time, so the guard is what makes a double teardown safe.
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        this.raycaster?.destroy();
        this.shapecaster?.destroy();
        this.collider?.destroy();
        this.raycaster = undefined as unknown as Raycaster;
        this.shapecaster = undefined as unknown as Shapecaster;
        this.collider = undefined as unknown as ShapeCollider;

        // detach the camera (and anything else parented to the boom) from the rig
        if (this.activeCamera) this.cameraSpace.remove(this.activeCamera);
        this.activeCamera = undefined;
        this.pivot.removeFromParent();
        this.pivot.clear();
        this.cameraSpace.clear();
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

        //reset the camera to a 0 position
        camera.position.set(0, 0, 0);
        this.cameraSpace.add(camera);
        this.activeCamera = camera;
        this.handleLookUpdate();
    }
    get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined {
        return this.activeCamera;
    }

    /** current boom yaw about the world up axis, radians */
    get yaw() {
        return this.pivot.rotation.y;
    }
    set yaw(value: number) {
        this.pivot.rotation.y = value;
    }
    /** current boom pitch, radians. Negative looks down at the target. */
    get pitch() {
        return this.cameraSpace.rotation.x;
    }
    set pitch(value: number) {
        this.cameraSpace.rotation.x = THREE.MathUtils.clamp(value, this.minPitch, this.maxPitch);
        this.handleZoomUpdate();
    }

    //* Options ========================================
    /**
     * Configure the boom and snap it to the resulting pose. This is the "before the first frame"
     * entry point of issue #86: the length, pitch limits, collision radius, follow target and
     * smoothing all land here rather than being mutated onto a boom that is already being
     * stepped.
     */
    initialize(options: CameraBoomOptions = {}) {
        this.applyOptions(options, true);
    }

    /**
     * Change options on a live boom. Unlike {@link initialize} a new `distance` is eased into
     * rather than snapped to, and the pose is only touched for the options that were passed.
     */
    setOptions(options: CameraBoomOptions = {}) {
        this.applyOptions(options, false);
    }

    private applyOptions(options: CameraBoomOptions, initializing: boolean) {
        if (this.destroyed) return;

        // #86: derive the boom pose from where the camera was put, so a camera handed to the rig
        // at (4,4,4) ends up looking at the target from (4,4,4) instead of being teleported to
        // the boom's default (0,0,distance) on the first frame.
        let distance = options.distance;
        let pitch = options.pitch;
        let yaw = options.yaw;
        const camera = options.camera;
        if (initializing && camera && camera.position.lengthSq() > 1e-8) {
            const position = camera.position;
            const length = position.length();
            if (distance === undefined) distance = length;
            // cameraSpace.position.y is `distance * sin(-pitch)`, so invert that
            if (pitch === undefined)
                pitch = -Math.asin(THREE.MathUtils.clamp(position.y / length, -1, 1));
            if (yaw === undefined && (position.x !== 0 || position.z !== 0))
                yaw = Math.atan2(position.x, position.z);
        }

        // plain scalars -------------------------------------------------
        if (options.minDistance !== undefined) this.minDistance = options.minDistance;
        if (options.maxDistance !== undefined) this.maxDistance = options.maxDistance;
        if (options.minPitch !== undefined) this.minPitch = options.minPitch;
        if (options.maxPitch !== undefined) this.maxPitch = options.maxPitch;
        if (options.smoothing !== undefined) this.slerpFactor = options.smoothing;
        if (options.lookSpeed !== undefined) this.lookSpeed = options.lookSpeed;
        if (options.zoomSpeed !== undefined) this.zoomSpeed = options.zoomSpeed;
        if (options.allowCameraClipping !== undefined)
            this.allowCameraClipping = options.allowCameraClipping;
        if (options.obstructionBuffer !== undefined)
            this.obstructionBuffer = options.obstructionBuffer;
        if (options.updateMode !== undefined) this.updateMode = options.updateMode;
        if (options.target !== undefined) this.target.copy(vec3.three(options.target));

        // collision radius ----------------------------------------------
        if (options.collisionRadius !== undefined) this.setCollisionRadius(options.collisionRadius);

        // pose ----------------------------------------------------------
        if (yaw !== undefined) this.pivot.rotation.y = yaw;
        if (pitch !== undefined)
            this.cameraSpace.rotation.x = THREE.MathUtils.clamp(
                pitch,
                this.minPitch,
                this.maxPitch
            );
        if (distance !== undefined) {
            const clamped = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
            this.initialDistance = clamped;
            this.targetDistance = clamped;
            if (initializing) {
                // nothing has been stepped yet, so there is nothing to ease from
                this.currentDistance = clamped;
                this.clearDistance = clamped;
                this.isMoving = false;
            } else {
                // let handleDistanceUpdate lerp us there over the next few frames
                this.clearDistance = clamped;
                this.isMoving = true;
            }
        }
        if (initializing || distance !== undefined || pitch !== undefined) this.handleZoomUpdate();

        if (camera) this.camera = camera;
    }

    /** Swap the sphere the camera collision test uses for one of `radius` metres. */
    setCollisionRadius(radius: number) {
        if (this.destroyed || !this.collider) return;
        if (this.colliderRadius === radius) return;
        // createShapeFromSettings hands back a shape we own a reference on and destroys the
        // settings; the collider AddRef()s it in its own setter, so we drop ours right after.
        const shape = createShapeFromSettings(new Raw.module.SphereShapeSettings(radius));
        this.collider.shape = shape;
        releaseShape(shape);
        this.colliderRadius = radius;
    }

    //* Methods ========================================
    // look comand takes x/y vector in -1 to 1 range
    move(lookVector: THREE.Vector2Like) {
        this.lookVector.set(lookVector.x, lookVector.y);
        if (this.updateMode === 'demand') this.handleLookUpdate();
    }
    zoom(factor: number) {
        const desiredDistance = this.currentDistance + factor * this.zoomFactor * this.zoomSpeed;
        //if the desired distance is more than the clear distance bail
        if (this.isShapecasting && desiredDistance >= this.clearDistance) return;
        this.currentDistance = desiredDistance;
        this.targetDistance = this.currentDistance;
        //apply min/max
        if (this.currentDistance < this.minDistance) this.currentDistance = this.minDistance;
        if (this.currentDistance > this.maxDistance) this.currentDistance = this.maxDistance;
        if (this.updateMode === 'demand') this.handleZoomUpdate();
    }
    rotate(changeValue: number) {
        //todo make this use slerping like distance
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
            if (this.updateMode === 'demand') this.handleZoomUpdate();
        } else this.isMoving = true;
    }

    //* Update movements ========================================
    handleLookUpdate() {
        // lookVector is now the delta between previous events
        this.pivot.rotation.y -= this.lookVector.x * this.camFactor * this.lookSpeed;
        const vy =
            this.cameraSpace.rotation.x + this.lookVector.y * this.camFactor * this.lookSpeed;

        // the pitch limits used to be the literals -1.5 and 0.5; they are options now (#86)
        if (vy >= this.minPitch && vy <= this.maxPitch) {
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
    handleFrameUpdate(_deltaTime = 1 / 60) {
        // handle additive mode (gamepad and joystick controls)
        // TODO  do additive mode
        // do the obstruction test
        if (this.destroyed || !this.activeCamera) return;
        if (!this.allowCameraClipping) {
            // these are tested individually because they both can activate shapecasting
            if (!this.isShapecasting) this.doCollisionTest();
            if (!this.isShapecasting) this.doObstructionTest();
            if (this.isShapecasting) this.doShapecastTest();
        }
        // handle the distance update
        this.handleDistanceUpdate();
    }
    // frame driven distance handle
    handleDistanceUpdate() {
        if (this.isMoving) {
            // let us zoom in
            if (this.targetDistance < this.clearDistance) this.clearDistance = this.targetDistance;
            this.currentDistance = THREE.MathUtils.lerp(
                this.currentDistance,
                this.clearDistance,
                this.slerpFactor
            );
            if (Math.abs(this.currentDistance - this.clearDistance) < this.minLerpClearance) {
                this.currentDistance = this.clearDistance;
                this.isMoving = false;
            }
            if (this.updateMode === 'demand') this.handleZoomUpdate();
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
                if (body.allowObstruction === false) this.isShapecasting = true;

                // check if we are beyond the obstruction time
                if (
                    body.obstructionType === 'temporal' &&
                    this.timeObstructed > body.obstructionTimelimit
                )
                    this.isShapecasting = true;
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
            this.isShapecasting = true;
            //this.currentDistance = this.clearDistance;
            //if (this.updateMode === "demand") this.handleZoomUpdate();
        }
    }
    doShapecastTest() {
        // timer to limit constant shapecasting
        // assume 60fps
        let forceRetarget = false;
        if (this.limitShapecasting) {
            this.timeShapecasting++;
            if (this.timeShapecasting > this.maxShapecastingTime / 60) {
                forceRetarget = true;
                this.timeShapecasting = 0;
            }
        }
        const obstruction = this.castObstructionShape();
        if (obstruction) {
            // get the distance to the obstruction
            const distance = this.pivotWorldSpace.distanceTo(obstruction.position);
            // set the clear distance to this distance
            this.clearDistance = distance - this.obstructionBuffer;
            this.isMoving = true;
            if (forceRetarget) {
                this.targetDistance = this.clearDistance;
                this.isShapecasting = false;
            }
            return;
        }

        // if we are not obstructed we can move to target
        if (this.clearDistance !== this.targetDistance) {
            this.clearDistance = this.targetDistance;
            this.isMoving = true;
        } else this.isShapecasting = false;
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
