import { Environment } from '@react-three/drei';
import { type BodyState, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

/**
 * Demonstrates onSleep/onWake events: sleeping bodies cost nothing; Jolt wakes neighbours
 * touched by an awake body. A couple of boxes drop onto the pyramid right away so the wake
 * cascade is visible, everything settles grey, then a fresh box keeps dropping every few
 * seconds so the sleep/wake cycle never really stops. Click any box to wake it and pop it -
 * see BodyState.addImpulse (issue #299: this used to do nothing to a sleeping box).
 *
 * Key APIs: RigidBody onSleep/onWake props, BodyState.addImpulse().
 */
export function SleepWake() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const drops = useDrops();

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
                        position={[(col - (n - 1) / 2) * 1.05, 0.5 + row * 1.0, 0]}
                    />
                ));
            })}

            {/* dropped in right away, then one more every few seconds - see useDrops below */}
            {drops.map((drop) => (
                <Box
                    key={`drop-${drop.id}`}
                    position={[drop.x, drop.y, drop.z]}
                    awakeColor="#f77f00"
                />
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

interface Drop {
    id: number;
    x: number;
    y: number;
    z: number;
}

/**
 * Two boxes above the pyramid immediately (staggered so they don't spawn overlapping), then
 * one more every few seconds - each landing wakes whatever it touches, and the pile settles
 * grey again a moment later. Bounded at `max` extra boxes so the scene never grows without
 * limit: the oldest drop is unmounted (and its body freed) when a new one arrives.
 */
function useDrops(seedCount = 2, intervalMs = 4000, max = 6): Drop[] {
    const nextId = useRef(seedCount);
    const [drops, setDrops] = useState<Drop[]>(() =>
        Array.from({ length: seedCount }, (_, i) => ({
            id: i,
            x: (i - (seedCount - 1) / 2) * 1.4,
            y: 8 + i * 1.3,
            z: 0
        }))
    );

    useEffect(() => {
        const interval = setInterval(() => {
            setDrops((prev) => {
                const drop: Drop = {
                    id: nextId.current++,
                    x: (Math.random() - 0.5) * 3,
                    y: 8,
                    z: (Math.random() - 0.5) * 3
                };
                const next = [...prev, drop];
                return next.length > max ? next.slice(next.length - max) : next;
            });
        }, intervalMs);
        return () => clearInterval(interval);
    }, [intervalMs, max]);

    return drops;
}

function Box({
    position,
    awakeColor = '#4060ff'
}: {
    position: [number, number, number];
    awakeColor?: string;
}) {
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
                    color={sleeping ? '#888888' : awakeColor}
                    roughness={0.3}
                    metalness={0.1}
                />
            </mesh>
        </RigidBody>
    );
}
