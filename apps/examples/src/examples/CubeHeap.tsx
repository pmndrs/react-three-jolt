import * as THREE from 'three';
import { useEffect, useRef } from 'react';

import {
  Physics,
  RigidBody,
  Floor,
  BodyState,
  InstancedRigidBodyMesh,
  useJolt,
} from '@react-three/jolt';
import { useConst, useSetInterval } from '@react-three/jolt';
import { useControls } from 'leva';

// this is going to be the instancedMesh version
export function CubeHeap() {
  const instancedRef = useRef<BodyState[]>(null);
  const previousCount = useRef(0);
  const fountainInterval = useRef(null);
  //controls
  const { count } = useControls({
    count: { value: 200, min: 1, max: 2000, step: 1 },
  });

  // Utils -------------------------------------
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

  // get a cancelable interval
  const intervals = useSetInterval();

  // setup the teleporting of shapes
  useEffect(() => {
    if (fountainInterval.current)
      intervals.clearInterval(fountainInterval.current);
    //@ts-ignore
    fountainInterval.current = intervals.setInterval(() => {
      const index = Math.floor(Math.random() * count);
      //@ts-ignore
      instancedRef.current![index].position = [
        Math.random() * 2,
        20,
        Math.random() * 2,
      ];
    }, 1000 / 60);
  }, [instancedRef, count]);

  const { physicsSystem, bodySystem } = useJolt();

  // body settings so shapes bounce
  bodySystem.defaultBodySettings = useConst({
    mRestitution: 0.7,
  });
  // adjust the gravity
  physicsSystem.setGravity(20);
  return (
    <>
      <RigidBody position={[5, 10, 3]}>
        <mesh>
          <sphereGeometry args={[1, 32, 32]} />
          <meshStandardMaterial color="#FF0000" />
        </mesh>
      </RigidBody>
      <InstancedRigidBodyMesh
        ref={instancedRef}
        count={count}
        position={[0, 18, 1]}
        color="#ffffff"
        rotation={[0, 0, 0]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#F2CC8F" />
      </InstancedRigidBodyMesh>
      <Floor position={[0, 0, 0]} size={100} />
    </>
  );
}
