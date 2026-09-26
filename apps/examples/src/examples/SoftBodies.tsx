// Demo for the general soft-body helpers (issue #244): balloons (pressurized spheres) dropped
// onto a pile of boxes, plus a cloth sheet dropped flat onto a rigid body so it drapes over it.
import { Environment } from '@react-three/drei';
import { Balloon, Cloth, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, useControls } from 'leva';
import { useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// * a small pile of boxes for the balloons to land on -------------------------

const BOX_POSITIONS: [number, number, number][] = [
    [-4, 1, -3],
    [-1.5, 1.6, -4],
    [1.5, 1, -3.5],
    [4, 1.4, -3],
    [-2.5, 1, 0],
    [2.5, 1.2, 0.5]
];

function BoxPile() {
    return (
        <>
            {BOX_POSITIONS.map((position, i) => (
                <RigidBody key={i} type="static" position={position}>
                    <mesh receiveShadow castShadow>
                        <boxGeometry args={[2, position[1] * 2, 2]} />
                        <meshStandardMaterial color={i % 2 === 0 ? '#3d405b' : '#81b29a'} />
                    </mesh>
                </RigidBody>
            ))}
        </>
    );
}

const BALLOON_COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#a663cc', '#457b9d'];

function Balloons({ count }: { count: number }) {
    const balloons = [];
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const radius = 3.5;
        balloons.push(
            <Balloon
                key={i}
                radius={0.8}
                widthSegments={14}
                heightSegments={10}
                pressure={2200}
                numIterations={5}
                friction={0.6}
                restitution={0.2}
                position={[Math.cos(angle) * radius, 10 + i * 1.5, Math.sin(angle) * radius - 2]}
            >
                <meshStandardMaterial color={BALLOON_COLORS[i % BALLOON_COLORS.length]} />
            </Balloon>
        );
    }
    return <>{balloons}</>;
}

// * a cloth sheet dropped flat onto a rigid body, so it drapes over it --------

const DRAPE_TABLE_SIZE: [number, number, number] = [4, 2, 4];
const DRAPE_TABLE_POSITION: [number, number, number] = [0, 3, 5];

function DrapedCloth() {
    return (
        <>
            <RigidBody type="static" position={DRAPE_TABLE_POSITION}>
                <mesh receiveShadow castShadow>
                    <boxGeometry args={DRAPE_TABLE_SIZE} />
                    <meshStandardMaterial color="#264653" />
                </mesh>
            </RigidBody>
            {/* No pins at all - it just falls and drapes over the box below through ordinary
                soft-body/rigid-body collision, the same way <RigidBody> shapes collide. Laid flat
                via the mesh's own `rotation` (an object3D transform `<SoftBody>`/`<Cloth>` reads
                at creation - see components/Cloth.tsx), never `geometry.rotateX()`, which would
                instead bake the rotation into the vertex data itself. */}
            <Cloth
                width={6}
                height={6}
                segmentsX={14}
                segmentsY={14}
                pinned={[]}
                compliance={0.0002}
                friction={0.5}
                vertexRadius={0.03}
                rotation={[-Math.PI / 2, 0, 0]}
                position={[
                    DRAPE_TABLE_POSITION[0],
                    DRAPE_TABLE_POSITION[1] + DRAPE_TABLE_SIZE[1] / 2 + 3,
                    DRAPE_TABLE_POSITION[2]
                ]}
            >
                <meshStandardMaterial color="#f1faee" side={THREE.DoubleSide} roughness={0.8} />
            </Cloth>
        </>
    );
}

// * Scene ----------------------------------------------------------------------

export function SoftBodiesDemo() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    // Bumping this remounts <Physics>, so "Drop again" restarts the whole scene from its initial
    // positions - the same trick Constraints.tsx's "Reset Scene" button uses.
    const [resetKey, setResetKey] = useState(0);

    const { count } = useControls('Balloons', {
        count: { value: 5, min: 1, max: 6, step: 1 }
    });
    useControls({
        'Drop again': button(() => setResetKey((k) => k + 1))
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={`${physicsKey}-${resetKey}`}
            interpolate={interpolate}
            debug={debug}
            gravity={9.81}
        >
            <BoxPile />
            <Balloons count={count} />
            <DrapedCloth />

            <Floor position={[0, 0, 0]} size={60}>
                <meshStandardMaterial />
            </Floor>
            <directionalLight
                castShadow
                position={[12, 22, 18]}
                shadow-camera-bottom={-25}
                shadow-camera-top={25}
                shadow-camera-left={-25}
                shadow-camera-right={25}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <Environment preset="apartment" />
        </Physics>
    );
}
