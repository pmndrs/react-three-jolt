import * as THREE from 'three';
import { Physics, Heightfield, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt-addons';
//import { CameraRig } from './lib/components/CameraRig';
import { VehicleFourWheel } from '@react-three/jolt-controllers';

export function FourWheelDemo() {
  //const controllerRef = useRef(null);

  //const options = useConst({ inverted: { y: true } });
  //useGamepadForCameraControls('look', controls, options);

  // body settings so shapes bounce
  const defaultBodySettings = {
    mRestitution: 0,
  };

  return (
    <Physics gravity={25} defaultBodySettings={defaultBodySettings}>
      <VehicleFourWheel position={[0, 25, 0]} />
      <RigidBody
        position={[0, 2, 0]}
        rotation={[THREE.MathUtils.degToRad(10), 0, 0]}
        type="static"
      >
        <mesh>
          <boxGeometry args={[30, 0.3, 30]} />
          <meshStandardMaterial color="#E2C2C6" />
        </mesh>
      </RigidBody>
      <Heightfield
        position={[0, 0, 0]}
        url="heightmaps/wp1024.png"
        size={256}
        width={512}
        height={512}
      />

      <Floor size={150} position={[0, 0, 0]} />
    </Physics>
  );
}
/*

                <RigidBody position={[0, 100, 3]}>
                    <mesh shape={'sphere'}>
                        <sphereGeometry args={[1, 32, 32]} />
                        <meshStandardMaterial color="hotpink" />
                    </mesh>
                </RigidBody>
                */
