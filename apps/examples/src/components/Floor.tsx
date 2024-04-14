import { RigidBody } from '@react-three/jolt';
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
            <mesh receiveShadow scale-y={1} material={material} {...rest}>
                <boxGeometry args={[size, 0.5, size]} />
            </mesh>
        </RigidBody>
    );
};
