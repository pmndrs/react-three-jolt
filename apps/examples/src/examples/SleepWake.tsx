import { Environment } from '@react-three/drei';
import { type BodyState, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

/**
 * Demonstrates onSleep/onWake events: sleeping bodies cost nothing; Jolt wakes
 * neighbours touched by an awake body. A pyramid starts colored (awake),
 * turns grey when settled (~1s), then colored again when clicked to apply impulses.
 *
 * Key APIs: RigidBody onSleep/onWake props, BodyState.addImpulse().
 */
export function SleepWake() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const defaultBodySettings = {
        mRestitution: 0.1,
        mLinearDamping: 0.3,
        mAngularDamping: 0.3
    };

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={30}
            defaultBodySettings={defaultBodySettings}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={100}>
                <meshStandardMaterial color="#cccccc" />
            </Floor>

            {/* 4-3-2-1 centered pyramid: rows from bottom to top */}
            {Array.from({ length: 4 }).map((_, row) => {
                const n = 4 - row;
                return Array.from({ length: n }).map((_, col) => (
                    <Box
                        key={`${row}-${col}`}
                        position={[
                            (col - (n - 1) / 2) * 1.05,
                            0.5 + row * 1.0,
                            0
                        ]}
                    />
                ));
            })}

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

function Box({ position }: { position: [number, number, number] }) {
    const bodyRef = useRef<BodyState>(null);
    const meshRef = useRef<THREE.Mesh>(null);
    const [sleeping, setSleeping] = useState(false);

    const handleClick = () => {
        if (bodyRef.current) {
            const x = (Math.random() - 0.5) * 2;
            const z = (Math.random() - 0.5) * 2;
            bodyRef.current.addImpulse(new THREE.Vector3(x, 8, z));
        }
    };

    return (
        <RigidBody
            position={position}
            ref={bodyRef}
            mass={1}
            onSleep={() => setSleeping(true)}
            onWake={() => setSleeping(false)}
        >
            <mesh ref={meshRef} castShadow receiveShadow onClick={handleClick}>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial
                    color={sleeping ? '#888888' : '#4060ff'}
                    roughness={0.3}
                    metalness={0.1}
                />
            </mesh>
        </RigidBody>
    );
}
