import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import type { Vector3Tuple, Vector4Tuple } from '../types';

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------
// The library is bundled by rollup with no NODE_ENV replacement, so we can't
// gate console output on `process.env.NODE_ENV === 'production'` the way an
// app bundler would let us. Instead we expose one module-level switch: all
// internal console output stays silent until a consumer opts in.
let debug = false;

// Enable or disable react-three-jolt's internal console output (off by
// default). Intended for library development/debugging, not for consumers
// to leave on in production.
export function setDebug(flag: boolean): void {
    debug = flag;
}

// console.warn for conditions that indicate misuse or a real limitation
// (not a routine trace). Still gated behind `setDebug` so consumers who
// haven't opted in don't see library-internal chatter.
export function devWarn(...args: unknown[]): void {
    if (debug) console.warn(...args);
}

// Get the distance between two jolt vector3s
// jolt-physics >=1.0 declares RVec3 (the "real"/world space vector every position argument takes)
// as its own class. In the single precision builds we use it is the same layout as Vec3 and the
// two are interchangeable at runtime, but the typings are not, so anything that only reads
// components accepts either and anything that feeds a position back into Jolt builds an RVec3.
export type joltVec3 = Jolt.Vec3 | Jolt.RVec3;
export type anyVec3 = joltVec3 | THREE.Vector3 | [number, number, number] | number[];

export type anyQuat = Jolt.Quat | THREE.Quaternion | [number, number, number, number];

/**
 * Ownership rules for everything in this file
 * -------------------------------------------
 * `vec3.jolt()`, `vec3.rjolt()`, `quat.jolt()` (and the `tupleToJolt` / `threeToJolt` /
 * `clone` primitives) ALWAYS return a brand new WASM object that the **caller owns** and must
 * release exactly once with `Raw.module.destroy()` / `free()`. They never hand back the
 * argument, so destroying the result can never free an object Jolt (or the caller) still holds -
 * that aliasing was issue #76 and the source of "random" heap corruption.
 *
 * `vec3.three()` / `quat.three()` never allocate WASM memory and never destroy their input.
 *
 * Two allocation free alternatives exist for hot paths:
 *  - `withJolt(value, fn)` / `withRJolt()` / `withQuat()` - scoped: constructs, calls, destroys.
 *  - `joltScratch.vec3()` / `.rvec3()` / `.quat()` - shared, never destroyed, only valid until the
 *    next call to the same accessor, and only legal for Jolt APIs that copy their argument.
 */

// `!value` swallows 0, which is a perfectly good vector component (issue #76 secondary bug:
// `vec3.jolt(0, 1, 2)` used to return (0, 0, 0)).
const isNil = (value: unknown): value is null | undefined => value === undefined || value === null;

// Read any vector-ish input into plain numbers without allocating a WASM object.
const readVec3 = (vec: anyVec3 | number, y?: number, z?: number): [number, number, number] => {
    if (isNil(vec)) return [0, 0, 0];
    if (typeof vec === 'number') return [vec, y ?? 0, z ?? 0];
    if (Array.isArray(vec)) return [vec[0] ?? 0, vec[1] ?? 0, vec[2] ?? 0];
    if (vec3.isJolt(vec)) return [vec.GetX(), vec.GetY(), vec.GetZ()];
    const v = vec as THREE.Vector3;
    return [v.x, v.y, v.z];
};

const readQuat = (quaternion: anyQuat): [number, number, number, number] => {
    if (isNil(quaternion)) return [0, 0, 0, 1];
    if (Array.isArray(quaternion))
        return [quaternion[0] ?? 0, quaternion[1] ?? 0, quaternion[2] ?? 0, quaternion[3] ?? 1];
    if (quat.isJolt(quaternion))
        return [quaternion.GetX(), quaternion.GetY(), quaternion.GetZ(), quaternion.GetW()];
    const q = quaternion as THREE.Quaternion;
    return [q.x, q.y, q.z, q.w];
};

