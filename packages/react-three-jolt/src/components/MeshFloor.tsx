// MeshFloor for Jolt
/* NOTE this WILL NOT work well with a worker version 
this script creates and uses a JOLT Body and passes it to the
physics system. In a worker the system will be in isolation and 
it's unclear if a body is a transferable object.
EXPECT this to fail in a worker. 
However, it is a good example of how to create/use jolt directly so I'm using it
if You really wanted a body like this, probably use the heigtfield instead
*/
//import { RigidBody } from './RidgedBody';

import type { ThreeElements } from '@react-three/fiber';
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useJolt } from '../hooks';
import { Raw } from '../raw';
import { createMeshFloor, createMeshFromShape } from '../utils/mesh-tools';

/**
 * `<MeshFloor>`'s own props. Everything else (`Omit`'d below) is a `<mesh>` prop, spread
 * straight through - issue #148 gave this a real interface instead of an untyped destructure.
 */
export interface MeshFloorProps extends Omit<ThreeElements['mesh'], 'ref'> {
    /** Width/depth of the visual floor mesh. The generated Jolt body's own size is fixed. */
    size?: number;
}

export function MeshFloor({ size = 20, ...rest }: MeshFloorProps) {
    const meshRef = useRef<THREE.Mesh>(null);
    const { bodySystem } = useJolt();

    useEffect(() => {
        // generate the jolt body
        const floorBodySettings = createMeshFloor(30, 1, 4, 0, 5, 0);
        const rawBody = bodySystem.bodyInterface.CreateBody(floorBodySettings);
        // the body holds its own reference to the shape now; the settings are ours to free
        Raw.module.destroy(floorBodySettings);
        //now we can make a mesh using the body with the helper
        const floorMesh = createMeshFromShape(rawBody.GetShape());
        if (!meshRef.current) return;
        meshRef.current.geometry = floorMesh;
        // push the body onto the system
        const handle = bodySystem.addExistingBody(meshRef.current, rawBody, {
            bodyType: 'static'
        });
        // #148: this body was never removed on unmount, so it (and its shape) outlived the
        // component for the life of the world.
        return () => {
            bodySystem.removeBody(handle);
        };
    }, [bodySystem]);

    return (
        <mesh ref={meshRef} position-y={0.1} {...rest}>
            <boxGeometry args={[size, 0.5, size]} />
            <meshStandardMaterial color="grey" />
        </mesh>
    );
}
