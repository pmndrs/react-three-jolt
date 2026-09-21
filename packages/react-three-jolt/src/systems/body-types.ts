// Shared surface between body-system.ts and body-state.ts (issue #165).
//
// The two files used to import runtime values from each other - body-system.ts constructs
// `new BodyState(...)` (a genuine runtime edge that has to stay: creating a body's state is
// BodySystem's job), while body-state.ts imported `getThreeObjectForBody` from body-system.ts
// just because that's where it happened to live, even though it doesn't touch anything on
// `BodySystem`. That second import was the type-only half of the cycle in disguise - a value
// import that had nothing to do with either class - and rollup flagged the resulting cycle on
// every build. `BodyType` and `GenerateBodyOptions` live here too so both files (and anything
// importing them, like `RigidBody.tsx`) can reach them without going through either class file.
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { castObject, Raw } from '../raw';
import { quat, vec3 } from '../utils';
import {
    type AutoShape,
    createMeshForShape,
    type DynamicMeshStrategy,
    type ShapeDescriptor
} from './shape-system';

export type BodyType = 'dynamic' | 'static' | 'kinematic' | 'rig';

// We call things "bodySettings" to clarify from shapes or other similar labels
export interface GenerateBodyOptions {
    bodyType?: 'dynamic' | 'static' | 'kinematic' | 'rig';
    bodySettings?: Jolt.BodyCreationSettings;
    motionType?: 'static' | 'kinematic' | 'dynamic';
    index?: number;
    shapeType?: AutoShape;
    activation?: 'activate' | 'deactivate';
    jitter?: THREE.Vector3;
    mass?: number;
    /** @deprecated only used by the old dynamic-trimesh mass fallback; the shape's own mass properties are used now (#112) */
    size?: THREE.Vector3;
    group?: number;
    subGroup?: number;
    shape?: Jolt.Shape;
    /**
     * The description `shape` was built from. Stored on the `BodyState` so a contact's
     * `SubShapeID` can be traced back to the descriptor child that produced it (issue #13).
     * The `describeObject` path fills this in by itself; pass it when you hand over a
     * ready made `shape`.
     */
    shapeDescriptor?: ShapeDescriptor;
    /**
     * What to do with a trimesh shape on a **dynamic** body (issue #112). Jolt cannot simulate
     * one: mesh vs mesh has no collision, so the body falls through the world and ends up with a
     * NaN position.
     *
     * - `'convex'` (default): warn and use a convex hull of the same points instead.
     * - `'error'`: throw, so the mistake is loud.
     * - `'decompose'`: reserved for a convex decomposition; currently throws with an explanation.
     */
    dynamicMeshStrategy?: DynamicMeshStrategy;
}

// When debugging we need to create a three debug object
// initially pulled from Jolt Demo,
export function getThreeObjectForBody(body: Jolt.Body, color = '#E07A5F') {
    let shape = body.GetShape();
    // lets see if we can get the material color by the shape
    // TODO this isn't in Jolt.js yet.

    //const physicsMaterial: Jolt.PhysicsMaterial = shape.GetMaterial();
    //const pmColor = physicsMaterial.GetDebugColor();
    const material = new THREE.MeshPhongMaterial({
        color: color,
        wireframe: true
    });

    let threeObject: THREE.Mesh;

    // Each branch downcasts into its own local instead of writing the subclass back over
    // `shape` (which stays typed as the base `Jolt.Shape`, which is what made every accessor
    // below need a suppression). `castObject` re-wraps the same pointer, so these are views -
    // nothing to free, and `shape` itself still refers to the same object afterwards.
    let extent: THREE.Vector3;
    switch (shape.GetSubType()) {
        case Raw.module.EShapeSubType_Box: {
            const box = castObject(shape, Raw.module.BoxShape);
            extent = vec3.three(box.GetHalfExtent()).multiplyScalar(2);
            threeObject = new THREE.Mesh(
                new THREE.BoxGeometry(extent.x, extent.y, extent.z, 1, 1, 1),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Sphere: {
            const sphere = castObject(shape, Raw.module.SphereShape);
            threeObject = new THREE.Mesh(
                new THREE.SphereGeometry(sphere.GetRadius(), 32, 32),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Capsule: {
            const capsule = castObject(shape, Raw.module.CapsuleShape);
            threeObject = new THREE.Mesh(
                new THREE.CapsuleGeometry(
                    capsule.GetRadius(),
                    2 * capsule.GetHalfHeightOfCylinder(),
                    20,
                    10
                ),
                material
            );
            break;
        }
        case Raw.module.EShapeSubType_Cylinder: {
            const cylinder = castObject(shape, Raw.module.CylinderShape);
            threeObject = new THREE.Mesh(
                new THREE.CylinderGeometry(
                    cylinder.GetRadius(),
                    cylinder.GetRadius(),
                    2 * cylinder.GetHalfHeight(),
                    20,
                    1
                ),
                material
            );
            break;
        }
        default:
            threeObject = new THREE.Mesh(createMeshForShape(shape), material);
            break;
    }
    // todo: these may not be needed. When used to create a debug shape this is actually wrong
    threeObject.position.copy(vec3.three(body.GetPosition()));
    threeObject.quaternion.copy(quat.joltToThree(body.GetRotation()));

    return threeObject;
}
