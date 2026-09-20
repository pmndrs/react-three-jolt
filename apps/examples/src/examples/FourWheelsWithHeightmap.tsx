import { Environment } from '@react-three/drei';
import { Heightfield, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt-addons';
//import { CameraRig } from './lib/components/CameraRig';
import { Vehicle, type VehicleSettings } from '@react-three/jolt-controllers';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// the typed settings the vehicle is built from (issue #10): chassis, engine and wheels
const vehicleSettings: VehicleSettings = {
    type: 'fourWheel',
    vehicleWidth: 1.8,
    vehicleHeight: 0.4,
    vehicleLength: 4,
    vehicleMass: 1500,
    maxEngineTorque: 500,
    fourWheelDrive: true,
    antiRollbar: true,
    wheels: {
        radius: 0.5,
        width: 0.3,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5
    }
};

export function FourWheelDemo() {
    //const controllerRef = useRef(null);

    //const options = useConst({ inverted: { y: true } });
    //useGamepadForCameraControls('look', controls, options);
    const { module } = useDemo();

    // body settings so shapes bounce
    const defaultBodySettings = {
        mRestitution: 0
    };

    return (
        <Physics module={module} gravity={25} defaultBodySettings={defaultBodySettings}>
            <JoltMemoryRegistrar />
            {/*
                One <Vehicle> for every kind of vehicle (issue #10); `type="twoWheel"` gives a
                motorcycle. Anything rendered inside it is used as the chassis instead of the
                generated box (issue #26) - a <primitive object={gltf.scene} /> works the same way.
            */}
            <Vehicle type="fourWheel" position={[0, 25, 0]} vehicleSettings={vehicleSettings}>
                <mesh castShadow>
                    <boxGeometry args={[1.8, 0.4, 4]} />
                    <meshStandardMaterial color="#C64191" />
                </mesh>
                <mesh position={[0, 0.4, -1]} castShadow>
                    <boxGeometry args={[1.8, 0.75, 2]} />
                    <meshStandardMaterial color="#5E4AE3" />
                </mesh>
            </Vehicle>
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
/*

                <RigidBody position={[0, 100, 3]}>
                    <mesh shape={'sphere'}>
                        <sphereGeometry args={[1, 32, 32]} />
                        <meshStandardMaterial color="hotpink" />
                    </mesh>
                </RigidBody>
                */
