// This class holds the bodies and the management of them
import Jolt from 'jolt-physics';
import {
    //MathUtils,
    Matrix4,
    Object3D,
    // Quaternion,
    Vector3,
    InstancedMesh
} from 'three';
import * as THREE from 'three';
import { Raw } from '../raw';

import { vec3, quat, anyVec3 } from '../utils';
import type { BodySystem } from './body-system';

// Initital body object copied from r3/rapier's state object
export class BodyState {
    meshType: 'instancedMesh' | 'mesh';
    body: Jolt.Body;
    BodyID: Jolt.BodyID;
    object: Object3D | THREE.InstancedMesh;
    invertedWorldMatrix: Matrix4;
    handle: number;
    //@ts-ignore
    index: number;

    /**
     * Required for instanced rigid bodies. (from r3/rapier)
     */
    scale: Vector3;

    get isSleeping() {
        return !this.body.IsActive();
    }
    // TODO: change to this one that doesn't require setting meshType
    //const isInstance = (object: any): object is THREE.InstancedMesh => object.isInstancedMesh

    get isInstance() {
        return this.meshType === 'instancedMesh';
    }

    // contact pairs
    contacts: Map<number, number> = new Map();
    contactTimestamps: Map<number, number> = new Map();
    contactThreshold = 900;

    // Listeners ----------------------------------
    // TODO: Make Listener callback type for these
    activationListeners: Function[] = [];
    contactAddedListeners: Function[] = [];
    contactRemovedListeners: Function[] = [];
    contactPersistedListeners: Function[] = [];

    // References so we can modify the body directly
    //@ts-ignore
    private joltPhysicsSystem;
    private bodyInterface: Jolt.BodyInterface;
    private bodySystem;

    constructor(
        object: Object3D | InstancedMesh,
        body: Jolt.Body,
        joltPhysicsSystem: Jolt.PhysicsSystem,
        bodySystem: BodySystem,
        index?: number
    ) {
        this.object = object;
        this.body = body;
        this.BodyID = body.GetID();
        this.handle = this.BodyID.GetIndexAndSequenceNumber();

        // Instance properties
        this.meshType = object instanceof InstancedMesh ? 'instancedMesh' : 'mesh';
        this.invertedWorldMatrix = object.matrixWorld.clone().invert();
        if (index !== undefined) this.index = index;
        // not currently used
        this.scale = object.scale.clone();
        // not sure this is a good idea here
        this.object.userData.body = body;
        this.object.userData.bodyHandle = this.handle;

        // set the references for direct manipulation
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.bodySystem = bodySystem;
        this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
    }

    //* Activation & Contact Listeners ===================================
    // add a function to the activationListener Array
    addActivationListener(listener: Function) {
        this.activationListeners.push(listener);
    }
    // remove a function from the activationListener Array
    removeActivationListener(listener: Function) {
        this.activationListeners = this.activationListeners.filter((l) => l !== listener);
    }
    // add a function to one of the contact listener arrays with the function and which as input
    addContactListener(listener: Function, type: 'added' | 'removed' | 'persisted') {
        if (type === 'added') this.contactAddedListeners.push(listener);
        if (type === 'removed') this.contactRemovedListeners.push(listener);
        if (type === 'persisted') this.contactPersistedListeners.push(listener);
    }
    // remove a function from one of the contact listener arrays
    removeContactListener(listener: Function) {
        const indexAdded = this.contactAddedListeners.indexOf(listener);
        const indexRemoved = this.contactRemovedListeners.indexOf(listener);
        const indexPersisted = this.contactPersistedListeners.indexOf(listener);

        if (indexAdded !== -1) {
            this.contactAddedListeners.splice(indexAdded, 1);
        } else if (indexRemoved !== -1) {
            this.contactRemovedListeners.splice(indexRemoved, 1);
        } else if (indexPersisted !== -1) {
            this.contactPersistedListeners.splice(indexPersisted, 1);
        }
    }
    // get the value of a contact pair
    isContacting(handle: number) {
        return this.contacts.get(handle) || 0;
    }
    //* Updates ===============================================
    //this will be called in loop functions
    update(position: anyVec3, rotation: Jolt.Quat | THREE.Quaternion) {
        // if this is a mesh, use basic updates
        if (!this.isInstance) {
            this.object.position.copy(vec3.three(position));
            this.object.quaternion.copy(quat.three(rotation));
            return;
        }
        // we are an instance. we have to build a matrix
        const matrix = new Matrix4();
        matrix.compose(vec3.three(position), quat.three(rotation), this.scale);
        // update the matrix
        this.setMatrix(matrix);
    }

