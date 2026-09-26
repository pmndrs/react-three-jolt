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
// Why discrete reliably tunnels here (neither example overrides `<Physics timeStep>`, so both
// run it at its real default, `packages/react-three-jolt/src/components/Physics.tsx`'s fixed
// `1/60` accumulator step - one `joltInterface.Step()` call per 1/60s of simulated time, not a
// step tied to render frame length):
//   per-step distance = SPEED / 60 = 60 / 60 = 1.0 unit
// 'discrete' motion quality only tests for a collision at the START and END of a step, and only
// registers a hit when a sample lands within roughly `radius + wall_half_thickness +
// speculative_margin` (0.15 + 0.025 + ~0.02 ≈ 0.2) of the wall's center - a ~0.4-wide window. A
// bigger per-step distance alone does not guarantee a miss: a step could still happen to land a
// sample inside that window. So this spawns at an integer z (`SPAWN_Z = -6`) and steps by exactly
// 1.0 unit/step, which puts every sample at an integer z - then places the wall at a
// *half-integer* z (`WALL_Z = 6.5`), exactly between two samples. The nearest sample is 0.5 units
// from the wall center, well outside the ~0.2 window, so discrete never sees it and tunnels every
// shot. 'linearCast' instead sweeps the whole step's segment (e.g. z=6 to z=7) rather than
// sampling only its endpoint, and that segment always contains z=6.5 - so it stops every shot
// regardless of this alignment trick.

const SPHERE_RADIUS = 0.15;
const SPEED = 60; // units/second - exactly 1 unit/step at the fixed 1/60 timeStep; see above
const SPAWN_Z = -6; // integer, so every step sample also lands on an integer z
const WALL_Z = 6.5; // half-integer: exactly between the z=6 and z=7 samples
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
