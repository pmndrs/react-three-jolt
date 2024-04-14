import { ThreeElements } from '@react-three/fiber';
import { RigidBody, Vector3Tuple } from '@react-three/jolt';
import React from 'react';

export type FloorProps = {
    size?: number;
    position?: Vector3Tuple;
    rotation?: Vector3Tuple;
    children?: React.ReactNode;
} & ThreeElements['mesh'];

export const Floor = (props: FloorProps) => {
    const { size = 20, position = [0, 0, 0], rotation = [0, 0, 0], ...rest } = props;

    return (
        <RigidBody position={position} rotation={rotation} type="static">
            <mesh receiveShadow scale-y={1} {...rest}>
                <boxGeometry args={[size, 0.5, size]} />
            </mesh>
        </RigidBody>
    );
};
