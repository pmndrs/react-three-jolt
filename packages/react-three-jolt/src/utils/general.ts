import Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import { Vector3Tuple, Vector4Tuple } from '../types';

// Get the distance between two jolt vector3s
export type anyVec3 =
    | Jolt.Vec3
    | Jolt.RVec3
    | THREE.Vector3
    | [number, number, number];
export const vec3 = {
    tupleToJolt: (tuple: Vector3Tuple) => new Raw.module.Vec3(...tuple),
    threeToJolt: (vector: THREE.Vector3) =>
        new Raw.module.Vec3(vector.x, vector.y, vector.z),
    joltToThree: (vec: Jolt.Vec3, out = new THREE.Vector3()) =>
        out.set(vec.GetX(), vec.GetY(), vec.GetZ()),
    joltToTuple: (vec: Jolt.Vec3) => [vec.GetX(), vec.GetY(), vec.GetZ()],

    // Extensions to simplify this ---
    // regardless of type of vec3 return the correct type
    jolt(vec: anyVec3): Jolt.Vec3 {
        if (vec instanceof Array) return vec3.tupleToJolt(vec);
        if (vec instanceof THREE.Vector3) return vec3.threeToJolt(vec);
        return vec;
    },
    three(vec: anyVec3): THREE.Vector3 {
        if (vec instanceof Array) return new THREE.Vector3(...vec);
        if (vec3.isJolt(vec)) return vec3.joltToThree(vec);
        return vec;
    },

    joltDistanceTo: (a: Jolt.Vec3, b: Jolt.Vec3) => {
        const dx = b.GetX() - a.GetX();
        const dy = b.GetY() - a.GetY();
        const dz = b.GetZ() - a.GetZ();
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    // detect if vec3 is jolt
    isJolt: (vec: anyVec3): vec is Jolt.Vec3 => vec.GetX !== undefined,
    // detect if vec3 is three
    isThree: (vec: anyVec3): vec is THREE.Vector3 => vec.x !== undefined,
    //copy the value of a second vec3 onto the first
    joltCopy: (a: Jolt.Vec3, b: anyVec3) => {
        const src = vec3.isJolt(b) ? b : vec3.threeToJolt(b);
        a.SetX(src.GetX());
        a.SetY(src.GetY());
        a.SetZ(src.GetZ());
    },
    threeCopy: (a: THREE.Vector3, b: anyVec3) => {
        const src = vec3.isThree(b) ? b : vec3.joltToThree(b);
        a.copy(b);
    },
    // whatever type A is correctly copy the value of B onto it
    copy(a: anyVec3, b: anyVec3) {
        if (vec3.isJolt(a)) vec3.joltCopy(a, b);
        else vec3.threeCopy(a, b);
    }
};

export const quat = {
    tupleToJolt: (tuple: Vector4Tuple) => new Raw.module.Quat(...tuple),
    threeToJolt: (quaternion: THREE.Quaternion) =>
        new Raw.module.Quat(
            quaternion.x,
            quaternion.y,
            quaternion.z,
            quaternion.w
        ),
    joltToThree: (quat: Jolt.Quat, out = new THREE.Quaternion()) =>
        out.set(quat.GetX(), quat.GetY(), quat.GetZ(), quat.GetW()),
    joltToTuple: (quat: Jolt.Quat) => [
        quat.GetX(),
        quat.GetY(),
        quat.GetZ(),
        quat.GetW()
    ],
    isThree: (quaternion): quaternion is THREE.Quaternion =>
        quaternion.x !== undefined,
    isJolt: (quaternion): quaternion is Jolt.Quat =>
        quaternion.GetX !== undefined,
    jolt(quaternion: anyQuat): Jolt.Quat {
        if (quaternion instanceof Array) return quat.tupleToJolt(quaternion);
        if (quaternion instanceof THREE.Quaternion)
            return quat.threeToJolt(quaternion);
        return quaternion;
    },
    three(quaternion: anyQuat): THREE.Quaternion {
        if (quaternion instanceof Array)
            return new THREE.Quaternion(...quaternion);
        if (quat.isJolt(quaternion)) {
            console.log('is jolt', quaternion);
            return quat.joltToThree(quaternion);
        }
        return quaternion;
    }
};

export const convertNegativeRadians = (radians: number): number => {
    if (radians < 0) {
        return radians + 2 * Math.PI;
    }
    return radians;
};

//convert basic strings to add m and uppercase the first letter
export function joltPropName(propertyName) {
    //jolt capitalizes the first letter and appends a lowercase 'm'
    return 'm' + propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
}

// get the bounding box of a three object
export function getBoundingBox(object: THREE.Object3D) {
    const box = new THREE.Box3();
    box.setFromObject(object);
    return box;
}
