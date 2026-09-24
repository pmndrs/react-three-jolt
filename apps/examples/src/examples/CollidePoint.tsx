import { Environment, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { BodyState, Physics, RigidBody, useCollidePoint } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import type { MutableRefObject } from 'react';
import { useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Issue #290 / #248: `useCollidePoint(point?, type?)` creates a `PointCollider` - "which bodies
// contain this single point, right now" (Jolt's `NarrowPhaseQuery.CollidePoint`). A probe follows
// the mouse across the floor; every overlapping sphere it is currently inside lights up.
// `collider.point` is written in place every frame - no per-frame allocation, see
// docs/api/queries.mdx#collidepoint - and `setCollector('all')` (passed as the hook's second
// arg) collects every body under the point instead of just the closest one.

const PROBE_Y = 1.2;

type Target = { id: number; position: [number, number, number]; radius: number; color: string };

// four overlapping spheres clustered near the origin - the middle of the cluster is inside all
// four at once, the edges inside one or two, and the point is inside none of them out on the
// open floor
const TARGETS: Target[] = [
    { id: 0, position: [-1.3, PROBE_Y, 0], radius: 1.6, color: '#4fb0ff' },
    { id: 1, position: [1.3, PROBE_Y, 0], radius: 1.6, color: '#4fff9e' },
    { id: 2, position: [0, PROBE_Y, -1.3], radius: 1.6, color: '#ff8a4f' },
    { id: 3, position: [0, PROBE_Y, 1.3], radius: 1.6, color: '#c084fc' }
];

export function CollidePoint() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const probeRef = useRef<THREE.Mesh>(null);
    // the current cast's hit set, shared with every <Target> through a ref rather than React
    // state - the probe casts every frame, and a ref lets each <Target> read the result in its
    // own useFrame without forcing the whole tree to re-render at 60fps
    const hitHandles = useRef<Set<number>>(new Set());
    const collider = useCollidePoint(undefined, 'all');

    useFrame(() => {
        if (!probeRef.current) return;
        // mutates the collider's own scratch point in place - see the doc note above
        collider.point = probeRef.current.position;
        const result = collider.cast();
        const next = new Set<number>();
        if (result) {
            for (const hit of Array.isArray(result) ? result : [result]) next.add(hit.bodyHandle);
        }
        hitHandles.current = next;
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
        >
            <JoltMemoryRegistrar />
            <Floor
                position={[0, 0, 0]}
                size={20}
                onPointerMove={(e) => probeRef.current?.position.set(e.point.x, PROBE_Y, e.point.z)}
            >
                <meshStandardMaterial color="#20232a" />
            </Floor>

            {TARGETS.map((target) => (
                <Target key={target.id} {...target} hitHandles={hitHandles} />
            ))}

            <mesh ref={probeRef} position={[0, PROBE_Y, 0]}>
                <sphereGeometry args={[0.18, 16, 16]} />
                <meshStandardMaterial color="white" emissive="#ffffff" emissiveIntensity={0.5} />
            </mesh>

            <Html position={[0, 4.6, 0]} center>
                <div
                    style={{
                        color: 'white',
                        fontFamily: 'sans-serif',
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        textShadow: '0 1px 3px rgba(0,0,0,0.8)'
                    }}
                >
                    move the mouse over the floor — every body the point is inside lights up
                </div>
            </Html>

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

/** A static, overlapping sphere. `type="static"` lets several sit on top of each other without
 * pushing each other apart - only a dynamic/kinematic body would resolve the overlap. */
function Target({
    position,
    radius,
    color,
    hitHandles
}: Target & { hitHandles: MutableRefObject<Set<number>> }) {
    const bodyRef = useRef<BodyState>(null);
    const materialRef = useRef<THREE.MeshStandardMaterial>(null);

    useFrame(() => {
        if (!bodyRef.current || !materialRef.current) return;
        const hit = hitHandles.current.has(bodyRef.current.handle);
        materialRef.current.color.set(hit ? '#ffe066' : color);
        materialRef.current.opacity = hit ? 0.9 : 0.4;
    });

    return (
        <RigidBody ref={bodyRef} type="static" position={position}>
            <mesh>
                <sphereGeometry args={[radius, 32, 32]} />
                <meshStandardMaterial ref={materialRef} color={color} transparent opacity={0.4} />
            </mesh>
        </RigidBody>
    );
}
