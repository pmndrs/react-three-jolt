// Demo: <Water> volumes (issue #240) with per-body buoyancy overrides (issue #260).
//
// A single <Water> volume with a default buoyancy, and bodies that override it with their own
// `buoyancy` prop. This lets corks and rocks fall into the same pool and behave differently
// without stacking overlapping volumes or collision groups.
// `volume.buoyancy` is a ratio to gravity, not an object density (see docs/api/buoyancy.mdx).
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

    const { flow, defaultBuoyancy, corkBuoyancy, rockBuoyancy, linearDrag, angularDrag } =
        useControls('Water', {
            flow: { value: 0, min: -4, max: 4, step: 0.25 },
            defaultBuoyancy: { value: 1.5, min: 0.5, max: 2.5, step: 0.1 },
            corkBuoyancy: { value: 1.8, min: 1, max: 3, step: 0.1 },
            rockBuoyancy: { value: 0.35, min: 0, max: 0.9, step: 0.05 },
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
                defaultBuoyancy={defaultBuoyancy}
                corkBuoyancy={corkBuoyancy}
                rockBuoyancy={rockBuoyancy}
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
    defaultBuoyancy,
    corkBuoyancy,
    rockBuoyancy,
    linearDrag,
    angularDrag
}: {
    flow: number;
    defaultBuoyancy: number;
    corkBuoyancy: number;
    rockBuoyancy: number;
    linearDrag: number;
    angularDrag: number;
}) {
    // corks (boxes) float; rocks (spheres) sink - per-body buoyancy overrides let them share
    // the same water volume without needing separate collision groups or stacked volumes.
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

    // give every newly spawned instance its buoyancy override and a random drop position
    useEffect(() => {
        if (!corksRef.current) return;
        for (let i = previousCorkCount.current; i < corksRef.current.length; i++) {
            const body = corksRef.current[i];
            body.buoyancy = corkBuoyancy;
            body.position = new THREE.Vector3(
                Math.random() * 10 - 5,
                SPAWN_Y_MIN + Math.random() * SPAWN_Y_RANGE,
                Math.random() * 10 - 5
            );
        }
        previousCorkCount.current = corkCount;
    }, [corkCount, corkBuoyancy]);

    useEffect(() => {
        if (!rocksRef.current) return;
        for (let i = previousRockCount.current; i < rocksRef.current.length; i++) {
            const body = rocksRef.current[i];
            body.buoyancy = rockBuoyancy;
            body.position = new THREE.Vector3(
                Math.random() * 10 - 5,
                SPAWN_Y_MIN + Math.random() * SPAWN_Y_RANGE,
                Math.random() * 10 - 5
            );
        }
        previousRockCount.current = rockCount;
    }, [rockCount, rockBuoyancy]);

    return (
        <>
            {/* one water volume with a default buoyancy; bodies override it with their own */}
            <Water
                position={POOL_POSITION}
                size={POOL_SIZE}
                surfaceHeight={SURFACE_HEIGHT}
                buoyancy={defaultBuoyancy}
                linearDrag={linearDrag}
                angularDrag={angularDrag}
                flow={[flow, 0, 0]}
                visible
                color="#2f7dc4"
                opacity={0.55}
            />

            <InstancedRigidBodies
                ref={corksRef}
                count={corkCount}
                color="#f4d35e"
                position={[0, SPAWN_Y_MIN, 0]}
                buoyancy={corkBuoyancy}
            >
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#f4d35e" />
            </InstancedRigidBodies>

            <InstancedRigidBodies
                ref={rocksRef}
                count={rockCount}
                color="#5c5c5c"
                position={[0, SPAWN_Y_MIN, 0]}
                buoyancy={rockBuoyancy}
            >
                <sphereGeometry args={[0.5, 16, 16]} />
                <meshStandardMaterial color="#5c5c5c" />
            </InstancedRigidBodies>

            {/* a couple of bodies dropped straight in so the pool isn't empty on load */}
            <RigidBody position={[-3, 6, 2]} buoyancy={corkBuoyancy}>
                <mesh castShadow>
                    <boxGeometry args={[1.2, 1.2, 1.2]} />
                    <meshStandardMaterial color="#f4d35e" />
                </mesh>
            </RigidBody>
            <RigidBody position={[3, 6, -2]} buoyancy={rockBuoyancy}>
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
