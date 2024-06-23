import type { Quaternion, Vector3 } from '@react-three/fiber';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import type { Vector3Tuple, Vector4Tuple } from '../types';

export const isColor = (color: any): color is THREE.Color => (color as THREE.Color).isColor;

export const isVector3 = (vector: any): vector is THREE.Vector3 =>
    (vector as THREE.Vector3).isVector3;

export const isEuler = (euler: any): euler is THREE.Euler => (euler as THREE.Euler).isEuler;

export const isQuaternion = (quaternion: any): quaternion is THREE.Quaternion =>
    (quaternion as THREE.Quaternion).isQuaternion;

export const isMesh = (object: any): object is THREE.Mesh => (object as THREE.Mesh).isMesh;

export const isBoxGeometry = (geometry: any): geometry is THREE.BoxGeometry =>
    (geometry as THREE.BoxGeometry).type === 'BoxGeometry';

export const isSphereGeometry = (geometry: any): geometry is THREE.SphereGeometry =>
    (geometry as THREE.SphereGeometry).type === 'SphereGeometry';

export const isCylinderGeometry = (geometry: any): geometry is THREE.CylinderGeometry =>
    (geometry as THREE.CylinderGeometry).type === 'CylinderGeometry';

export const isCapsuleGeometry = (geometry: any): geometry is THREE.CapsuleGeometry =>
    (geometry as THREE.CapsuleGeometry).type === 'CapsuleGeometry';

export const isBufferGeometry = (geometry: any): geometry is THREE.BufferGeometry =>
    (geometry as THREE.BufferGeometry).type === 'BufferGeometry';

// Get the distance between two jolt vector3s
export type anyVec3 = Jolt.Vec3 | Jolt.RVec3 | THREE.Vector3 | Vector3 | THREE.Euler;

export type anyQuat = Jolt.Quat | THREE.Quaternion | Quaternion;

