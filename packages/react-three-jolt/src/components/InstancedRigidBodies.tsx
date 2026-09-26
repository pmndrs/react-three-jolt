// creates a rigid body for each instance in a mesh
// changing count at all will regenerate everything
// ridged body wrapping and mesh components

import { useThree } from '@react-three/fiber';
import React, { Children, memo, ReactNode, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { BodyState } from '../';
import { useEventCallback, useForwardedRef, useJolt } from '../hooks';
import type { BodyEventMap } from '../systems/events';

export interface InstancedRigidBodiesProps {
    children?: ReactNode;
    count?: number;
    ref?: React.Ref<BodyState[]>;
    color?: THREE.ColorRepresentation;
    position?: THREE.Vector3 | [number, number, number];
    rotation?: THREE.Euler | [number, number, number];

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

// Disposes an InstancedMesh that's being discarded: it's a plain object (not part of the
// three-fiber tree), so nothing else releases its own instanceMatrix/instanceColor GPU buffers.
const destroyInstancedMesh = (mesh: THREE.InstancedMesh) => {
    mesh.parent?.remove(mesh);
    mesh.dispose();
    // drop the reference to the (now GPU-released) color buffer
    mesh.instanceColor = null;
};

// React 19 native convention (#49): `ref` was already a plain prop here (no `forwardRef` to
// remove); this just drops the `React.FC` annotation to match the rest of the components.
export const InstancedRigidBodies = memo(function InstancedRigidBodies({
    children,
    count = 150,
    color = '#D9594C',
    position,
    rotation,
    ref,
    onCollisionEnter,
    onCollisionPersist,
    onCollisionExit,
    onSensorEnter,
    onSensorExit,
    onIntersectionEnter,
    onIntersectionExit,
    onSleep,
    onWake
}: InstancedRigidBodiesProps) {
    // the "template" mesh, used only to read geometry/material off of - it's detached from
    // the scene graph as soon as it mounts and never actually renders.
    const holderMeshRef = useRef<THREE.Mesh | null>(null);
    const instancedMeshRef = useRef<THREE.InstancedMesh | null>(null);
    const parentRef = useRef<THREE.Object3D | null>(null);
    // Geometry/material InstancedRigidBodies created itself, because no geometry/material
    // children were passed. These are the only resources we ever dispose - anything sourced
    // from `children` is owned by three-fiber's own JSX tree (the <mesh> below) and gets
    // disposed by it when this component unmounts.
    const ownedGeometryRef = useRef<THREE.BufferGeometry | null>(null);
    const ownedMaterialRef = useRef<THREE.Material | null>(null);
    // Jolt body states, one per instance - exposed to the caller via `ref`.
    const instanceStates = useForwardedRef<BodyState[]>(ref ?? null, []);
    const { scene } = useThree();
    const { bodySystem } = useJolt();

    // Detach the template mesh from the scene graph on mount, remembering its parent so the
    // real InstancedMesh can be added there instead. Guarded on `parentRef.current` being
    // unset so a StrictMode remount (which re-runs this effect without an intervening
    // cleanup) can't clobber it with `null` a second time - see #24.
    useEffect(() => {
        const mesh = holderMeshRef.current;
        if (!mesh || parentRef.current) return;
        const parent = mesh.parent ?? scene;
        parentRef.current = parent;
        parent?.remove(mesh);
    }, [scene]);

    //* Generation of InstancedMesh -------------------------------------
    // When the count changes, we need to rebuild the instancedMesh
    useEffect(() => {
        const holder = holderMeshRef.current;
        if (!holder) return;
        const previous = instancedMeshRef.current;

        // geometry/material either come from the template mesh (set declaratively via
        // `children`, e.g. <boxGeometry>/<meshStandardMaterial>) or, if none were given, are
        // ours to create - and therefore ours to dispose, later, in `useUnmount`.
        const hasChildren = Children.count(children) > 0;
        let geometry: THREE.BufferGeometry;
        let material: THREE.Material;
        if (hasChildren && holder.geometry) {
            geometry = holder.geometry;
            material = Array.isArray(holder.material) ? holder.material[0] : holder.material;
        } else {
            if (!ownedGeometryRef.current)
                ownedGeometryRef.current = new THREE.BoxGeometry(1, 1, 1);
            if (!ownedMaterialRef.current)
                ownedMaterialRef.current = new THREE.MeshBasicMaterial({ color });
            geometry = ownedGeometryRef.current;
            material = ownedMaterialRef.current;
        }

        const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
        instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // loop over and set the initial colors.
        // `count` may legitimately be 0 (#194: a spawner that starts empty and grows). three
        // only creates `instanceColor` lazily, inside `setColorAt`, so with no instances it
        // stays null - every read of it here and below is guarded for exactly that reason.
        const _col = new THREE.Color(color);
        for (let i = 0; i < count; i++) {
            instancedMesh.setColorAt(i, _col);
        }
        if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
        // take the previous mesh's positions and colors and copy them onto the new one -
        // bounded by the smaller of the two counts, since writing past the new buffer's
        // capacity throws (this used to break shrinking the count, e.g. 20 -> 10).
        if (previous) {
            const _matrix = new THREE.Matrix4();
            const _color = new THREE.Color();
            const copyCount = Math.min(previous.count, count);
            for (let i = 0; i < copyCount; i++) {
                previous.getMatrixAt(i, _matrix);
                instancedMesh.setMatrixAt(i, _matrix);
                if (instancedMesh.instanceColor) {
                    previous.getColorAt(i, _color);
                    instancedMesh.setColorAt(i, _color);
                }
            }
            instancedMesh.instanceMatrix.needsUpdate = true;
            if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
            // the old InstancedMesh owns its own instanceMatrix/instanceColor GPU buffers -
            // release them now that everything relevant has been copied off of it.
            destroyInstancedMesh(previous);
        }

        instancedMeshRef.current = instancedMesh;
        // add back to the scene
        parentRef.current?.add(instancedMesh);
        manageInstances(count);
        // intentionally keyed on `count` alone: `color`/`children` only seed a *new*
        // InstancedMesh's initial state and aren't meant to rebuild it on every change.
    }, [count]);

    const createInstanceBody = (index: number) => {
        // create a new body for the instance
        const body = bodySystem.createBody(holderMeshRef.current!, {
            jitter: new THREE.Vector3(1, 0.1, 1)
        });
        // add the body to the physics system
        const handle = bodySystem.addExistingBody(instancedMeshRef.current!, body, {
            index: index
        });
        // we just added this handle ourselves, so it is guaranteed to resolve
        return bodySystem.getBody(handle)!;
    };

    const manageInstances = (count: number) => {
        // check if instances already exist
        let instances: BodyState[] = instanceStates.current;
        // all of the current instances need to get their instanceMesh updated
        instances.forEach((instance) => {
            instance.object = instancedMeshRef.current!;
        });

        // if the count is less than the current instances, remove the extras
        if (instances.length > count) {
            // split the array and get an array of extras to be deleted
            const extras = instances.slice(count);
            instances = instances.slice(0, count);
            // remove the extras - this unregisters each body from bodySystem's maps
            extras.forEach((instance) => {
                instance.destroy();
            });
        } else if (count > instances.length) {
            // if the count is greater than the current instances, add the extras
            for (let i = instances.length; i < count; i++) {
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `subscribed` stands in for which handlers are present, `count` for the instance set
    }, [count, subscribed]);

    // cleanup: remove every body this component created, and release the InstancedMesh (and
    // anything it exclusively owns) so nothing outlives the component - see #24.
    //
    // #57: was `useUnmount`; a plain `useEffect` returning only a cleanup, deps `[]`, runs
    // that cleanup on unmount exactly once per mount, same as the old hook.
    useEffect(() => {
        return () => {
            const instances = instanceStates.current;
            instances.forEach((instance) => {
                instance.destroy();
            });
            instanceStates.current = [];

            const mesh = instancedMeshRef.current;
            if (mesh) destroyInstancedMesh(mesh);
            instancedMeshRef.current = null;

            if (ownedGeometryRef.current) {
                ownedGeometryRef.current.dispose();
                ownedGeometryRef.current = null;
            }
            if (ownedMaterialRef.current) {
                ownedMaterialRef.current.dispose();
                ownedMaterialRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only teardown.
    }, []);

    return (
        <>
            <mesh position={position} rotation={rotation} ref={holderMeshRef}>
                {children}
            </mesh>
        </>
    );
});
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

/**
 * @deprecated Renamed to {@link InstancedRigidBodies}, to match `@react-three/rapier`'s
 * component of the same name (issue #37, sibling-library parity). This alias will be removed
 * before 1.0.
 */
export const InstancedRigidBodyMesh = InstancedRigidBodies;

/** @deprecated Renamed to {@link InstancedRigidBodiesProps}. */
export type InstancedRigidBodyMeshProps = InstancedRigidBodiesProps;
