import { Environment } from '@react-three/drei';
import { Physics, RigidBody, useSetInterval } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useEffect, useRef, useState } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Dynamic body spawning: creates and destroys RigidBody components on an interval,
// demonstrating that mount/unmount is cheap and does not leak memory.
// Watch the memory readout stay flat despite constant body creation and removal.

interface DynamicBody {
    id: number;
    position: [number, number, number];
    color: string;
    isBox: boolean;
}

export function AddRemoveBodies() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const defaultBodySettings = {
        mRestitution: 0.5
    };

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
            defaultBodySettings={defaultBodySettings}
        >
            <JoltMemoryRegistrar />
            <AddRemoveInner />
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

function AddRemoveInner() {
    const [bodies, setBodies] = useState<DynamicBody[]>([]);
    const nextIdRef = useRef(0);
    const intervals = useSetInterval();

    // Spawn a new body
    const spawnBody = () => {
        const x = (Math.random() - 0.5) * 20;
        const z = (Math.random() - 0.5) * 20;
        const newBody: DynamicBody = {
            id: nextIdRef.current++,
            position: [x, 15, z],
            color: `hsl(${Math.random() * 360}, 100%, 50%)`,
            isBox: Math.random() > 0.5
        };
        setBodies((prev) => {
            const updated = [...prev, newBody];
            // Keep only the 50 most recent bodies
            if (updated.length > 50) {
                return updated.slice(-50);
            }
            return updated;
        });
    };

    // Set up the spawn interval
    useEffect(() => {
        const id = intervals.setInterval(spawnBody, 100);
        return () => intervals.clearInterval(id);
    }, [intervals]);

    return (
        <>
            {/* Floor */}
            <Floor position={[0, 0, 0]} size={100}>
                <meshStandardMaterial />
            </Floor>

            {/* Dynamic bodies */}
            {bodies.map((body) => (
                <RigidBody key={body.id} position={body.position}>
                    <mesh>
                        {body.isBox ? (
                            <boxGeometry args={[0.8, 0.8, 0.8]} />
                        ) : (
                            <sphereGeometry args={[0.4, 16, 16]} />
                        )}
                        <meshStandardMaterial color={body.color} />
                    </mesh>
                </RigidBody>
            ))}
        </>
    );
}
