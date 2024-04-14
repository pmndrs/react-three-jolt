import { RigidBody, Floor } from '@react-three/jolt';

export function JustBoxes() {
  //const { physicsSystem } = useJolt();

  // draw 5 cubes that land on the floor
  return (
    <>
      <Floor position={[0, 0, 0]} size={100} />
      <RigidBody position={[0, 1, 0]}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="green" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 5]}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="green" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 10]}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="green" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 15]}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="green" />
        </mesh>
      </RigidBody>
      <RigidBody position={[0, 1, 20]} rotation={[0, 0.5, 0]}>
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="green" />
        </mesh>
      </RigidBody>
    </>
  );
}
