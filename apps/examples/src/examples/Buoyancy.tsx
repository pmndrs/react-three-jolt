// Demo: <Water> volumes (issue #240).
//
// A single pool footprint carries *two* overlapping <Water> volumes, one per collision group:
// a buoyant one for the "corks" (group 1) and an under-buoyant one for the "rocks" (group 2).
// `volume.buoyancy` is a ratio to gravity, not an object density (see docs/api/buoyancy.mdx) -
// there is no per-body density knob on `ApplyBuoyancyImpulse` itself, so this is how the library
// simulates "boxes of different densities dropped into a pool": give each density its own volume
// and let `group` pick which bodies each one affects.
import { type BodyState, InstancedRigidBodies, Physics, RigidBody, Water } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, useControls } from 'leva';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

const POOL_POSITION: [number, number, number] = [0, -1, 0];
const POOL_SIZE: [number, number, number] = [24, 12, 24];
const SURFACE_HEIGHT = 2;
const SPAWN_Y_MIN = 8;
const SPAWN_Y_RANGE = 5;

export function Buoyancy() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const { flow, floatBuoyancy, sinkBuoyancy, linearDrag, angularDrag } = useControls('Water', {
        flow: { value: 0, min: -4, max: 4, step: 0.25 },
        floatBuoyancy: { value: 1.8, min: 1, max: 3, step: 0.1 },
        sinkBuoyancy: { value: 0.35, min: 0, max: 0.9, step: 0.05 },
        linearDrag: { value: 0.3, min: 0, max: 2, step: 0.05 },
        angularDrag: { value: 0.05, min: 0, max: 1, step: 0.05 }
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={9.8}
        >
            <BuoyancyInner
                flow={flow}
                floatBuoyancy={floatBuoyancy}
                sinkBuoyancy={sinkBuoyancy}
                linearDrag={linearDrag}
                angularDrag={angularDrag}
            />
            <ambientLight intensity={0.6} />
            <directionalLight
                position={[12, 24, 12]}
                intensity={2}
                castShadow
                shadow-mapSize-width={1024}
                shadow-camera-left={-20}
                shadow-camera-right={20}
                shadow-camera-top={20}
                shadow-camera-bottom={-20}
            />
        </Physics>
    );
}

function BuoyancyInner({
    flow,
    floatBuoyancy,
    sinkBuoyancy,
    linearDrag,
    angularDrag
}: {
    flow: number;
    floatBuoyancy: number;
    sinkBuoyancy: number;
    linearDrag: number;
    angularDrag: number;
}) {
    // corks (group 1, boxes) float; rocks (group 2, spheres) sink - see the file header.
    const corksRef = useRef<BodyState[]>(null);
    const rocksRef = useRef<BodyState[]>(null);
    const previousCorkCount = useRef(0);
    const previousRockCount = useRef(0);
    const [corkCount, setCorkCount] = useState(20);
    const [rockCount, setRockCount] = useState(10);

    useControls('Buoyancy Demo', {
        'spawn 10 corks': button(() => setCorkCount((count) => count + 10)),
        'spawn 10 rocks': button(() => setRockCount((count) => count + 10))
    });

    // give every newly spawned instance its group and a random drop position, same fountain
    // pattern CubeHeap.tsx / FloatingPlatforms.tsx use for their own spawners
    useEffect(() => {
        if (!corksRef.current) return;
        for (let i = previousCorkCount.current; i < corksRef.current.length; i++) {
            const body = corksRef.current[i];
            body.group = 1;
            body.position = new THREE.Vector3(
                Math.random() * 10 - 5,
                SPAWN_Y_MIN + Math.random() * SPAWN_Y_RANGE,
                Math.random() * 10 - 5
            );
        }
        previousCorkCount.current = corkCount;
    }, [corkCount]);

    useEffect(() => {
        if (!rocksRef.current) return;
        for (let i = previousRockCount.current; i < rocksRef.current.length; i++) {
            const body = rocksRef.current[i];
            body.group = 2;
            body.position = new THREE.Vector3(
                Math.random() * 10 - 5,
                SPAWN_Y_MIN + Math.random() * SPAWN_Y_RANGE,
                Math.random() * 10 - 5
            );
        }
        previousRockCount.current = rockCount;
    }, [rockCount]);

    return (
        <>
            {/* the buoyant volume: only group 1 (corks) */}
            <Water
                position={POOL_POSITION}
                size={POOL_SIZE}
                surfaceHeight={SURFACE_HEIGHT}
                buoyancy={floatBuoyancy}
                linearDrag={linearDrag}
                angularDrag={angularDrag}
                flow={[flow, 0, 0]}
                group={1}
                visible
                color="#2f7dc4"
                opacity={0.55}
            />
            {/* the under-buoyant volume, same footprint: only group 2 (rocks) */}
            <Water
                position={POOL_POSITION}
                size={POOL_SIZE}
                surfaceHeight={SURFACE_HEIGHT}
                buoyancy={sinkBuoyancy}
                linearDrag={linearDrag}
                angularDrag={angularDrag}
                flow={[flow, 0, 0]}
                group={2}
            />

            <InstancedRigidBodies
                ref={corksRef}
                count={corkCount}
                color="#f4d35e"
                position={[0, SPAWN_Y_MIN, 0]}
            >
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#f4d35e" />
            </InstancedRigidBodies>

            <InstancedRigidBodies
                ref={rocksRef}
                count={rockCount}
                color="#5c5c5c"
                position={[0, SPAWN_Y_MIN, 0]}
            >
                <sphereGeometry args={[0.5, 16, 16]} />
                <meshStandardMaterial color="#5c5c5c" />
            </InstancedRigidBodies>

            {/* a couple of bodies dropped straight in so the pool isn't empty on load - `group`
                is what routes each one to its own volume above */}
            <RigidBody position={[-3, 6, 2]} group={1}>
                <mesh castShadow>
                    <boxGeometry args={[1.2, 1.2, 1.2]} />
                    <meshStandardMaterial color="#f4d35e" />
                </mesh>
            </RigidBody>
            <RigidBody position={[3, 6, -2]} group={2}>
                <mesh castShadow>
                    <sphereGeometry args={[0.6, 16, 16]} />
                    <meshStandardMaterial color="#5c5c5c" />
                </mesh>
            </RigidBody>

            <Floor size={30} position={[0, -7, 0]}>
                <meshStandardMaterial color="#3d2b1f" />
            </Floor>
        </>
    );
}
