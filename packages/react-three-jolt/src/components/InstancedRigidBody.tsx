// creates a rigid body for each instance in a mesh
// changing count at all will regenerate everything
//todo cleanup these general imports
// ridged body wrapping and mesh components

import { useThree } from '@react-three/fiber';
import React, {
    forwardRef,
    memo,
    ReactNode,
    // MutableRefObject,
    //RefObject,
    useEffect,
    useRef
} from 'react';
import * as THREE from 'three';
import { BodyState } from '../';
import { useEventCallback, useForwardedRef, useJolt, useUnmount } from '../hooks';
import type { BodyEventMap } from '../systems/events';

interface InstancedRigidBodyMeshProps {
    children: ReactNode;
    count: number;
    ref: any;
    color: string | THREE.Color;
    position: any;
    rotation: any;

    //* Events -------------------------------------------
    // Same names and payloads as `<RigidBody>`; the payload's `target.index` says which
    // instance it was. Subscribed on every instance body, re-subscribed when `count` changes.
    onCollisionEnter?: BodyEventMap['collisionEnter'];
    onCollisionPersist?: BodyEventMap['collisionPersist'];
    onCollisionExit?: BodyEventMap['collisionExit'];
    onSensorEnter?: BodyEventMap['sensorEnter'];
    onSensorExit?: BodyEventMap['sensorExit'];
    onIntersectionEnter?: BodyEventMap['sensorEnter'];
    onIntersectionExit?: BodyEventMap['sensorExit'];
    onSleep?: BodyEventMap['sleep'];
    onWake?: BodyEventMap['wake'];
}
export const InstancedRigidBodyMesh: React.FC<InstancedRigidBodyMeshProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,
            count = 150,
            color = '#D9594C',
            position,
            rotation,
            onCollisionEnter,
            onCollisionPersist,
            onCollisionExit,
            onSensorEnter,
            onSensorExit,
            onIntersectionEnter,
            onIntersectionExit,
            onSleep,
            onWake
        } = props;
        // I put one in the ref to appease typescript
        const holderMeshRef = useRef<THREE.Mesh>(new THREE.Mesh());
        const instancedMeshRef: any = useRef(undefined);
        const parentRef = useRef<THREE.Object3D>(null);
        // Jolt body to be replicated for the instances
        //@ts-ignore
        const instanceStates = useForwardedRef(forwardedRef);
        //@ts-ignore
        const { scene } = useThree();
        const { bodySystem } = useJolt();

        //remove and process the mesh only on initial load
        useEffect(() => {
            if (holderMeshRef.current) {
                const mesh: THREE.Mesh = holderMeshRef.current;
                //@ts-ignore
                parentRef.current = mesh.parent;
                // reomve the mesh from the scene
                if (parentRef?.current) parentRef.current.remove(mesh);
            }
        }, [holderMeshRef]);

        //* Generation of InstancedMesh -------------------------------------
        // When the count changes, we need to rebuid the instancedMesh
        useEffect(() => {
            //if there is an existing instancedMesh, remove it
            let current;
            if (instancedMeshRef.current) {
                instancedMeshRef.current.parent.remove(instancedMeshRef.current);
                current = instancedMeshRef.current;
            }
            // todo: do we need to do more to properly dispose of it?
            const holder: THREE.Mesh = holderMeshRef.current;
            const geometry = holder!.geometry || new THREE.BoxGeometry(1, 1, 1);
            const material = holder!.material || new THREE.MeshBasicMaterial({ color: color });
            const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
            instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            // loop over and set the inital colors
            const _col = new THREE.Color(color);
            for (let i = 0; i < count; i++) {
                instancedMesh.setColorAt(i, _col);
            }
            instancedMesh.instanceColor!.needsUpdate = true;
            //take the current mesh positions and values and copy it onto the new one
            const _matrix = new THREE.Matrix4();
            const _color = new THREE.Color();
            if (current) {
                for (let i = 0; i < current.count; i++) {
                    current.getMatrixAt(i, _matrix);
                    instancedMesh.setMatrixAt(i, _matrix);
                    if (instancedMesh.instanceColor) {
                        current.getColorAt(i, _color);
                        instancedMesh.setColorAt(i, _color);
                    }
                }
                instancedMesh.instanceMatrix.needsUpdate = true;
                if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
            }

            instancedMeshRef.current = instancedMesh;
            // add back to the scene
            if (parentRef?.current) parentRef.current!.add(instancedMesh);
            manageInstances(count);
        }, [count]);
        const createInstanceBody = (index: number) => {
            // create a new body for the instance
            const body = bodySystem.createBody(holderMeshRef.current!, {
                jitter: new THREE.Vector3(1, 0.1, 1)
            });
            // add the body to the physics system
            const handle = bodySystem.addExistingBody(instancedMeshRef.current, body, {
                index: index
            });
            const state = bodySystem.getBody(handle);
            return state;
        };

        const manageInstances = (count: number) => {
            // check if instances already exists
            //@ts-ignore
            let instances: BodyState[] = instanceStates.current || [];
            // all of the current instances need to get their instanceMesh updated

            instances.forEach((instance) => {
                instance.object = instancedMeshRef.current;
            });

            // if the count is less than the current instances, remove the extras
            if (instances.length > count) {
                // split the array and get an array of extras to be deleted
                const extras = instances.slice(count);
                instances = instances.slice(0, count);
                // remove the extras
                extras.forEach((instance) => instance.destroy());
            } else if (count > instances.length) {
                // if the count is greater than the current instances, add the extras
                for (let i = instances.length; i < count; i++) {
                    //@ts-ignore
                    instances.push(createInstanceBody(i));
                }
            }
            // update the instance states
            instanceStates.current = instances;
        };
        //* Events -------------------------------------------
        // Runs after the effect above, so the instance bodies exist. One subscription per
        // instance body, all dropped together when `count` changes or the mesh unmounts. The
        // payload's `target.index` says which instance it was.
        const enter = useEventCallback(onCollisionEnter);
        const persist = useEventCallback(onCollisionPersist);
        const exit = useEventCallback(onCollisionExit);
        const sensorEnter = useEventCallback(onSensorEnter ?? onIntersectionEnter);
        const sensorExit = useEventCallback(onSensorExit ?? onIntersectionExit);
        const sleep = useEventCallback(onSleep);
        const wake = useEventCallback(onWake);
        // which handlers are present, as a value - so an inline arrow does not resubscribe
        const subscribed = [
            onCollisionEnter,
            onCollisionPersist,
            onCollisionExit,
            onSensorEnter ?? onIntersectionEnter,
            onSensorExit ?? onIntersectionExit,
            onSleep,
            onWake
        ]
            .map((handler) => (handler ? 1 : 0))
            .join('');
        useEffect(() => {
            const instances = (instanceStates.current || []) as BodyState[];
            if (!instances.length) return;
            const pairs: [keyof BodyEventMap, unknown][] = [
                ['collisionEnter', onCollisionEnter && enter],
                ['collisionPersist', onCollisionPersist && persist],
                ['collisionExit', onCollisionExit && exit],
                ['sensorEnter', (onSensorEnter ?? onIntersectionEnter) && sensorEnter],
                ['sensorExit', (onSensorExit ?? onIntersectionExit) && sensorExit],
                ['sleep', onSleep && sleep],
                ['wake', onWake && wake]
            ];
            const offs: (() => void)[] = [];
            for (const [type, callback] of pairs) {
                if (!callback) continue;
                for (const instance of instances) offs.push(instance.on(type, callback as never));
            }
            return () => {
                for (const off of offs) off();
            };
            // biome-ignore lint/correctness/useExhaustiveDependencies: `subscribed` stands in for which handlers are present, `count` for the instance set
        }, [count, subscribed]);

        // cleanup
        useUnmount(() => {
            // remove the instancedMesh from the scene
            if (instancedMeshRef.current) {
                instancedMeshRef.current.parent.remove(instancedMeshRef.current);
            }
            // remove the instances from the physics system
            const instances: any = instanceStates.current || [];
            instances.forEach((instance: BodyState) => {
                instance.destroy();
            });
        });

        return (
            <>
                <mesh position={position} rotation={rotation} ref={holderMeshRef}>
                    {children}
                </mesh>
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
