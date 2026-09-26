import { Environment, Html } from '@react-three/drei';
import { Physics, RigidBody } from '@react-three/jolt';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Demonstrates friction and restitution:
// - Left side: boxes in separate lanes sliding down a ramp, friction 0 → 1
// - Right side: balls dropping and bouncing, restitution 0 → 1
// See RigidBody props: friction, restitution

export function Friction() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const frictionValues = [0, 0.25, 0.5, 0.75, 1];
    const rampRotation = 0.4; // rad, ~23°: far end (-z) is high, slopes down toward camera
    const rampPos = [-8, 4, 0];

    // Ramp dimensions: 12 wide × 0.5 high × 16 long
    const rampWidth = 12;
    const rampHeight = 0.5;
    const rampLength = 16;

    // Point on ramp top at local z, rotated about X by rampRotation.
    // Rotation: y' = y cos(θ) - z sin(θ), z' = y sin(θ) + z cos(θ)
    // For local z = -6: y ≈ 6.8, z ≈ -5.4
    const localZ = -6;
    const top = rampHeight / 2 + 0.35; // +half box (0.3) +clearance (0.05)
    const boxStartY = rampPos[1] + top * Math.cos(rampRotation) - localZ * Math.sin(rampRotation);
    const boxStartZ = rampPos[2] + top * Math.sin(rampRotation) + localZ * Math.cos(rampRotation);

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

            {/* Floor at y=0. Restitution=0 so ball restitution dominates (max(r1,r2)). */}
            <RigidBody type="static" position={[0, 0, 0]} restitution={0}>
                <mesh receiveShadow scale-y={1}>
                    <boxGeometry args={[100, 0.5, 100]} />
                    <meshStandardMaterial />
                </mesh>
            </RigidBody>

            {/* Ramp: 12 wide × 0.5 high × 16 long, rotated 0.4 rad about X (slopes down toward camera). */}
            {/* Friction=1 so Jolt's sqrt(1*f) = sqrt(f) makes box friction dominant. */}
            <RigidBody
                type="static"
                position={rampPos}
                rotation={[rampRotation, 0, 0]}
                friction={1}
            >
                <mesh>
                    <boxGeometry args={[rampWidth, rampHeight, rampLength]} />
                    <meshStandardMaterial color="#888" />
                </mesh>
            </RigidBody>

            {/* Boxes with increasing friction in separate lanes */}
            {frictionValues.map((friction, i) => {
                const boxX = rampPos[0] + (i - 2) * 2.2;
                const labelTop = rampHeight / 2 + 1.2;
                const labelY =
                    rampPos[1] +
                    labelTop * Math.cos(rampRotation) -
                    localZ * Math.sin(rampRotation);
                const labelZ =
                    rampPos[2] +
                    labelTop * Math.sin(rampRotation) +
                    localZ * Math.cos(rampRotation);
                return (
                    <group key={`friction-${i}`}>
                        <RigidBody
                            position={[boxX, boxStartY, boxStartZ]}
                            rotation={[rampRotation, 0, 0]}
                            friction={friction}
                        >
                            <mesh castShadow>
                                <boxGeometry args={[0.6, 0.6, 0.6]} />
                                <meshStandardMaterial color="#00ff88" />
                            </mesh>
                        </RigidBody>
                        {/* Label on ramp at top of lane */}
                        <Html position={[boxX, labelY, labelZ]} center distanceFactor={30}>
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
                );
            })}

            {/* Balls with increasing restitution, all drop from y=8 */}
            {frictionValues.map((restitution, i) => {
                const ballX = 8 + (i - 2) * 1.5;
                return (
                    <group key={`restitution-${i}`}>
                        <RigidBody position={[ballX, 8, 0]} restitution={restitution}>
                            <mesh castShadow>
                                <sphereGeometry args={[0.4, 16, 16]} />
                                <meshStandardMaterial color="#ff88ff" />
                            </mesh>
                        </RigidBody>
                        {/* Label at floor level in front of lane */}
                        <Html position={[ballX, 0.1, 1.5]} center distanceFactor={30}>
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
                );
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
