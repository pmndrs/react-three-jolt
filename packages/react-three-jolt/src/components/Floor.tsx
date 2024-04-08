// Floor component for jolt. it's essentially just a box
import React from 'react';
import { RigidBody } from './RidgedBody';

export const Floor = ({ size = 20, position = [0, 0, 0], rotation = [0, 0, 0], ...rest }) => {
    return (
        <RigidBody position={position} rotation={rotation} type="static">
            <mesh scale-y={1} {...rest}>
                <boxGeometry args={[size, 0.5, size]} />
                <meshStandardMaterial color="white" />
            </mesh>
        </RigidBody>
    );
};
