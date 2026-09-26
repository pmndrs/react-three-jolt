import type { ThreeElements } from '@react-three/fiber';
// React stays a *value* import: this package compiles JSX with the classic runtime, so the
// emitted `React.createElement` calls need it at runtime (biome's useImportType will offer to
// make it `import type` - don't).
import React from 'react';
import { RigidBody, type Vector3Tuple } from '../../index';

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
