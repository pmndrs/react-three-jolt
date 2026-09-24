import { Environment } from '@react-three/drei';
import { Heightfield, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import {
    TrackedVehicle,
    type VehicleEngineState,
    type VehicleSettings
} from '@react-three/jolt/controllers';
import { useControls } from 'leva';
import { useCallback, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// issue #246: the same shape of typed settings the four-wheeler demo uses, but for a tank -
// two tracks instead of four steered wheels
const vehicleSettings: VehicleSettings = {
    type: 'tracked',
    vehicleWidth: 2.6,
    vehicleHeight: 0.7,
    vehicleLength: 5,
    vehicleMass: 4000,
    maxEngineTorque: 2000,
    wheels: {
        count: 4,
        radius: 0.4,
        width: 0.4,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5
    }
};

export function TrackedVehicleDemo() {
    const { module } = useDemo();

    const defaultBodySettings = {
        mRestitution: 0
    };

    return (
        <Physics module={module} gravity={25} defaultBodySettings={defaultBodySettings}>
            <JoltMemoryRegistrar />
            <Tank />
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

/**
 * The tank, plus the same instrument readout the four-wheeler demo has. `move`'s x axis is skid
 * steering here (issue #246) rather than a steering angle: the left and right tracks are mixed
 * from forward/turn by `TrackedVehicleManager`, so driving straight never asks a track to fight
 * the other one.
 */
function Tank() {
    const [, setReadout] = useControls('Vehicle readout', () => ({
        speed: { value: '0 km/h', editable: false },
        rpm: { value: '0', editable: false },
        gear: { value: '0', editable: false }
    }));
    const lastPublished = useRef(0);

    const onEngine = useCallback(
        (state: VehicleEngineState) => {
            const now = performance.now();
            if (now - lastPublished.current < 100) return;
            lastPublished.current = now;
            setReadout({
                speed: `${Math.abs(state.speedKmh).toFixed(0)} km/h`,
                rpm: state.rpm.toFixed(0),
                gear: String(state.gear)
            });
        },
        [setReadout]
    );

    return (
        /*
            One <TrackedVehicle> for the tank (issue #246) - exactly <Vehicle type="tracked">
            under its own name. Anything rendered inside it is used as the chassis instead of the
            generated box, same as every other <Vehicle> flavour.
        */
        <TrackedVehicle position={[0, 25, 0]} vehicleSettings={vehicleSettings} onEngine={onEngine}>
            <mesh castShadow>
                <boxGeometry args={[2.6, 0.7, 5]} />
                <meshStandardMaterial color="#4A5859" />
            </mesh>
            <mesh position={[0, 0.6, 0.5]} castShadow>
                <boxGeometry args={[1.6, 0.5, 2]} />
                <meshStandardMaterial color="#2E3532" />
            </mesh>
            <mesh position={[0, 0.9, 0.5]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                <cylinderGeometry args={[0.08, 0.08, 3, 12]} />
                <meshStandardMaterial color="#1B1F1E" />
            </mesh>
        </TrackedVehicle>
    );
}
