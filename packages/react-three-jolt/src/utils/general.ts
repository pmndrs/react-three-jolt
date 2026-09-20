import type Jolt from "jolt-physics";
import * as THREE from "three";
import { Raw } from "../raw";
import type { Vector3Tuple, Vector4Tuple } from "../types";

// Get the distance between two jolt vector3s
// jolt-physics >=1.0 declares RVec3 (the "real"/world space vector every position argument takes)
// as its own class. In the single precision builds we use it is the same layout as Vec3 and the
// two are interchangeable at runtime, but the typings are not, so anything that only reads
// components accepts either and anything that feeds a position back into Jolt builds an RVec3.
export type joltVec3 = Jolt.Vec3 | Jolt.RVec3;
export type anyVec3 = joltVec3 | THREE.Vector3 | [number, number, number] | number[];

export type anyQuat = Jolt.Quat | THREE.Quaternion | [number, number, number, number];
export const vec3 = {
	tupleToJolt: (tuple: Vector3Tuple): Jolt.Vec3 => new Raw.module.Vec3(...tuple),
	threeToJolt: (vector: THREE.Vector3): Jolt.Vec3 =>
		new Raw.module.Vec3(vector.x, vector.y, vector.z),
	joltToThree: (vec: joltVec3, out = new THREE.Vector3()): THREE.Vector3 =>
		out.set(vec.GetX(), vec.GetY(), vec.GetZ()),
	joltToTuple: (vec: joltVec3) => [vec.GetX(), vec.GetY(), vec.GetZ()],

	// Extensions to simplify this ---
	// regardless of type of vec3 return the correct type
	jolt(vec: anyVec3 | number, y?: number, z?: number): Jolt.Vec3 {
		if (!vec) return new Raw.module.Vec3(0, 0, 0);
		if (typeof vec === "number") return new Raw.module.Vec3(vec, y!, z!);
		if (Array.isArray(vec)) return vec3.tupleToJolt(vec as Vector3Tuple);
		if (vec instanceof THREE.Vector3) return vec3.threeToJolt(vec);
		return vec as Jolt.Vec3;
	},
	// the RVec3 flavour of `jolt()`, for the world space position arguments of the Jolt API
	rjolt(vec: anyVec3 | number, y?: number, z?: number): Jolt.RVec3 {
		if (!vec) return new Raw.module.RVec3(0, 0, 0);
		if (typeof vec === "number") return new Raw.module.RVec3(vec, y!, z!);
		if (Array.isArray(vec)) return new Raw.module.RVec3(vec[0], vec[1], vec[2]);
		const v = vec3.three(vec);
		return new Raw.module.RVec3(v.x, v.y, v.z);
	},
	three(vec: anyVec3 | number, y?: number, z?: number): THREE.Vector3 {
		if (!vec) return new THREE.Vector3(0, 0, 0);
		if (typeof vec === "number") return new THREE.Vector3(vec, y!, z!);
		if (Array.isArray(vec)) return new THREE.Vector3(...vec);
		if (vec3.isJolt(vec)) return vec3.joltToThree(vec);
		return vec as THREE.Vector3;
	},

	joltDistanceTo: (a: joltVec3, b: joltVec3): number => {
		const dx = b.GetX() - a.GetX();
		const dy = b.GetY() - a.GetY();
		const dz = b.GetZ() - a.GetZ();
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	},
	// @ts-ignore detect if vec3 is jolt
	isJolt: (vec: anyVec3): vec is joltVec3 => vec && vec.GetX !== undefined,
	//@ts-ignore detect if vec3 is three
	isThree: (vec: anyVec3): vec is THREE.Vector3 => vec && vec.x !== undefined,
	//copy the value of a second vec3 onto the first
	joltCopy: (a: joltVec3, b: anyVec3) => {
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

export const quat = {
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
	jolt(quaternion: anyQuat): Jolt.Quat {
		if (Array.isArray(quaternion)) return quat.tupleToJolt(quaternion);
		if (quaternion instanceof THREE.Quaternion) return quat.threeToJolt(quaternion);
		return quaternion;
	},
	three(quaternion: anyQuat): THREE.Quaternion {
		if (Array.isArray(quaternion)) return new THREE.Quaternion(...quaternion);
		if (quat.isJolt(quaternion)) {
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
	// world space transforms are RMat44 / RVec3 in jolt-physics >=1.0; both the narrow phase
	// CollideShape transform and RShapeCast.mCenterOfMassStart want that flavour.
	const position = vec3.rjolt(inPosition);
	const rotation = quat.jolt(inRotation);
	const matrix = Raw.module.RMat44.prototype.sRotationTranslation(rotation, position);
	// destoy the references
	Raw.module.destroy(position);
	Raw.module.destroy(rotation);

	return matrix;
}
