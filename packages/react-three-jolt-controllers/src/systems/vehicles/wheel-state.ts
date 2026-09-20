import { quat, Raw, vec3 } from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { disposeGeneratedObject, getWheelMaterial } from './wheels';

/**
 * The three.js side of one wheel of a `VehicleConstraint`.
 *
 * `threeObject` is the container the wheel's local transform (including the steering rotation) is
 * written to every frame. Whatever is parented to it - the generated cylinder, or the object the
 * user injected through `setObject()` (issue #27) - follows the wheel.
 */
export class WheelState {
    index: number;
    constraint: Jolt.VehicleConstraint | undefined;
    threeObject = new THREE.Object3D();
    /** the generated cylinder, if this wheel has one */
    debugObject?: THREE.Mesh;
    // because jolt isnt ready we'll put these here
    wheelRight: Jolt.Vec3 = new Raw.module.Vec3(0, 1, 0);
    wheelUp: Jolt.Vec3 = new Raw.module.Vec3(1, 0, 0);
    //true for now
    //TODO change this to default to false
    private isDebugging = true;
    /** issue #27: the object the *user* gave us. Synced, never disposed. */
    private userObject?: THREE.Object3D;

    set debug(value) {
        this.isDebugging = value;
        if (this.debugObject) this.debugObject.visible = value;
    }
    get debug() {
        return this.isDebugging;
    }
    /** whatever is being synced for this wheel: the user's object if there is one */
    get object(): THREE.Object3D | undefined {
        return this.userObject ?? this.debugObject;
    }
    // Im not sure we need this but I'll leave it for now
    wheelSettings: Jolt.WheelSettings | undefined;
    joltWheel: Jolt.Wheel | undefined;
    private destroyed = false;

    constructor(
        constraint: Jolt.VehicleConstraint,
        wheelIndex: number,
        object?: THREE.Object3D | null
    ) {
        this.constraint = constraint;
        this.index = wheelIndex;
        this.joltWheel = constraint.GetWheel(wheelIndex);
        this.wheelSettings = this.joltWheel.GetSettings();
        // a user supplied wheel replaces the generated one outright: no cylinder is ever built
        if (object) this.setObject(object);
        else this.createDebugWheel();
    }
    /**
     * Free the two axis vectors and the *generated* geometry (issue #140). The material is shared
     * between every wheel in the process, and an injected object belongs to the user, so neither
     * is disposed here (issue #27).
     */
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        Raw.module.destroy(this.wheelRight);
        Raw.module.destroy(this.wheelUp);
        this.wheelRight = undefined as unknown as Jolt.Vec3;
        this.wheelUp = undefined as unknown as Jolt.Vec3;
        // hand the user's object back untouched before anything is disposed
        this.userObject?.removeFromParent();
        this.userObject = undefined;
        if (this.debugObject) disposeGeneratedObject(this.debugObject);
        this.debugObject = undefined;
        this.threeObject.clear();
        this.threeObject.removeFromParent();
        // the constraint owns the wheel; both are freed by VehicleManager.destroy()
        this.constraint = undefined;
        this.joltWheel = undefined;
        this.wheelSettings = undefined;
    }

    /**
     * Issue #27: inject (or replace) the object this wheel syncs. Passing `null` puts the
     * generated cylinder back. The manager never disposes an object handed to it this way; it is
     * simply detached again on `destroy()`.
     */
    setObject(object: THREE.Object3D | null) {
        if (this.destroyed) return;
        if (this.userObject && this.userObject !== object) {
            this.userObject.removeFromParent();
            this.userObject = undefined;
        }
        if (object) {
            // the generated wheel is ours, so it goes for good
            if (this.debugObject) {
                disposeGeneratedObject(this.debugObject);
                this.debugObject = undefined;
            }
            this.userObject = object;
            if (object.parent !== this.threeObject) this.threeObject.add(object);
        } else if (!this.debugObject) {
            this.createDebugWheel();
        }
    }

    createDebugWheel() {
        const radius = this.wheelSettings?.mRadius ?? 0.5;
        const width = this.wheelSettings?.mWidth ?? 0.3;
        const geometry = new THREE.CylinderGeometry(radius, radius, width, 20, 1);
        const mesh = new THREE.Mesh(geometry, getWheelMaterial());
        mesh.visible = this.isDebugging;
        this.debugObject = mesh;
        this.threeObject.add(mesh);
        return mesh;
    }
    add(object: THREE.Object3D) {
        this.threeObject.add(object);
    }
    // set the wheel position and rotation
    updateLocalTransform() {
        if (this.destroyed || !this.constraint) return;
        // `GetWheelLocalTransform` (and `GetTranslation`/`GetRotation`/`GetQuaternion` below)
        // return by value, which the emscripten binder implements as a pointer to one static
        // temporary per function: not allocations, and never to be destroyed. Reading straight
        // into the three objects avoids the per frame THREE.Vector3/Quaternion garbage the old
        // `copy(vec3.three(...))` produced for every wheel of every vehicle.
        const transform = this.constraint.GetWheelLocalTransform(
            this.index,
            this.wheelRight,
            this.wheelUp
        );

        vec3.three(transform.GetTranslation(), undefined, undefined, this.threeObject.position);
        quat.joltToThree(transform.GetRotation().GetQuaternion(), this.threeObject.quaternion);
    }
}
