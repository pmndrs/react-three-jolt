// Sensor volumes: kinematic zone slides over resting bodies, tint while inside.
// Demonstrates: RigidBody isSensor, onSensorEnter / onSensorExit events.
// Kinematic sensors detect sleeping bodies, so count updates persistently.
import { Environment, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { BodyState, SensorPayload } from '@react-three/jolt';
import { Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useRef, useState } from 'react';
import { Color } from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const SENSOR_TINT = new Color('#ff6b6b');
const DEFAULT_TINT = new Color('#4ecdc4');

function FallingBox({
    x,
    i,
    onEnter,
    onExit
}: {
    x: number;
    i: number;
    onEnter: () => void;
    onExit: () => void;
}) {
    const [inside, setInside] = useState(false);

    const handleSensorEnter = (_payload: SensorPayload) => {
        setInside(true);
        onEnter();
    };

    const handleSensorExit = (_payload: SensorPayload) => {
        setInside(false);
        onExit();
    };

    return (
        <RigidBody
            position={[x, 15 + i * 2, 0]}
            type="dynamic"
            mass={1}
            onSensorEnter={handleSensorEnter}
            onSensorExit={handleSensorExit}
        >
            <mesh>
                <boxGeometry args={[0.6, 0.6, 0.6]} />
                <meshStandardMaterial color={inside ? SENSOR_TINT : DEFAULT_TINT} />
            </mesh>
        </RigidBody>
    );
}

function SensorZone() {
    const sensorRef = useRef<BodyState>(null);
    const [sensorCount, setSensorCount] = useState(0);
    const timeRef = useRef(0);

    useFrame((_state, deltaTime) => {
        timeRef.current += deltaTime;
        const body = sensorRef.current;
        if (body) {
            const x = Math.sin(timeRef.current) * 6;
            body.setKinematicTarget([x, 1, 0]);
        }
    });

    return (
        <>
            {/* Kinematic sensor volume that slides left/right over resting boxes */}
            <RigidBody ref={sensorRef} type="kinematic" isSensor position={[0, 1, 0]}>
                <mesh>
                    <boxGeometry args={[6, 2, 6]} />
                    <meshStandardMaterial
                        color="#aaa"
                        transparent
                        opacity={0.15}
                        depthWrite={false}
                    />
                </mesh>
            </RigidBody>

            {/* Count display */}
            <group position={[0, 10, 0]}>
                <Html distanceFactor={1}>
                    <div
                        style={{
                            background: 'rgba(0,0,0,0.7)',
                            color: '#fff',
                            padding: '8px 16px',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                            fontSize: '14px',
                            whiteSpace: 'nowrap'
                        }}
                    >
                        In Sensor: {sensorCount}
                    </div>
                </Html>
            </group>

            {/* Falling boxes spread across x to land in and out of sensor zone */}
            {[-6, -3, 0, 3, 6, -4.5, 1.5, 4.5].map((x, i) => (
                <FallingBox
                    key={i}
                    x={x}
                    i={i}
                    onEnter={() => setSensorCount((c) => c + 1)}
                    onExit={() => setSensorCount((c) => Math.max(0, c - 1))}
                />
            ))}
        </>
    );
}

export function Sensors() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={100}>
                <meshStandardMaterial color="#ddd" />
            </Floor>

            <SensorZone />

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
