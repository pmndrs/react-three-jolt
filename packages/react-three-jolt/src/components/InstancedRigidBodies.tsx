import React, {
    ReactNode,
    RefObject,
    forwardRef,
    memo,
    useEffect,
    useImperativeHandle,
    useRef,
    useState
} from 'react';
import * as THREE from 'three';
import { RigidBody, type RigidBodyProps } from './RigidBody';
import type { BodyState } from '../systems';
import { isInstancedMesh } from '../utils';

export type InstancedRigidBodyProps = RigidBodyProps;

type InstancedRigidBodiesProps = RigidBodyProps & {
    ref: RefObject<BodyState[]>;
    children: ReactNode;
    instances: InstancedRigidBodyProps[];
    shapeNodes?: ReactNode;
};

export const InstancedRigidBodies: React.FC<InstancedRigidBodiesProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            // instanced props
            children,
            instances,
            shapeNodes = [],

            // wrapper object props
            position,
            rotation,
            quaternion,
            scale,

            // rigid body specific props, and r3f-object props
            ...rigidBodyProps
        } = props;

        const groupRef = useRef<THREE.Group>(null!);
        const instanceWrapperRef = useRef<THREE.Object3D>(null!);

        const [instancedMesh, setInstancedMesh] = useState<THREE.InstancedMesh | null>(null);

        const instanceStates = useRef<BodyState[]>([]);

        useImperativeHandle(forwardedRef, () => instanceStates.current);

        useEffect(() => {
            const instancedMesh = instanceWrapperRef.current!.children[0];

            if (!instancedMesh || !isInstancedMesh(instancedMesh)) {
                console.warn(
                    '<InstancedRigidBodies /> expects an <instancedMesh /> as its first child'
                );

                return;
            }

            instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

            setInstancedMesh(instancedMesh as THREE.InstancedMesh);

            return () => {
                setInstancedMesh(null);
            };
        }, []);

        return (
            <>
                <group
                    {...rigidBodyProps}
                    position={position}
                    quaternion={quaternion}
                    rotation={rotation}
                    scale={scale}
                    ref={groupRef}>
                    <object3D ref={instanceWrapperRef}>{children}</object3D>

                    {instancedMesh &&
                        instances.map((instance, index) => (
                            <RigidBody
                                {...rigidBodyProps}
                                {...instance}
                                ref={(ref) => {
                                    instanceStates.current[index] = ref!;
                                }}
                                instancedMesh={{
                                    instancedMesh,
                                    index
                                }}>
                                {shapeNodes}
                            </RigidBody>
                        ))}
                </group>
            </>
        );
    })
);

/* this is a snippet of something I made in response to a rapier question
we might want it here too
const createRapierInstanceArray(instanceMatrix: THREE.instanceMatrix)  {
    const tempInstancedMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({color: 0xff0000}), instanceMatrix.count);
    tempInstancedMesh.instanceMatrix = instanceMatrix;
    const tempMatrix = new THREE.Matrix4();
    const tempPosition = new THREE.Vector3();
    const tempQuaternion = new THREE.Quaternion();
    const tempScale = new THREE.Vector3();
    const tempRotation = new THREE.Euler();
    const instances = [];
    for (let i = 0; i < tempInstancedMesh.count; i++) {
        tempInstancedMesh.getMatrixAt(i, tempMatrix);
        tempMatrix.decompose(tempPosition, tempQuaternion, tempScale);
        tempRotation.setFromQuaternion(tempQuaternion);
        instances.push({key: instance+ i, position: tempPosition, rotation: tempRotation.array, scale: tempScale});
    }
    
    return instances;
}
*/