export const vec3 = {
    /** Allocates. The caller owns the returned `Jolt.Vec3`. */
    tupleToJolt: (tuple: Vector3Tuple): Jolt.Vec3 => new Raw.module.Vec3(...tuple),
    /** Allocates. The caller owns the returned `Jolt.Vec3`. */
    threeToJolt: (vector: THREE.Vector3): Jolt.Vec3 =>
        new Raw.module.Vec3(vector.x, vector.y, vector.z),
    /** Does not allocate WASM memory and never destroys `vec`. */
    joltToThree: (vec: joltVec3, out = new THREE.Vector3()): THREE.Vector3 =>
        out.set(vec.GetX(), vec.GetY(), vec.GetZ()),
    /** Does not allocate WASM memory and never destroys `vec`. */
    joltToTuple: (vec: joltVec3) => [vec.GetX(), vec.GetY(), vec.GetZ()],

    /**
     * Copy a Jolt vector into a **new** Jolt vector the caller owns.
     * Jolt itself has no `clone()`, which is why every helper below goes through components.
     */
    clone: (vec: joltVec3): Jolt.Vec3 => new Raw.module.Vec3(vec.GetX(), vec.GetY(), vec.GetZ()),
    /** Copy any Jolt vector into a **new** `Jolt.RVec3` the caller owns. */
    rclone: (vec: joltVec3): Jolt.RVec3 => new Raw.module.RVec3(vec.GetX(), vec.GetY(), vec.GetZ()),

    // Extensions to simplify this ---
    /**
     * Convert anything vector shaped (three.js vector, tuple, numbers, another Jolt vector) into a
     * `Jolt.Vec3`.
     *
     * **Ownership: the result is always a new object owned by the caller** and must be destroyed
     * exactly once (`Raw.module.destroy(v)` / `free(v)`). A Jolt vector argument is *cloned*, so
     * the argument is never freed on the caller's behalf. Prefer `withJolt()` when the value is
     * scoped, or `joltScratch.vec3()` in per-frame code.
     */
    jolt(vec: anyVec3 | number, y?: number, z?: number): Jolt.Vec3 {
        const [x, vy, vz] = readVec3(vec, y, z);
        return new Raw.module.Vec3(x, vy, vz);
    },
    /**
     * The `RVec3` flavour of `jolt()`, for the world space position arguments of the Jolt API.
     *
     * **Ownership: the result is always a new object owned by the caller** and must be destroyed
     * exactly once. See `jolt()`; `withRJolt()` / `joltScratch.rvec3()` avoid the allocation.
     */
    rjolt(vec: anyVec3 | number, y?: number, z?: number): Jolt.RVec3 {
        const [x, vy, vz] = readVec3(vec, y, z);
        return new Raw.module.RVec3(x, vy, vz);
    },
    /**
     * Convert anything vector shaped into a `THREE.Vector3`.
     *
     * Allocates no WASM memory and never destroys the input. A `THREE.Vector3` argument is passed
     * through unchanged (use `out` or `.clone()` if you intend to retain the value).
     */
    three(vec: anyVec3 | number, y?: number, z?: number, out?: THREE.Vector3): THREE.Vector3 {
        if (isNil(vec)) return (out ?? new THREE.Vector3()).set(0, 0, 0);
        if (typeof vec === 'number') return (out ?? new THREE.Vector3()).set(vec, y ?? 0, z ?? 0);
        if (Array.isArray(vec))
            return (out ?? new THREE.Vector3()).set(vec[0] ?? 0, vec[1] ?? 0, vec[2] ?? 0);
        if (vec3.isJolt(vec)) return vec3.joltToThree(vec, out);
        const v = vec as THREE.Vector3;
        return out ? out.copy(v) : v;
    },

    joltDistanceTo: (a: joltVec3, b: joltVec3): number => {
        const dx = b.GetX() - a.GetX();
        const dy = b.GetY() - a.GetY();
        const dz = b.GetZ() - a.GetZ();
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    },
    // @ts-ignore detect if vec3 is jolt
    isJolt: (vec: anyVec3): vec is joltVec3 => !isNil(vec) && vec.GetX !== undefined,
    //@ts-ignore detect if vec3 is three
    isThree: (vec: anyVec3): vec is THREE.Vector3 => !isNil(vec) && vec.x !== undefined,
    //copy the value of a second vec3 onto the first
    joltCopy: (a: joltVec3, b: anyVec3) => {
        const [x, y, z] = readVec3(b);
        a.Set(x, y, z);
    },
    threeCopy: (a: THREE.Vector3, b: anyVec3) => {
        const [x, y, z] = readVec3(b);
        a.set(x, y, z);
    },
    // whatever type A is correctly copy the value of B onto it
    copy(a: anyVec3, b: anyVec3) {
        if (vec3.isJolt(a)) vec3.joltCopy(a, b);
        //@ts-ignore
        else vec3.threeCopy(a, b);
    }
};

