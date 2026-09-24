import { Environment, Html } from '@react-three/drei';
import { BodyState, Physics, RigidBody, useSetInterval } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Issue #290 / #248: `<RigidBody motionQuality>` ('discrete' | 'linearCast') controls whether a
// fast body can tunnel through thin geometry. Two lanes fire IDENTICAL small, fast spheres at an
// IDENTICAL thin wall in lockstep - the only difference between them is `motionQuality`. Watch
// the left lane (discrete, red) sail straight through its wall while the right lane (linearCast,
// blue) stops dead against it.
//
// Why discrete tunnels here, worked out at the physics step rate (`<Physics timeStep>`, 1/60s by
// default):
//   per-step distance = SPEED / 60 = 30 / 60 = 0.5 units
//   wall thickness     = 0.05 units
// 'discrete' motion quality only tests for a collision at the START and END of a step - never in
// between. Since 0.5 units (10x the wall's thickness) is covered in a single step, a projectile
// can be entirely in front of the wall at the start of a step and entirely behind it at the end,
// without its swept path ever being tested against the wall - it tunnels straight through.
// 'linearCast' sweeps the body's whole motion for the step instead of sampling only the
// endpoints, so it still catches the wall no matter how thin it is relative to the step distance.

const SPHERE_RADIUS = 0.15;
const SPEED = 30; // units/second - see the tunneling math above
const SPAWN_Z = -6;
const WALL_Z = 6;
const WALL_THICKNESS = 0.05;
const FIRE_INTERVAL_MS = 900;
const MAX_VOLLEYS = 6; // caps live bodies at MAX_VOLLEYS * lanes.length

type Lane = { x: number; quality: 'discrete' | 'linearCast'; label: string; color: string };

const LANES: Lane[] = [
    { x: -3.5, quality: 'discrete', label: 'discrete — tunnels through', color: '#ff5d5d' },
    { x: 3.5, quality: 'linearCast', label: 'linearCast — stops', color: '#5dd6ff' }
];

export function MotionQuality() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    // one volley = one projectile fired into every lane at the same instant, so the two lanes
    // are always compared on an identical shot rather than independently-timed ones
    const [volleys, setVolleys] = useState<number[]>([]);
    const nextVolley = useRef(0);
    const { setInterval, clearInterval } = useSetInterval();

    useEffect(() => {
        const id = setInterval(() => {
            setVolleys((current) => {
                const next = [...current, nextVolley.current++];
                return next.length > MAX_VOLLEYS ? next.slice(next.length - MAX_VOLLEYS) : next;
            });
        }, FIRE_INTERVAL_MS);
        return () => clearInterval(id);
    }, [setInterval, clearInterval]);

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            defaultBodySettings={{ mRestitution: 0 }}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={40}>
                <meshStandardMaterial color="#20232a" />
            </Floor>

            {LANES.map((lane) => (
                <LaneWall key={lane.quality} {...lane} />
            ))}

            {volleys.map((volleyId) =>
                LANES.map((lane) => (
                    <Projectile
                        key={`${lane.quality}-${volleyId}`}
                        x={lane.x}
                        quality={lane.quality}
                        color={lane.color}
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

/** The thin wall a lane fires at, plus its floating label. */
function LaneWall({ x, label, color }: Lane) {
    return (
        <>
            <Html position={[x, 3.4, WALL_Z]} center distanceFactor={14}>
                <div
                    style={{
                        color,
                        fontFamily: 'sans-serif',
                        fontSize: 14,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}
                >
                    {label}
                </div>
            </Html>
            <RigidBody type="static" position={[x, 1.2, WALL_Z]}>
                <mesh>
                    <boxGeometry args={[2.4, 3, WALL_THICKNESS]} />
                    <meshStandardMaterial color={color} transparent opacity={0.35} />
                </mesh>
            </RigidBody>
        </>
    );
}

/** One fired sphere. `gravityFactor={0}` keeps the flight path flat, isolating the comparison to
 * `motionQuality` alone (mirrors the tunneling test in test/motion-quality.test.tsx). */
function Projectile({
    x,
    quality,
    color
}: {
    x: number;
    quality: 'discrete' | 'linearCast';
    color: string;
}) {
    const bodyRef = useRef<BodyState>(null);

    useEffect(() => {
        // fires once, before the body's first physics step
        bodyRef.current?.setVelocity(new THREE.Vector3(0, 0, SPEED));
    }, []);

    return (
        <RigidBody
            ref={bodyRef}
            position={[x, 1.2, SPAWN_Z]}
            motionQuality={quality}
            gravityFactor={0}
        >
            <mesh castShadow>
                <sphereGeometry args={[SPHERE_RADIUS, 16, 16]} />
                <meshStandardMaterial color={color} />
            </mesh>
        </RigidBody>
    );
}
