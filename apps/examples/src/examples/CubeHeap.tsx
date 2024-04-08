import * as THREE from 'three';
import { useEffect, useRef } from 'react';

import {
  Physics,
  RigidBody,
  Floor,
  BodyState,
  InstancedRigidBodyMesh,
} from '@react-three/jolt';
import { useConst } from '@react-three/jolt';
import { useControls } from 'leva';

// this is going to be the instancedMesh version
export default function Experience() {
  const instancedRef = useRef<BodyState[]>(null);
  const previousCount = useRef(0);

  const fountainInterval = useRef(null);
  const { count } = useControls({
    count: { value: 100, min: 1, max: 2000, step: 1 },
  });
  const setColors = (index: number) => {
    const color = new THREE.Color();
    //loop over the instanceMesh starting at index and set a random color
    for (let i = index; i < instancedRef.current!.length; i++) {
      color.setHex(Math.random() * 0xffffff);
      instancedRef.current![i].color = color;
    }
  };
  // run when the count changes
  useEffect(() => {
    const previous = previousCount.current;
    let index = 0;
    // if the count is higher, dont reset colors on existing items.
    if (count > previous) index = previous;
    previousCount.current = count;
    if (count < previous) return;
    setColors(index);
  }, [instancedRef, count]);

  // setup the teleporting of shapes
  useEffect(() => {
    if (fountainInterval.current) clearInterval(fountainInterval.current);
    //@ts-ignore
    fountainInterval.current = setInterval(() => {
      const index = Math.floor(Math.random() * count);
      //@ts-ignore
      instancedRef.current![index].position = [
        Math.random() * 2,
        10,
        Math.random() * 2,
      ];
    }, 1000 / 60);
  }, [instancedRef, count]);

  // body settings so shapes bounce
  const defaultBodySettings = useConst({
    mRestitution: 0.7,
  });
  return (
    <>
      <directionalLight
        castShadow
        position={[1, 2, 3]}
        intensity={4.5}
        shadow-normalBias={0.04}
      />
      <ambientLight intensity={1.5} />
      <Physics gravity={20} defaultBodySettings={defaultBodySettings}>
        <RigidBody position={[5, 10, 3]}>
          <mesh>
            <sphereGeometry args={[1, 32, 32]} />
            <meshStandardMaterial color="#FF0000" />
          </mesh>
        </RigidBody>
        <InstancedRigidBodyMesh
          ref={instancedRef}
          count={count}
          position={[0, 8, 1]}
          color="#ffffff"
          rotation={[0, 0, 0]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#F2CC8F" />
        </InstancedRigidBodyMesh>
        <Floor position={[0, 0, 0]} size={100} />
      </Physics>
    </>
  );
}
