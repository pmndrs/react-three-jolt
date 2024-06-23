import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';

import { quat, vec3 } from '../utils';
import { createMeshForShape } from './shape-system';

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

    let threeObject;

    let extent;
    switch (shape.GetSubType()) {
        case Raw.module.EShapeSubType_Box:
            shape = Raw.module.castObject(shape, Raw.module.BoxShape);
            //@ts-ignore
            extent = vec3.three(shape.GetHalfExtent()).multiplyScalar(2);
            threeObject = new THREE.Mesh(
                new THREE.BoxGeometry(extent.x, extent.y, extent.z, 1, 1, 1),
                material
            );
            break;
        case Raw.module.EShapeSubType_Sphere:
            shape = Raw.module.castObject(shape, Raw.module.SphereShape);
            threeObject = new THREE.Mesh(
                //@ts-ignore
                new THREE.SphereGeometry(shape.GetRadius(), 32, 32),
                material
            );
            break;
        case Raw.module.EShapeSubType_Capsule:
            shape = Raw.module.castObject(shape, Raw.module.CapsuleShape);
            threeObject = new THREE.Mesh(
                new THREE.CapsuleGeometry(
                    //@ts-ignore
                    shape.GetRadius(),
                    //@ts-ignore
                    2 * shape.GetHalfHeightOfCylinder(),
                    20,
                    10
                ),
                material
            );
            break;
        case Raw.module.EShapeSubType_Cylinder:
            shape = Raw.module.castObject(shape, Raw.module.CylinderShape);
            threeObject = new THREE.Mesh(
                new THREE.CylinderGeometry(
                    //@ts-ignore
                    shape.GetRadius(),
                    //@ts-ignore
                    shape.GetRadius(),
                    //@ts-ignore
                    2 * shape.GetHalfHeight(),
                    20,
                    1
                ),
                material
            );
            break;
        default:
            threeObject = new THREE.Mesh(createMeshForShape(shape), material);
            break;
    }
    // todo: these may not be needed. When used to create a debug shape this is actually wrong
    threeObject.position.copy(vec3.three(body.GetPosition()));
    threeObject.quaternion.copy(quat.joltToThree(body.GetRotation()));

    return threeObject;
}
