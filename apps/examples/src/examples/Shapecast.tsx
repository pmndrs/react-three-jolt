// Shapecast (#287): sweeps a sphere shape back and forth over a row of static obstacles,
// re-casting it with Shapecaster every frame. Look at `shapecaster.origin`/`direction` (set in
// useFrame below) and `shapecaster.cast()` for the query itself - `hit.position` and
// `hit.impactNormal` are what drive the ghost sphere and arrow drawn at the hit.

import { Environment } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import {
    Physics,
    RigidBody,
    type Shapecaster,
    type ShapecastHit,
    useJolt
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

export function Shapecast() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
        >
            <JoltMemoryRegistrar />
            <ShapecastSweep />
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

const SWEEP_AMPLITUDE = 7;
const SWEEP_HEIGHT = 4;
const SWEEP_SPEED = 0.6;
// fallback for a degenerate (zero-length) hit normal - mirrors CastQueryBase.drawMarker's own
// MARKER_UP fallback in query-base.ts
const NORMAL_UP = new THREE.Vector3(0, 1, 0);
// a few static boxes, at different heights, for the sweep to find
const OBSTACLES: { position: [number, number, number]; size: [number, number, number] }[] = [
    { position: [-6, 0.5, 0], size: [1.4, 1, 1.4] },
    { position: [-2, 1, 0], size: [1.4, 2, 1.4] },
    { position: [2, 0.3, 0], size: [1.4, 0.6, 1.4] },
    { position: [6, 0.8, 0], size: [1.4, 1.6, 1.4] }
];

function ShapecastSweep() {
    const { physicsSystem } = useJolt();
    const { scene } = useThree();

    // teaches `direction`: the shapecast only travels this far below the sweep height, so
    // shrinking it makes the sphere sweep clean over the taller obstacles without hitting them
    const { castDistance } = useControls({
        castDistance: { value: 5, min: 1.5, max: 8, step: 0.5, label: 'Cast distance' }
    });

    // physicsSystem.getShapecaster() defaults `shape` to a 0.5-radius SphereShape (see
    // Shapecaster.activeShape in shapecasters.ts) - exactly the shape swept here, so there is
    // nothing else to configure on the caster itself.
    const shapecaster: Shapecaster = useMemo(() => physicsSystem.getShapecaster(), [physicsSystem]);
    useEffect(() => () => shapecaster.destroy(), [shapecaster]);

    // the built-in debug line (the same feature RaycastSimpleDemo uses on Raycaster) draws the
    // current cast segment - origin to origin+direction - for free every time cast() runs, so the
    // swept path needs no extra drawing code here.
    useEffect(() => {
        shapecaster.initDebugging(scene);
        shapecaster.lineColor = '#7DCFB6';
        return () => shapecaster.stopDebugging();
    }, [shapecaster, scene]);

    // direction only changes when the leva knob moves - the setter mutates the existing
    // RShapeCast in place (see Shapecaster.direction), it never touches origin/rebuilds the cast
    useEffect(() => {
        shapecaster.direction = new THREE.Vector3(0, -castDistance, 0);
    }, [shapecaster, castDistance]);

    const sweepRef = useRef<THREE.Mesh>(null!);
    const hitRef = useRef<THREE.Mesh>(null!);
    // the arrow for the hit normal - a plain three.js ArrowHelper, mounted into the scene graph
    // like any other primitive and then updated in place from useFrame below
    const arrow = useMemo(
        () => new THREE.ArrowHelper(NORMAL_UP, new THREE.Vector3(), 1.5, 0x2a9d8f, 0.4, 0.25),
        []
    );

    // reused every frame below instead of allocating a fresh Vector3 for the origin write
    const origin = useRef(new THREE.Vector3()).current;

    useFrame((state) => {
        // r3f v10's useFrame state carries timing directly (`elapsed`/`delta`) instead of a
        // THREE.Clock - see @pmndrs/scheduler's FrameTimingState.
        const x = Math.sin(state.elapsed * SWEEP_SPEED) * SWEEP_AMPLITUDE;
        origin.set(x, SWEEP_HEIGHT, 0);
        sweepRef.current.position.copy(origin);
        shapecaster.origin = origin;

        const hit = shapecaster.cast() as ShapecastHit | undefined;
        if (hit) {
            hitRef.current.visible = true;
            hitRef.current.position.copy(hit.position);

            const normal = hit.impactNormal;
            arrow.position.copy(hit.position);
            arrow.setDirection(normal.lengthSq() > 1e-8 ? normal.normalize() : NORMAL_UP);
            arrow.visible = true;
        } else {
            hitRef.current.visible = false;
            arrow.visible = false;
        }
    });

    return (
        <>
            <Floor position={[0, 0, 0]} size={20}>
                <meshStandardMaterial color="#fdf0d5" />
            </Floor>

            {OBSTACLES.map((obstacle) => (
                <RigidBody
                    key={obstacle.position.join(',')}
                    position={obstacle.position}
                    type="static"
                >
                    <mesh castShadow receiveShadow>
                        <boxGeometry args={obstacle.size} />
                        <meshStandardMaterial color="#6b7280" />
                    </mesh>
                </RigidBody>
            ))}

            {/* the shape being swept - follows the shapecaster's animated origin every frame */}
            <mesh ref={sweepRef}>
                <sphereGeometry args={[0.5, 24, 16]} />
                <meshStandardMaterial color="#7DCFB6" transparent opacity={0.55} />
            </mesh>

            {/* ghost marker at the current hit position */}
            <mesh ref={hitRef} visible={false}>
                <sphereGeometry args={[0.25, 16, 12]} />
                <meshStandardMaterial color="#F4A261" emissive="#F4A261" emissiveIntensity={0.6} />
            </mesh>

            <primitive object={arrow} visible={false} />
        </>
    );
}
