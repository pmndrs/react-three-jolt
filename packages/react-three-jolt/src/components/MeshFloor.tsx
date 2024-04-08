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
import { createMeshFloor, createMeshFromShape } from '../utils/meshTools';
import { useEffect, useRef } from 'react';
import { useJolt } from '../hooks';
import * as THREE from 'three';
import React from 'react';

export const MeshFloor = ({ size = 20, position = [0, 0, 0], ...rest }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const { bodySystem } = useJolt();

    useEffect(() => {
        // generate the jolt body
        const floorBodySettings = createMeshFloor(30, 1, 4, 0, 5, 0);
        const rawBody = bodySystem.bodyInterface.CreateBody(floorBodySettings);
        //now we can make a mesh using the body with the helper
        const floorMesh = createMeshFromShape(rawBody.GetShape());
        if (meshRef.current) {
            meshRef.current.geometry = floorMesh;
            // push the body onto the system
            bodySystem.addExistingBody(meshRef.current, rawBody, {
                bodyType: 'static'
            });
        }
    }, []);

    return (
        <mesh ref={meshRef} position-y={0.1} {...rest}>
            <boxGeometry args={[size, 0.5, size]} />
            <meshStandardMaterial color="grey" />
        </mesh>
    );
};
