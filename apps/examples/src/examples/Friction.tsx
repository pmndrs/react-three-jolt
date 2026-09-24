import { Environment, Html } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Demonstrates friction and restitution:
// - Left side: boxes sliding down a ramp with friction 0 → 1
// - Right side: balls bouncing with restitution 0 → 1
// See RigidBody props: friction, restitution

export function Friction() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const frictionValues = [0, 0.25, 0.5, 0.75, 1];
    const rampRotation = [Math.PI / 6, 0, 0]; // 30 degrees

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

            <Floor position={[0, -2, 0]} size={100}>
                <meshStandardMaterial />
            </Floor>

            {/* Ramp for friction demo */}
            <RigidBody type="static" rotation={rampRotation} position={[-10, 0, 0]}>
                <mesh>
                    <boxGeometry args={[2, 0.2, 8]} />
                    <meshStandardMaterial color="#888" />
                </mesh>
            </RigidBody>

            {/* Boxes with increasing friction sliding down ramp */}
            {frictionValues.map((friction, i) => (
                <group key={`friction-${i}`}>
                    <RigidBody position={[-10, 3 - i * 0.5, -3 + i * 1.5]} friction={friction}>
                        <mesh>
                            <boxGeometry args={[0.6, 0.6, 0.6]} />
                            <meshStandardMaterial color="#00ff88" />
                        </mesh>
                    </RigidBody>
                    <Html position={[-10, 4.2 - i * 0.5, -3 + i * 1.5]} center distanceFactor={20}>
                        <div
                            style={{
                                color: '#ffffff',
                                fontSize: 12,
                                fontWeight: 'bold',
                                textShadow: '0 0 4px black'
                            }}
                        >
                            {friction.toFixed(2)}
                        </div>
                    </Html>
                </group>
            ))}

            {/* Balls with increasing restitution bouncing */}
            {frictionValues.map((restitution, i) => (
                <group key={`restitution-${i}`}>
                    <RigidBody position={[10, 5 - i * 0.5, -3 + i * 1.5]} restitution={restitution}>
                        <mesh>
                            <sphereGeometry args={[0.4, 16, 16]} />
                            <meshStandardMaterial color="#ff88ff" />
                        </mesh>
                    </RigidBody>
                    <Html position={[10, 6.2 - i * 0.5, -3 + i * 1.5]} center distanceFactor={20}>
                        <div
                            style={{
                                color: '#ffffff',
                                fontSize: 12,
                                fontWeight: 'bold',
                                textShadow: '0 0 4px black'
                            }}
                        >
                            {restitution.toFixed(2)}
                        </div>
                    </Html>
                </group>
            ))}

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
