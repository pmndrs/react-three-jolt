// Sensor volumes: bodies passing through tint while inside, count displayed.
// Demonstrates: RigidBody isSensor, onSensorEnter / onSensorExit events.
import { Environment, Html } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useRef, useState } from 'react';
import { Color } from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const SENSOR_TINT = new Color('#ff6b6b');
const DEFAULT_TINT = new Color('#4ecdc4');

function SensorBox() {
    const sensorRef = useRef(null);
    const [sensorCount, setSensorCount] = useState(0);
    const bodiesInSensor = useRef(new Set<number>());

    const handleSensorEnter = (payload: any) => {
        const otherId = payload.other.handle;
        if (!bodiesInSensor.current.has(otherId)) {
            bodiesInSensor.current.add(otherId);
            setSensorCount((prev) => prev + 1);
            // Tint the body
            const object = payload.other.object;
            if (object) {
                object.traverse((node: any) => {
                    if (node.isMesh && node.material) {
                        node.material.color.copy(SENSOR_TINT);
                    }
                });
            }
        }
    };

    const handleSensorExit = (payload: any) => {
        const otherId = payload.other.handle;
        if (bodiesInSensor.current.has(otherId)) {
            bodiesInSensor.current.delete(otherId);
            setSensorCount((prev) => Math.max(0, prev - 1));
            // Revert tint
            const object = payload.other.object;
            if (object) {
                object.traverse((node: any) => {
                    if (node.isMesh && node.material) {
                        node.material.color.copy(DEFAULT_TINT);
                    }
                });
            }
        }
    };

    return (
        <>
            {/* Translucent sensor volume */}
            <RigidBody
                ref={sensorRef}
                type="static"
                isSensor
                position={[0, 5, 0]}
                onSensorEnter={handleSensorEnter}
                onSensorExit={handleSensorExit}
            >
                <mesh>
                    <boxGeometry args={[8, 8, 8]} />
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

            {/* Falling boxes */}
            {[0, 2, 4, -2, -4].map((x, i) => (
                <RigidBody key={i} position={[x, 15 + i * 2, 0]} type="dynamic" mass={1}>
                    <mesh>
                        <boxGeometry args={[0.6, 0.6, 0.6]} />
                        <meshStandardMaterial color={DEFAULT_TINT} />
                    </mesh>
                </RigidBody>
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

            <SensorBox />

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
