import { Environment } from '@react-three/drei';
import {
  BodyState,
  InstancedRigidBodies,
  InstancedRigidBodyProps,
  Physics,
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt-addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

export function CubeHeap() {
  const { debug, paused, interpolate, physicsKey } = useDemo();
  // body settings so shapes bounce
  const defaultBodySettings = {
    mRestitution: 0.7,
  };
  return (
    <Physics
      paused={paused}
      key={physicsKey}
      interpolate={interpolate}
      debug={debug}
      gravity={22}
      defaultBodySettings={defaultBodySettings}
    >
      <CubeHeapInner />
      <directionalLight
        castShadow
        position={[10, 10, 10]}
        shadow-camera-bottom={-40}
        shadow-camera-top={40}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-mapSize-width={1024}
        shadow-bias={-0.0001}
      />
      <Environment preset="apartment" />
    </Physics>
  );
}

// this is going to be the instancedMesh version
function CubeHeapInner() {
  const instancedRef = useRef<BodyState[]>(null);
  const instancedMeshRef = useRef<THREE.InstancedMesh>(null!);

  //controls
  const { count } = useControls({
    count: { value: 200, min: 1, max: 2000, step: 1 },
  });

  // run when the count changes
  useEffect(() => {
    const color = new THREE.Color();

    // loop over the instanceMesh starting at index and set a random color
    for (let i = 0; i < instancedMeshRef.current!.count; i++) {
      color.setHex(Math.random() * 0xffffff);
      instancedMeshRef.current!.setColorAt(i, color);
    }
  }, [instancedRef, count]);

  const instances = useMemo(() => {
    const rigidBodyProps: InstancedRigidBodyProps[] = [];

    // fun spiral!
    for (let i = 0; i < count; i++) {
      const x = Math.sin(i * 0.1) * i * 0.1;
      const y = i * 0.2;
      const z = Math.cos(i * 0.1) * i * 0.1;

      rigidBodyProps.push({ key: i, position: [x, y, z] });
    }

    return rigidBodyProps;
  }, [count]);

  // setup the teleporting of shapes
  useEffect(() => {
    const interval = setInterval(() => {
      const index = Math.floor(Math.random() * count);

      const bodyState = instancedRef.current?.[index];

      if (bodyState) {
        bodyState.setPosition([Math.random() * 2, 20, Math.random() * 2]);
      }
    }, 1000 / 60);

    return () => {
      clearInterval(interval);
    };
  }, [instancedRef, count]);

  return (
    <>
      <InstancedRigidBodies
        position={[0, 10, 0]}
        key={count}
        ref={instancedRef}
        instances={instances}
      >
        <instancedMesh
          args={[undefined, undefined, count]}
          ref={instancedMeshRef}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#F2CC8F" />
        </instancedMesh>
      </InstancedRigidBodies>

      <Floor position={[0, 0, 0]} size={100}>
        <meshStandardMaterial />
      </Floor>
    </>
  );
}