export const vec3 = {
    tuple: (v: anyVec3): Vector3Tuple => {
        if (!v) return [0, 0, 0];

        if (Array.isArray(v)) {
            return v;
        }

        if (isVector3(v) || isEuler(v)) {
            return [v.x, v.y, v.z];
        }

        if (vec3.isJolt(v)) {
            return [v.GetX(), v.GetY(), v.GetZ()];
        }

        const scalar = v as number;

        return [scalar, scalar, scalar];
    },

    tupleToJolt: (tuple: Vector3Tuple): Jolt.Vec3 => new Raw.module.Vec3(...tuple),
    threeToJolt: (vector: THREE.Vector3): Jolt.Vec3 =>
        new Raw.module.Vec3(vector.x, vector.y, vector.z),
    joltToThree: (vec: Jolt.Vec3, out = new THREE.Vector3()): THREE.Vector3 =>
        out.set(vec.GetX(), vec.GetY(), vec.GetZ()),
    joltToTuple: (vec: Jolt.Vec3) => [vec.GetX(), vec.GetY(), vec.GetZ()],

    // Extensions to simplify this ---
    // regardless of type of vec3 return the correct type
    jolt(vec: anyVec3 | number, out = new Raw.module.Vec3()): Jolt.Vec3 {
        const tuple = vec3.tuple(vec);

        out.Set(tuple[0], tuple[1], tuple[2]);

        return out;
    },
    three(vec: anyVec3, out = new THREE.Vector3()): THREE.Vector3 {
        const tuple = vec3.tuple(vec);

        out.set(tuple[0], tuple[1], tuple[2]);

        return out;
    },

    joltDistanceTo: (a: Jolt.Vec3, b: Jolt.Vec3): number => {
        const dx = b.GetX() - a.GetX();
        const dy = b.GetY() - a.GetY();
        const dz = b.GetZ() - a.GetZ();
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    // @ts-ignore detect if vec3 is jolt
    isJolt: (vec: anyVec3): vec is Jolt.Vec3 => vec && vec.GetX !== undefined,
    //@ts-ignore detect if vec3 is three
    isThree: (vec: anyVec3): vec is THREE.Vector3 => vec && vec.x !== undefined,
    //copy the value of a second vec3 onto the first
    joltCopy: (a: Jolt.Vec3, b: anyVec3) => {
        //@ts-ignore
        const src = vec3.isJolt(b) ? b : vec3.threeToJolt(b);
        a.SetX(src.GetX());
        a.SetY(src.GetY());
        a.SetZ(src.GetZ());
    },
    threeCopy: (a: THREE.Vector3, b: anyVec3) => {
        //@ts-ignore
        const src = vec3.isThree(b) ? b : vec3.joltToThree(b);
        a.copy(src);
    },
    // whatever type A is correctly copy the value of B onto it
    copy(a: anyVec3, b: anyVec3) {
        if (vec3.isJolt(a)) vec3.joltCopy(a, b);
        //@ts-ignore
        else vec3.threeCopy(a, b);
    }
};

export const euler = {
    three: (euler: anyVec3, out = new THREE.Euler()): THREE.Euler => {
        const tuple = vec3.tuple(euler);

        out.set(tuple[0], tuple[1], tuple[2]);

        return out;
    }
};

export const quat = {
    tuple: (v: anyQuat | undefined): Vector4Tuple => {
        if (!v) return [0, 0, 0, 1];

        if (isQuaternion(v)) {
            return [v.x, v.y, v.z, v.w];
        }

        if (Array.isArray(v)) {
            return v;
        }

        if (quat.isJolt(v)) {
            return [v.GetX(), v.GetY(), v.GetZ(), v.GetW()];
        }

        return v;
    },

    //@ts-ignore stupid tuple type
    tupleToJolt: (tuple: Vector4Tuple) => new Raw.module.Quat(...tuple),
    threeToJolt: (quaternion: THREE.Quaternion) =>
        new Raw.module.Quat(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
    joltToThree: (quat: Jolt.Quat, out = new THREE.Quaternion()) =>
        out.set(quat.GetX(), quat.GetY(), quat.GetZ(), quat.GetW()),
    joltToTuple: (quat: Jolt.Quat) => [quat.GetX(), quat.GetY(), quat.GetZ(), quat.GetW()],

    isThree: (quaternion: anyQuat): quaternion is THREE.Quaternion =>
        //@ts-ignore
        quaternion.x !== undefined,
    isJolt: (quaternion: anyQuat): quaternion is Jolt.Quat =>
        //@ts-ignore
        quaternion.GetX !== undefined,

    jolt(quaternion: anyQuat, out = new Raw.module.Quat()): Jolt.Quat {
        const tuple = quat.tuple(quaternion);

        out.Set(tuple[0], tuple[1], tuple[2], tuple[3]);

        return out;
    },
    three(quaternion: anyQuat | undefined, out = new THREE.Quaternion()): THREE.Quaternion {
        const tuple = quat.tuple(quaternion);

        out.set(tuple[0], tuple[1], tuple[2], tuple[3]);

        return out;
    }
};

export const convertNegativeRadians = (radians: number): number => {
    if (radians < 0) {
        return radians + 2 * Math.PI;
    }
    return radians;
};

//convert basic strings to add m and uppercase the first letter
export function joltPropName(propertyName: string) {
    //jolt capitalizes the first letter and appends a lowercase 'm'
    return `m${propertyName.charAt(0).toUpperCase()}${propertyName.slice(1)}`;
}

// get the bounding box of a three object
export function getBoundingBox(object: THREE.Object3D) {
    const box = new THREE.Box3();
    box.setFromObject(object);
    return box;
}

export function generateJoltMatrix(inPosition: anyVec3, inRotation: anyQuat, _inScale?: anyVec3) {
    // generate a new Jolt matrix
    //apply the position
    const position = vec3.jolt(inPosition);
    const rotation = quat.jolt(inRotation);
    const matrix = Raw.module.Mat44.prototype.sRotationTranslation(rotation, position);
    // destoy the references
    Raw.module.destroy(position);
    Raw.module.destroy(rotation);

    return matrix;
}