export const quat = {
    /** Allocates. The caller owns the returned `Jolt.Quat`. */
    //@ts-ignore stupid tuple type
    tupleToJolt: (tuple: Vector4Tuple): Jolt.Quat => new Raw.module.Quat(...tuple),
    /** Allocates. The caller owns the returned `Jolt.Quat`. */
    threeToJolt: (quaternion: THREE.Quaternion): Jolt.Quat =>
        new Raw.module.Quat(quaternion.x, quaternion.y, quaternion.z, quaternion.w),
    /** Does not allocate WASM memory and never destroys `quat`. */
    joltToThree: (quat: Jolt.Quat, out = new THREE.Quaternion()) =>
        out.set(quat.GetX(), quat.GetY(), quat.GetZ(), quat.GetW()),
    /** Does not allocate WASM memory and never destroys `quat`. */
    joltToTuple: (quat: Jolt.Quat) => [quat.GetX(), quat.GetY(), quat.GetZ(), quat.GetW()],

    /** Copy a Jolt quaternion into a **new** Jolt quaternion the caller owns. */
    clone: (quaternion: Jolt.Quat): Jolt.Quat =>
        new Raw.module.Quat(
            quaternion.GetX(),
            quaternion.GetY(),
            quaternion.GetZ(),
            quaternion.GetW()
        ),

    isThree: (quaternion: anyQuat): quaternion is THREE.Quaternion =>
        //@ts-ignore
        !isNil(quaternion) && quaternion.x !== undefined,
    isJolt: (quaternion: anyQuat): quaternion is Jolt.Quat =>
        //@ts-ignore
        !isNil(quaternion) && quaternion.GetX !== undefined,
    /**
     * Convert anything quaternion shaped into a `Jolt.Quat`.
     *
     * **Ownership: the result is always a new object owned by the caller** and must be destroyed
     * exactly once. A Jolt quaternion argument is cloned, never returned; `undefined`/`null`
     * yields the identity rotation instead of throwing. `withQuat()` / `joltScratch.quat()`
     * avoid the allocation.
     */
    jolt(quaternion: anyQuat): Jolt.Quat {
        const [x, y, z, w] = readQuat(quaternion);
        return new Raw.module.Quat(x, y, z, w);
    },
    /**
     * Convert anything quaternion shaped into a `THREE.Quaternion`.
     *
     * Allocates no WASM memory and never destroys the input. A `THREE.Quaternion` argument is
     * passed through unchanged unless an `out` target is given.
     */
    three(quaternion: anyQuat, out?: THREE.Quaternion): THREE.Quaternion {
        if (isNil(quaternion)) return (out ?? new THREE.Quaternion()).set(0, 0, 0, 1);
        if (Array.isArray(quaternion)) {
            const [x, y, z, w] = readQuat(quaternion);
            return (out ?? new THREE.Quaternion()).set(x, y, z, w);
        }
        if (quat.isJolt(quaternion)) return quat.joltToThree(quaternion, out);
        const q = quaternion as THREE.Quaternion;
        return out ? out.copy(q) : q;
    }
};

//* Scoped helpers =========================================================================
// For the common "build a Jolt value, hand it to one call, throw it away" shape. The object is
// destroyed even if `fn` throws, and it is impossible to leak or double free it by accident.

/** Run `fn` with a temporary `Jolt.Vec3` built from `value`, destroying it afterwards. */
export function withJolt<T>(value: anyVec3 | number, fn: (v: Jolt.Vec3) => T): T {
    const v = vec3.jolt(value);
    try {
        return fn(v);
    } finally {
        Raw.module.destroy(v);
    }
}

/** Run `fn` with a temporary `Jolt.RVec3` built from `value`, destroying it afterwards. */
export function withRJolt<T>(value: anyVec3 | number, fn: (v: Jolt.RVec3) => T): T {
    const v = vec3.rjolt(value);
    try {
        return fn(v);
    } finally {
        Raw.module.destroy(v);
    }
}

/** Run `fn` with a temporary `Jolt.Quat` built from `value`, destroying it afterwards. */
export function withQuat<T>(value: anyQuat, fn: (q: Jolt.Quat) => T): T {
    const q = quat.jolt(value);
    try {
        return fn(q);
    } finally {
        Raw.module.destroy(q);
    }
}

