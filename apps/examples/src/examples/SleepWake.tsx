import { Environment } from '@react-three/drei';
import { type BodyState, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

/**
 * Demonstrates onSleep/onWake events: a grid of boxes that change color
 * when they fall asleep (grey) or wake up (colored). Click a box to apply
 * an upward impulse and watch it wake and influence neighbours.
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
            <Floor position={[0, -2, 0]} size={100}>
                <meshStandardMaterial color="#cccccc" />
            </Floor>

            {/* 3x3 pyramid grid of boxes */}
            {Array.from({ length: 3 }).map((_, row) =>
                Array.from({ length: 3 - row }).map((_, col) => (
                    <Box
                        key={`${row}-${col}`}
                        position={[col * 1.5 - row * 0.75, 2 + row * 1.2, 0]}
                    />
                ))
            )}

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
    const [sleeping, setSleeping] = useState(true);

    const handleClick = () => {
        if (bodyRef.current) {
            bodyRef.current.addImpulse(new THREE.Vector3(0, 5, 0));
        }
    };

    return (
        <RigidBody
            position={position}
            ref={bodyRef}
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