    //* Direct Manipulation ===================================
    // destroy the body
    destroy() {
        this.bodySystem.removeBody(this.handle);
    }
    // probably only used for instances
    getMatrix(matrix: Matrix4) {
        if (this.isInstance) {
            const object = this.object as THREE.InstancedMesh;
            object.getMatrixAt(this.index, matrix);
        } else matrix.copy(this.object.matrixWorld);
        return matrix;
    }
    setMatrix(matrix: Matrix4) {
        if (this.isInstance) {
            const object = this.object as THREE.InstancedMesh;
            object.setMatrixAt(this.index, matrix);
            object.instanceMatrix.needsUpdate = true;
        } else {
            this.object.matrix.copy(matrix);
            this.object.updateMatrixWorld(true);
        }
        // TODO: determine if we will really use this or not
        /*
        // now that the threeJS object is updated, we need to set the jolt body
        if (!ignoreJolt) {
            const position = this.object.position.clone();
            const rotation = this.object.quaternion.clone();
            this.position = position;
            this.rotation = rotation;
        }
        */
    }

    // Set the body position
    // TODO: NOTE. This is how to correctly cleanup a Jolt Vector
    set position(position) {
        const newPosition = vec3.jolt(position);
        this.bodyInterface.SetPosition(this.BodyID, newPosition, Raw.module.EActivation_Activate);
        Raw.module.destroy(newPosition);
    }
    // get the position of the body and wrap it in a three vector
    getPosition(asJolt?: boolean): THREE.Vector3 | Jolt.Vec3 {
        if (asJolt) return this.bodyInterface.GetPosition(this.BodyID) as Jolt.Vec3;
        return vec3.joltToThree(this.bodyInterface.GetPosition(this.BodyID) as Jolt.Vec3);
    }
    get position(): THREE.Vector3 {
        return this.getPosition() as THREE.Vector3;
    }
    // Set the body rotation
    set rotation(rotation: THREE.Quaternion) {
        this.bodyInterface.SetRotation(
            this.BodyID,
            // TODO: This is probably leaky
            quat.jolt(rotation),
            Raw.module.EActivation_Activate
        );
    }
    // get the rotation of the body and wrap it in a three quaternion
    get rotation(): THREE.Quaternion {
        return quat.joltToThree(this.bodyInterface.GetRotation(this.BodyID));
    }
    // set both position and rotation
    setPositionAndRotation(position: THREE.Vector3, rotation: THREE.Quaternion) {
        this.position = position;
        this.rotation = rotation;
    }
    // physics related getters and setters
    // get the velocity of the body
    get velocity() {
        return vec3.three(this.body.GetLinearVelocity());
    }
    // set the velocity of the body
    set velocity(velocity: Vector3) {
        this.body.SetLinearVelocity(vec3.jolt(velocity));
    }
    // get the angular velocity of the body
    get angularVelocity() {
        return vec3.three(this.body.GetAngularVelocity());
    }
    // set the angular velocity of the body
    set angularVelocity(angularVelocity: Vector3) {
        this.body.SetAngularVelocity(vec3.jolt(angularVelocity));
    }
    get color(): THREE.Color {
        // if we are a mesh, get the material color of the mesh
        if (!this.isInstance) {
            //@ts-ignore color does exist
            return (this.object as THREE.Mesh).material.color;
        }
        // if we are an instance, get the color of the instanced mesh
        const _color = new THREE.Color();
        (this.object as InstancedMesh).getColorAt(this.index, _color);
        return _color;
    }
    set color(color: THREE.Color | string | number) {
        color = color instanceof THREE.Color ? color : new THREE.Color(color);
        // if we are a mesh, set the material color of the mesh
        if (!this.isInstance) {
            //@ts-ignore
            (this.object as THREE.Mesh).material.color = color;
        }
        // if we are an instance, set the color of the instanced mesh
        (this.object as InstancedMesh).setColorAt(this.index, color);
    }

    /* debating keeping properties that can be easily accessed
    with dot notation vs a function call 
    // sensors
    get isSensor() {
        return this.body.IsSensor();
    }
    set isSensor(isSensor: boolean) {
        this.body.SetIsSensor(isSensor);
    }
    //friction
    get friction() {
        return this.body.GetFriction();
    }
    set friction(friction: number) {
        this.body.SetFriction(friction);
    }
    */

    //* Force Manipulation ----------------------------------
    // apply a force to the body
    applyForce(force: Vector3) {
        this.body.AddForce(vec3.jolt(force));
    }
    // apply a torque to the body
    applyTorque(torque: Vector3) {
        this.body.AddTorque(vec3.jolt(torque));
    }
    // add impulse to the body
    addImpulse(impulse: Vector3) {
        this.bodyInterface.AddImpulse(this.BodyID, vec3.jolt(impulse));
    }
    //move kinematic
    moveKinematic(position: Vector3, rotation: THREE.Quaternion, deltaTime = 0) {
        this.bodyInterface.MoveKinematic(
            this.BodyID,
            vec3.jolt(position),
            quat.jolt(rotation),
            deltaTime
        );
    }
    setRestitution(restitution: number) {
        this.body.SetRestitution(restitution);
    }
}
