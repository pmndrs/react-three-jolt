// Demo: SuperHi Footer as 2D funnel (#133)
//
// Assumption: the referenced https://www.superhi.com/ footer could not be inspected
// directly (it's a canvas/WebGL effect that a text-mode fetch can't see, and the
// live site may have since changed - a fetch of it today shows a plain static
// footer). This builds the closest canonical version of that genre of effect: a
// Matter.js-style "physics footer" where shapes drop from above, funnel down
// through a narrowing hopper, and pile up in a wide shallow container - all
// constrained to a 2D (XY) plane, viewed with an orthographic camera, with a
// pointer-following "cursor" body that shoves the pile around.
import { OrthographicCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type BodyState, Physics, RigidBody, useSetInterval } from '@react-three/jolt';
import { button, useControls } from 'leva';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// Locks every dynamic piece to the XY plane: no Z translation, no tumbling out of
// plane (rotation only allowed around Z). This is the "2D-constrained physics"
// requirement, done via RigidBody's `dof` prop (packages/react-three-jolt/src/components/RigidBody.tsx)
// which forwards to BodyState.setDof / setEnabledTranslations/Rotations
// (packages/react-three-jolt/src/systems/body-state.ts).
const PLANAR_DOF = { x: true, y: true, z: false, rotX: false, rotY: false, rotZ: true };

// Scene layout (world units). Wide + short, like a page footer band.
const CONTAINER_HALF_WIDTH = 18;
const CONTAINER_TOP = 0;
const CONTAINER_BOTTOM = -6;
const CHUTE_HALF_WIDTH = 6;
const FUNNEL_TOP = 6;
const MOUTH_HALF_WIDTH = 17;
const SPAWN_Y_MIN = 8;
const SPAWN_Y_MAX = 12;
const SPAWN_X_RANGE = 14;

// how much of the world the ortho camera should keep in frame ("contain" fit)
const WORLD_WIDTH_TARGET = 40;
const WORLD_HEIGHT_TARGET = 20;
const CENTER_Y = 2;

const MAX_COUNT = 150;

const PALETTE = ['#ff4060', '#ffcc00', '#20ffa0', '#4060ff', '#ff8a3d', '#c04dff', '#ffffff'];

type Kind = 'box' | 'sphere' | 'capsule';
type Spec = { id: string; kind: Kind; color: string; x: number; y: number; rotZ: number };

export function FooterFunnel() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const { gravity, spawnRate } = useControls('Footer Funnel', {
        gravity: { value: 26, min: 0, max: 80, step: 1 },
        spawnRate: { value: 20, min: 1, max: 60, step: 1, label: 'spawn rate (bodies/s)' }
    });

    const defaultBodySettings = {
        mRestitution: 0.12
    };

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={gravity}
            defaultBodySettings={defaultBodySettings}
        >
            <FooterCamera />
            <ambientLight intensity={0.6} />
            <directionalLight
                castShadow
                position={[5, 20, 20]}
                shadow-camera-bottom={-40}
                shadow-camera-top={40}
                shadow-camera-left={-40}
                shadow-camera-right={40}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <FunnelStage />
            <FunnelSpawner spawnRate={spawnRate} />
            <FunnelCursor />
        </Physics>
    );
}

// fits the whole scene into the viewport regardless of window size/aspect,
// using an orthographic camera so the funnel reads as a flat 2D footer strip.
function FooterCamera() {
    const { size } = useThree();
    const zoom = Math.min(size.width / WORLD_WIDTH_TARGET, size.height / WORLD_HEIGHT_TARGET);
    return (
        <OrthographicCamera
            makeDefault
            position={[0, CENTER_Y, 40]}
            zoom={zoom}
            near={0.1}
            far={200}
        />
    );
}

// static geometry: hopper walls + wide shallow container that catches the pile
function FunnelStage() {
    const wallColor = '#22163a';
    const floorColor = '#38165c';

    // funnel wall endpoints: narrow chute at the bottom -> wide mouth at the top
    const left = wallSegment([-CHUTE_HALF_WIDTH, CONTAINER_TOP], [-MOUTH_HALF_WIDTH, FUNNEL_TOP]);
    const right = wallSegment([CHUTE_HALF_WIDTH, CONTAINER_TOP], [MOUTH_HALF_WIDTH, FUNNEL_TOP]);

    return (
        <>
            {/* funnel / hopper walls */}
            <StaticWall
                position={[left.midX, left.midY, 0]}
                rotationZ={left.angle}
                length={left.length}
                color={wallColor}
            />
            <StaticWall
                position={[right.midX, right.midY, 0]}
                rotationZ={right.angle}
                length={right.length}
                color={wallColor}
            />

            {/* container walls */}
            <StaticBox
                position={[-CONTAINER_HALF_WIDTH, (CONTAINER_TOP + CONTAINER_BOTTOM) / 2, 0]}
                size={[1, CONTAINER_TOP - CONTAINER_BOTTOM, 6]}
                color={wallColor}
            />
            <StaticBox
                position={[CONTAINER_HALF_WIDTH, (CONTAINER_TOP + CONTAINER_BOTTOM) / 2, 0]}
                size={[1, CONTAINER_TOP - CONTAINER_BOTTOM, 6]}
                color={wallColor}
            />

            {/* floor */}
            <StaticBox
                position={[0, CONTAINER_BOTTOM - 0.5, 0]}
                size={[CONTAINER_HALF_WIDTH * 2 + 2, 1, 6]}
                color={floorColor}
            />
        </>
    );
}