//* Shared scratch objects =================================================================
// Allocating a WASM object per frame per body is the single biggest source of churn in this
// library. Every Jolt entry point we hand these to takes its argument by value (Vec3Arg /
// RVec3Arg / QuatArg) and copies it - verified against the jolt-physics 1.1.0 typings and at
// runtime - so one shared instance per flavour is enough.
//
// RULES for anything using `joltScratch`:
//  - never call `destroy()` on the result,
//  - never store the result; it is only valid until the next call to the same accessor,
//  - never pass it to an API that keeps a pointer to its argument (anything taking a `Vec3 *`,
//    or a settings object that stores a reference rather than a copy). When in doubt allocate
//    with `vec3.jolt()` / `withJolt()` instead.

let scratchModule: unknown = null;
let scratchVec3: Jolt.Vec3 | null = null;
let scratchRVec3: Jolt.RVec3 | null = null;
let scratchQuat: Jolt.Quat | null = null;

// `initJolt()` can swap the module (tests do exactly that), which would leave the scratch objects
// pointing into a heap nobody owns any more.
const ensureScratchModule = () => {
    if (scratchModule === Raw.module) return;
    scratchModule = Raw.module;
    scratchVec3 = null;
    scratchRVec3 = null;
    scratchQuat = null;
};

export const joltScratch = {
    /** Shared `Jolt.Vec3`. Never destroy it, never retain it. */
    vec3(vec: anyVec3 | number, y?: number, z?: number): Jolt.Vec3 {
        ensureScratchModule();
        if (!scratchVec3) scratchVec3 = new Raw.module.Vec3(0, 0, 0);
        const [x, vy, vz] = readVec3(vec, y, z);
        scratchVec3.Set(x, vy, vz);
        return scratchVec3;
    },
    /** Shared `Jolt.RVec3`. Never destroy it, never retain it. */
    rvec3(vec: anyVec3 | number, y?: number, z?: number): Jolt.RVec3 {
        ensureScratchModule();
        if (!scratchRVec3) scratchRVec3 = new Raw.module.RVec3(0, 0, 0);
        const [x, vy, vz] = readVec3(vec, y, z);
        scratchRVec3.Set(x, vy, vz);
        return scratchRVec3;
    },
    /** Shared `Jolt.Quat`. Never destroy it, never retain it. */
    quat(quaternion: anyQuat): Jolt.Quat {
        ensureScratchModule();
        if (!scratchQuat) scratchQuat = new Raw.module.Quat(0, 0, 0, 1);
        const [x, y, z, w] = readQuat(quaternion);
        scratchQuat.Set(x, y, z, w);
        return scratchQuat;
    },
    /**
     * Release the shared objects. Only needed when tearing the Jolt module down (tests, HMR);
     * the next accessor call rebuilds them.
     */
    release() {
        if (scratchModule === Raw.module) {
            if (scratchVec3) Raw.module.destroy(scratchVec3);
            if (scratchRVec3) Raw.module.destroy(scratchRVec3);
            if (scratchQuat) Raw.module.destroy(scratchQuat);
        }
        scratchModule = null;
        scratchVec3 = null;
        scratchRVec3 = null;
        scratchQuat = null;
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

/**
 * Build the world space transform Jolt's narrow phase queries want.
 *
 * World space transforms are `RMat44` / `RVec3` in jolt-physics >=1.0; both the `CollideShape`
 * transform and `RShapeCast.mCenterOfMassStart` want that flavour.
 *
 * **Ownership: the returned `RMat44` is a new object owned by the caller** and must be destroyed
 * exactly once.
 *
 * Note that jolt-physics is built with emscripten's WebIDL binder, whose "by value" returns are
 * pointers to a single **static temporary per function** - `Jolt.RMat44.prototype
 * .sRotationTranslation()` hands back the same address on every call, the previous result is
 * overwritten, and destroying it frees memory the binder owns. So the result is copied into a
 * real `RMat44` here; the position/rotation inputs are shared scratch objects, so the copy is the
 * only allocation this makes however often it is called (it runs per frame from the shapecaster
 * and the shape collider).
 */
export function generateJoltMatrix(
    inPosition: anyVec3,
    inRotation: anyQuat,
    _inScale?: anyVec3
): Jolt.RMat44 {
    const position = joltScratch.rvec3(inPosition);
    const rotation = joltScratch.quat(inRotation);
    const matrix = new Raw.module.RMat44();
    // SetRotation writes the three basis columns, SetTranslation the fourth - together they cover
    // every component of the (uninitialised) matrix we just made.
    matrix.SetRotation(Raw.module.Mat44.prototype.sRotation(rotation));
    matrix.SetTranslation(position);
    return matrix;
}
