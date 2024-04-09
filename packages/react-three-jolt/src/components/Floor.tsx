// Floor component for jolt. it's essentially just a box
import React from 'react';
import { RigidBody } from './RigidBody';
//import { useEffect } from 'react';
import * as THREE from 'three';

export const Floor = (props: any) => {
    const {
        size = 20,
        position = [0, 0, 0],
        rotation = [0, 0, 0],
        material = new THREE.MeshStandardMaterial(),
        ...rest
    } = props;

    return (
        <RigidBody position={position} rotation={rotation} type="static">
            <mesh scale-y={1} material={material} {...rest}>
                <boxGeometry args={[size, 0.5, size]} />
            </mesh>
        </RigidBody>
    );
};
