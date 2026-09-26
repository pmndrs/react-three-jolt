// SoftBodyEvents (issue #291, PR #273 / #245): a <SoftBody>'s onCollisionEnter/onCollisionExit
// and onContactValidate props. A soft ball rolls down a tilted row of three pads - two tint
// while the ball is in soft contact, the third rejects the contact via onContactValidate and
// the ball rolls straight through it instead of bouncing.
import { Environment, Html } from '@react-three/drei';
import {
    type CollisionEnterPayload,
    type CollisionExitPayload,
    Physics,
    RigidBody,
    SoftBody,
    type SoftBodyValidatePayload
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useCallback, useState } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// One row of three pads, all rotated the same amount about Z so they read as one tilted shelf -
// gravity carries the ball down across `pad-a` -> `pad-reject` -> `pad-b`.
const SLOPE = -0.25;
const REJECT_NAME = 'pad-reject';
const PADS = [
    { name: 'pad-a', local: -3.5, label: 'tints on contact' },
    { name: REJECT_NAME, local: 0, label: 'rejects contact - passes through' },
    { name: 'pad-b', local: 3.5, label: 'tints on contact' }
] as const;

/** Position along the tilted shelf: `local` is the offset along its slope, in world units. */
const alongSlope = (local: number): [number, number, number] => [
    local * Math.cos(SLOPE),
    4 + local * Math.sin(SLOPE),
    0
];

function Pad({
    name,
    local,
    label,
    active
}: {
    name: string;
    local: number;
    label: string;
    active: boolean;
}) {
    const [x, y, z] = alongSlope(local);
    const rejects = name === REJECT_NAME;
    const color = rejects ? '#742a2a' : active ? '#f6ad55' : '#4a5568';
    return (
        <>
            <RigidBody
                name={name}
                position={[x, y, z]}
                rotation={[0, 0, SLOPE]}
                type="static"
                friction={0.3}
                restitution={0.4}
            >
                <mesh receiveShadow>
                    <boxGeometry args={[3, 0.4, 3]} />
                    <meshStandardMaterial color={color} />
                </mesh>
            </RigidBody>
            <Html position={[x, y + 1, z]} center distanceFactor={12}>
                <div style={{ color: 'white', fontSize: 14, whiteSpace: 'nowrap' }}>{label}</div>
            </Html>
        </>
    );
}

export function SoftBodyEvents() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    // Which pads the ball currently has an open soft contact with, keyed by the pad's
    // `<RigidBody name>` (that's what `other.object?.name` resolves to below).
    const [contacting, setContacting] = useState<Record<string, boolean>>({});

    // `payload.normal` is already rotated to match the rigid-body convention (world space,
    // pointing from `other` toward `target`) even though Jolt's own SoftBodyManifold normal
    // points the opposite way - see docs/api/soft-bodies.mdx#events. No extra negation needed.
    const onCollisionEnter = useCallback((e: CollisionEnterPayload) => {
        const name = e.other.object?.name;
        if (name) setContacting((prev) => ({ ...prev, [name]: true }));
    }, []);
    const onCollisionExit = useCallback((e: CollisionExitPayload) => {
        const name = e.other.object?.name;
        if (name) setContacting((prev) => ({ ...prev, [name]: false }));
    }, []);
    // Runs synchronously inside the step, before any vertex actually touches: rejecting means
    // the ball never physically collides with this pad at all, not just that the event is hidden.
    const onContactValidate = useCallback(
        (e: SoftBodyValidatePayload) => e.other.object?.name !== REJECT_NAME,
        []
    );

    const [startX, startY, startZ] = alongSlope(-4.5);

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={15}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={60}>
                <meshStandardMaterial />
            </Floor>

            {PADS.map((pad) => (
                <Pad key={pad.name} {...pad} active={contacting[pad.name] ?? false} />
            ))}

            <SoftBody
                pressure={1500}
                numIterations={6}
                friction={0.2}
                restitution={0.4}
                onCollisionEnter={onCollisionEnter}
                onCollisionExit={onCollisionExit}
                onContactValidate={onContactValidate}
            >
                <mesh castShadow position={[startX, startY + 3, startZ]}>
                    {/* Low resolution (10x8) - a soft body is simulated per vertex, so it stays
                    cheap while still reading as round. */}
                    <sphereGeometry args={[0.8, 10, 8]} />
                    <meshStandardMaterial color="tomato" />
                </mesh>
            </SoftBody>

            <directionalLight
                castShadow
                position={[10, 15, 10]}
                shadow-camera-bottom={-20}
                shadow-camera-top={20}
                shadow-camera-left={-20}
                shadow-camera-right={20}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <Environment preset="apartment" />
        </Physics>
    );
}
