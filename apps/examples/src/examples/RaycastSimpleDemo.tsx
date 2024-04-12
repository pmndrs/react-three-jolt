import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  RigidBody,
  //Raycaster,
  RaycastHit,
  //useJolt,
  useMulticaster,
  useRaycaster,
  Floor,
  useSetTimeout,
  useUnmount,
} from '@react-three/jolt';
import * as THREE from 'three';

export function RaycastSimpleDemo() {
  const raycaster = useRaycaster();
  const multicaster = useMulticaster();
  const { scene } = useThree();
  const debugObject = useRef(new THREE.Object3D());

  const timeouts = useSetTimeout();
  useEffect(() => {
    if (!raycaster) return;

    // put the debug object onto the scene
    scene.add(debugObject.current);

    timeouts.setTimeout(() => {
      // setup the raycaster
      const origin = new THREE.Vector3(-5, 1, -1);
      const direction = new THREE.Vector3(10, 0, 2);

      //* Cast 1 ------------------------------
      // threeJS style setting possible
      raycaster.set(origin, direction);
      // draw the initial ray using custom function
      drawLine(origin, direction);
      // cast and respond with handlers
      raycaster.cast(
        (hit: RaycastHit) => {
          console.log('first hit', hit.bodyHandle, hit);
          drawHit(hit);
        },
        () => {
          console.log('no hit');
        }
      );

      //* Cast 2 ------------------------------
      // Move the ray (array style)
      //todo check on this type error
      //@ts-ignore with anyVec this should be working better
      raycaster.origin = [-5, 1, 4];
      // cast with values
      const hittwo = raycaster.cast();
      if (hittwo) drawHit(hittwo as RaycastHit);
      drawLine(raycaster.origin, raycaster.direction);

      //* Cast 3 ------------------------------
      // Move the ray (vector3 style)
      raycaster.origin = new THREE.Vector3(-5, 1, 9);
      // disable backface culling
      raycaster.cullBackFaces = false;
      // set the raycaster to take all hits
      raycaster.setCollector('all');
      drawLine(raycaster.origin, raycaster.direction);
      // cast with array in the handler
      //raycaster.cast((hits) => hits.forEach((hit) => drawHit(hit)));
      raycaster.cast();
      // call off raycaster hits internal array
      raycaster.hits.forEach((hit: RaycastHit) => drawHit(hit));

      //* Cast 4 ------------------------------
      // From now on use the default debugger to draw lines

      // Engage the raycaster debugger
      raycaster.initDebugging(scene);
      raycaster.drawPoints = true;

      // Move to the 4th cube and cast at the same time
      //todo check on this type error
      //@ts-ignore with anyVec this should be working better
      raycaster.castFrom([-5, 1, 14]);

      //* Cast 5 ------------------------------
      // turn off points and turn on markers
      raycaster.drawPoints = false;
      raycaster.drawMarkers = true;
      // change the ray to be between two SPECIFIC points, NOT a direction
      //todo check on this type error
      //@ts-ignore with anyVec this should be working better
      raycaster.castBetween([-5, 0.4, 20], [5, 1.5, 20]);
    }, 500);
  }, [raycaster]);
  // function to draw a ray from a hit
  const drawLine = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    color = '#D81E5B',
    _hit?: RaycastHit
  ) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        origin,
        origin.clone().add(direction),
      ]),
      new THREE.LineBasicMaterial({ color })
    );
    debugObject.current.add(line);
  };
  const drawHit = (hit: RaycastHit) => {
    // draw the normal
    const normal = hit.impactNormal;
    const origin = hit.position;
    const direction = normal.clone().multiplyScalar(2);
    drawLine(origin, direction, '#3CD048');
    // draw the hit marker
    addMarker(hit.position);
  };

  const addMarker = (center: THREE.Vector3, size = 0.5, color = '#C6D8D3') => {
    const material = new THREE.LineBasicMaterial({ color: color });
    const points: THREE.Vector3[] = [];
    points.push(center.clone().add(new THREE.Vector3(-size, 0, 0)));
    points.push(center.clone().add(new THREE.Vector3(size, 0, 0)));
    points.push(center.clone().add(new THREE.Vector3(0, -size, 0)));
    points.push(center.clone().add(new THREE.Vector3(0, size, 0)));
    points.push(center.clone().add(new THREE.Vector3(0, 0, -size)));
    points.push(center.clone().add(new THREE.Vector3(0, 0, size)));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.LineSegments(geometry, material);
    debugObject.current.add(line);
  };
  //* Multicasting =================================
  useEffect(() => {
    if (!multicaster) return;
    timeouts.setTimeout(() => {
      // set the positions to be above each cube
      const positions = [
        [0, 10, 0],
        [0, 10, 5],
        [0, 10, 10],
        [0, 10, 15],
        [0, 10, 20],
      ];
      //todo check on this type error
      //@ts-ignore with anyVec this should be working better
      multicaster.positions = positions;
      // set the directions to be the same for each
      //todo check on this type error
      //@ts-ignore with anyVec this should be working better
      multicaster.direction = [0, -11, 0];
      // turn on the debugger
      multicaster.raycaster.initDebugging(scene);
      multicaster.raycaster.drawPoints = true;
      // cast the positions
      multicaster.cast(
        (results: any) => {
          console.log('multicast results', results);
        },
        () => {
          console.log('Multicaster Failed all casts');
        }
      );
      //..you can also get the raw unsorted hits by calling
      //multicaster.hits
      // multicaster.results will also return the results array
    }, 1000);
  }, [multicaster]);

  useUnmount(() => {
    // console.log('Raycast Simple Demo unmounting...');
    scene.remove(debugObject.current);
  });

  // draw 5 cubes that land on the floor
  return (
    <>
      <Floor position={[0, 0, 0]} color={'#fdf0d5'} size={100} />
      <RigidBody position={[0, 1, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#311847" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 5]}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#311847" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 10]}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#311847" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 15]}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#311847" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 20]} rotation={[0, 0.5, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#311847" />
        </mesh>
      </RigidBody>
    </>
  );
}
