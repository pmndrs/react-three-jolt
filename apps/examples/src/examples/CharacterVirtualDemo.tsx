import { Environment } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { CameraRig, CharacterController } from '@react-three/jolt/controllers';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';
import { Arch } from './Bodies/Arch';
import { Conveyor } from './Bodies/Conveyor';
import { Stairs } from './Bodies/Stairs';
import { Teleport } from './Bodies/Teleport';
import { Tunnel } from './Bodies/Tunnel';
//helpers for example
import { BoundBoxes } from './BoundBoxes';
/*
import {
    useCommand,
    useCommandState,
    useGamepadForCameraControls
} from '@react-three/jolt';
*/

export function CharacterVirtualDemo() {
    //const options = useConst({ inverted: { y: true } });
    //useGamepadForCameraControls('look', controls, options);
    const { gl } = useThree();
    // Used to hardcode `module={InitJolt}` via its own `import InitJolt from 'jolt-physics'` -
    // now follows the app-wide build-variant selector like every other demo (joltModules.ts).
    const { module } = useDemo();
    // body settings so shapes bounce
    const defaultBodySettings = {
        mRestitution: 0
    };
    const pointerLock = () => {
        console.log('trying to lock');
        const element = gl.domElement;
        element.requestPointerLock();
    };

    return (
        <>
            <directionalLight
                castShadow
                position={[1, 2, 3]}
                intensity={4.5}
                shadow-normalBias={0.04}
            />
            <ambientLight intensity={1.5} />
            <Physics module={module} gravity={25} defaultBodySettings={defaultBodySettings}>
                <JoltMemoryRegistrar />
                <Arch position={[0, 0, -15]} />
                <Arch position={[0, -2, -20]} />
                <Arch position={[0, -3, -25]} />
                <Arch position={[0, -4, -30]} />

                <Conveyor position={[-10, 0, -25]} />

                <Conveyor position={[-20, 0, -25]} target={[0, 15, 0]} color={'#3685B5'} />

                <Teleport position={[5, 0, -10]} />

                <Tunnel position={[-25, 0, 25]} rotation={[0, -0.5, 0]} />
                <Stairs position={[-30, 0, 25]} rotation={[0, 4, 0]} />

                <RigidBody position={[0, 0, 10]}>
                    <mesh onClick={() => pointerLock()}>
                        <boxGeometry args={[5, 1, 5]} />
                        <meshStandardMaterial color="#D64933" />
                    </mesh>
                </RigidBody>

                <RigidBody position={[-10, 1, 0]}>
                    <mesh>
                        <boxGeometry args={[5, 0.4, 5]} />
                        <meshStandardMaterial color="#8B80F9" />
                    </mesh>
                </RigidBody>

                <RigidBody position={[30, 10, 30]}>
                    <mesh>
                        <boxGeometry args={[20, 4, 24]} />
                        <meshStandardMaterial color="#183A37" />
                    </mesh>
                </RigidBody>
                <RigidBody position={[7, 7, 7]}>
                    <mesh>
                        <cylinderGeometry args={[1, 1, 2, 32]} />
                        <meshStandardMaterial color="#7E52A0" />
                    </mesh>
                </RigidBody>

                <RigidBody position={[10, 2, 10]}>
                    <mesh shape={'box'}>
                        <boxGeometry args={[4, 4, 1]} />
                        <meshStandardMaterial color="hotpink" />
                    </mesh>
                </RigidBody>

                <BoundBoxes />
                <CharacterController debug position={[0, 0, 0]}>
                    {/* Over-the-shoulder third-person chase cam (issue #301 follow-up):
                        `cameraPosition` starts the boom behind the character, slightly above and
                        offset to one shoulder rather than dead centre. `followMode="movement"`
                        (issue #75) eases the boom's yaw round to trail the character's own
                        movement direction as it turns - the only automatic follow mode that keeps
                        a chase cam behind a moving character; `"lookAt"` frames a fixed point
                        instead, and `"free"` (the default) never turns on its own. Boom collision
                        (the shapecast/whisker pipeline) stays on at its defaults, so the camera
                        still pulls in around geometry between it and the character. */}
                    <CameraRig cameraPosition={[0.8, 1.2, 4]} followMode="movement" />
                </CharacterController>
                <Floor size={150} position={[0, -0.5, 0]} />
            </Physics>
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
        </>
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
