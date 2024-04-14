import { Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt-addons';
import { useDemo } from '../App';
export function JustBoxes() {
  const { debug, paused, interpolate, physicsKey } = useDemo();

  const defaultBodySettings = {
    mRestitution: 0.1,
  };

  // draw 5 cubes that land on the floor
  return (
    <Physics
      paused={paused}
      key={physicsKey}
      interpolate={interpolate}
      debug={debug}
      gravity={22}
      defaultBodySettings={defaultBodySettings}
    >
      <Floor position={[0, 0, 0]} size={100}>
        <meshStandardMaterial />
      </Floor>

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
    </Physics>
  );
}