// computes the center/length/rotation for a box "wall" that connects two 2D points
function wallSegment(a: [number, number], b: [number, number]) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return {
        length: Math.sqrt(dx * dx + dy * dy),
        angle: Math.atan2(dy, dx),
        midX: (a[0] + b[0]) / 2,
        midY: (a[1] + b[1]) / 2
    };
}

function StaticWall({
    position,
    rotationZ,
    length,
    color
}: {
    position: number[];
    rotationZ: number;
    length: number;
    color: string;
}) {
    return (
        <RigidBody type="static" position={position} rotation={[0, 0, rotationZ]}>
            <mesh receiveShadow castShadow>
                <boxGeometry args={[length, 1, 6]} />
                <meshStandardMaterial color={color} />
            </mesh>
        </RigidBody>
    );
}

function StaticBox({
    position,
    size,
    color
}: {
    position: number[];
    size: [number, number, number];
    color: string;
}) {
    return (
        <RigidBody type="static" position={position}>
            <mesh receiveShadow castShadow>
                <boxGeometry args={size} />
                <meshStandardMaterial color={color} />
            </mesh>
        </RigidBody>
    );
}

// spawns up to MAX_COUNT dynamic bodies over time, at `spawnRate` bodies/sec.
// exposes a leva "reset" button that clears the pile and starts the drop again.
function FunnelSpawner({ spawnRate }: { spawnRate: number }) {
    const [resetKey, setResetKey] = useState(0);
    const [activeCount, setActiveCount] = useState(0);
    const intervals = useSetInterval();
    const intervalId = useRef<number | null>(null);

    useControls('Footer Funnel', {
        reset: button(() => {
            setActiveCount(0);
            setResetKey((k) => k + 1);
        })
    });

    // (re)generate the pool of shapes whenever we reset
    const specs = useMemo<Spec[]>(() => {
        const kinds: Kind[] = ['box', 'sphere', 'capsule'];
        return Array.from({ length: MAX_COUNT }, (_, i) => ({
            id: `${resetKey}-${i}`,
            kind: kinds[i % kinds.length],
            color: PALETTE[i % PALETTE.length],
            x: THREE.MathUtils.randFloatSpread(SPAWN_X_RANGE * 2),
            y: THREE.MathUtils.randFloat(SPAWN_Y_MIN, SPAWN_Y_MAX),
            rotZ: Math.random() * Math.PI * 2
        }));
    }, [resetKey]);

    // drip-feed bodies in at spawnRate bodies/sec
    useEffect(() => {
        if (intervalId.current) intervals.clearInterval(intervalId.current);
        intervalId.current = intervals.setInterval(() => {
            setActiveCount((count) => (count < MAX_COUNT ? count + 1 : count));
        }, 1000 / spawnRate);
        return () => {
            if (intervalId.current) intervals.clearInterval(intervalId.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spawnRate, resetKey]);

    return (
        <>
            {specs.slice(0, activeCount).map((spec) => (
                <FunnelPiece key={spec.id} spec={spec} />
            ))}
        </>
    );
}

function FunnelPiece({ spec }: { spec: Spec }) {
    return (
        <RigidBody
            position={[spec.x, spec.y, 0]}
            rotation={[0, 0, spec.rotZ]}
            dof={PLANAR_DOF}
            mass={1}
            friction={0.5}
        >
            {spec.kind === 'box' && (
                <mesh castShadow receiveShadow>
                    <boxGeometry args={[1, 1, 1]} />
                    <meshStandardMaterial color={spec.color} />
                </mesh>
            )}
            {spec.kind === 'sphere' && (
                <mesh castShadow receiveShadow>
                    <sphereGeometry args={[0.6, 16, 16]} />
                    <meshStandardMaterial color={spec.color} />
                </mesh>
            )}
            {spec.kind === 'capsule' && (
                <mesh castShadow receiveShadow>
                    <capsuleGeometry args={[0.4, 0.6, 4, 8]} />
                    <meshStandardMaterial color={spec.color} />
                </mesh>
            )}
        </RigidBody>
    );
}

// a kinematic body that always tracks the pointer in the XY plane, so moving the
// mouse across the canvas physically shoves the pile around (collision response,
// not a raycaster + manual impulse). Pattern lifted from Impulses.tsx's Pointer().
function FunnelCursor() {
    const bodyRef = useRef<BodyState | null>(null);

    useFrame((state) => {
        if (!bodyRef.current) return;
        const { pointer, viewport } = state;
        const x = (pointer.x * viewport.width) / 2;
        const y = (pointer.y * viewport.height) / 2;
        // rotation is optional (#194); the cursor is a sphere and never turns
        bodyRef.current.setKinematicTarget(new THREE.Vector3(x, y, 0));
    });

    return (
        <RigidBody ref={bodyRef as any} type="kinematic" position={[0, 0, 0]}>
            <mesh visible={false}>
                <sphereGeometry args={[1.2, 16, 16]} />
                <meshStandardMaterial color="white" />
            </mesh>
        </RigidBody>
    );
}
