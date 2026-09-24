// Demo: contact events (issue #282, mirrors upstream Examples/contact_listener.html).
//
// Three static pads catch boxes dropped from above. The left pad reacts with the
// `onCollisionEnter` / `onCollisionExit` props, the right pad does the same thing through the
// `useBodyEvent` hook, and the middle pad uses `onContactValidate` to reject every contact so
// its box falls straight through to the floor.
import { Environment, Html } from '@react-three/drei';
import { type BodyState, Physics, RigidBody, useBodyEvent } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useEffect, useRef, useState } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const OFF_COLOR = '#495867';
const ON_COLOR = '#ef8354';
const PAD_SIZE: [number, number, number] = [3, 0.6, 3];
const PAD_Y = 1.8;
const DROP_Y = 7;

export function ContactEvents() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={20}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={30}>
                <meshStandardMaterial color="#2b2d42" />
            </Floor>

            <PropPad x={-6} label={'onCollisionEnter\n/ onCollisionExit'} />
            <ValidatePad x={0} label={'onContactValidate\n→ rejects, falls through'} />
            <HookPad x={6} label={'useBodyEvent\n(collisionEnter/Exit)'} />

            <FallingBox x={-6} />
            <FallingBox x={0} />
            <FallingBox x={6} />

            <directionalLight
                castShadow
                position={[10, 14, 12]}
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

/** A box dropped from above a pad, with just enough bounce to show enter/exit cycling. */
function FallingBox({ x }: { x: number }) {
    return (
        <RigidBody position={[x, DROP_Y, 0]} restitution={0.35} friction={0.6}>
            <mesh castShadow>
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#e0e1dd" />
            </mesh>
        </RigidBody>
    );
}

function PadLabel({ x, text }: { x: number; text: string }) {
    return (
        <Html position={[x, PAD_Y + 2.4, 0]} center distanceFactor={12}>
            <div
                style={{
                    color: 'white',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    textAlign: 'center',
                    whiteSpace: 'pre-line',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    pointerEvents: 'none'
                }}
            >
                {text}
            </div>
        </Html>
    );
}

/** Left pad: the ordinary `<RigidBody onCollisionEnter onCollisionExit>` props. */
function PropPad({ x, label }: { x: number; label: string }) {
    const [touching, setTouching] = useState(false);

    return (
        <>
            <PadLabel x={x} text={label} />
            <RigidBody
                type="static"
                position={[x, PAD_Y, 0]}
                onCollisionEnter={() => setTouching(true)}
                onCollisionExit={() => setTouching(false)}
            >
                <mesh receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial color={touching ? ON_COLOR : OFF_COLOR} />
                </mesh>
            </RigidBody>
        </>
    );
}

/** Right pad: the same enter/exit toggle, subscribed imperatively via `useBodyEvent`. */
function HookPad({ x, label }: { x: number; label: string }) {
    const ref = useRef<BodyState | null>(null);
    // `ref.current` is set inside RigidBody's own mount effect; reading it back in an effect of
    // our own (which runs after a child's, in the same commit) turns it into reactive state so
    // `useBodyEvent` has an actual BodyState instance to key its subscription on.
    const [body, setBody] = useState<BodyState | undefined>();
    useEffect(() => {
        setBody(ref.current ?? undefined);
    }, []);

    const [touching, setTouching] = useState(false);
    useBodyEvent(body, 'collisionEnter', () => setTouching(true));
    useBodyEvent(body, 'collisionExit', () => setTouching(false));

    return (
        <>
            <PadLabel x={x} text={label} />
            <RigidBody ref={ref} type="static" position={[x, PAD_Y, 0]}>
                <mesh receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial color={touching ? ON_COLOR : OFF_COLOR} />
                </mesh>
            </RigidBody>
        </>
    );
}

/**
 * Middle pad: `onContactValidate` runs synchronously inside the physics step and its return
 * value is Jolt's answer - returning `false` unconditionally rejects every contact, so nothing
 * ever rests on this pad and the box falls straight through to the floor below.
 */
function ValidatePad({ x, label }: { x: number; label: string }) {
    return (
        <>
            <PadLabel x={x} text={label} />
            <RigidBody type="static" position={[x, PAD_Y, 0]} onContactValidate={() => false}>
                <mesh receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial color="#8338ec" transparent opacity={0.45} />
                </mesh>
            </RigidBody>
        </>
    );
}
