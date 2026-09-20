// Demo: kinematic platforms (vertical lifts, horizontal conveyors, a rotating disc) driven each
// frame from useFrame via `bodyState.moveKinematic(position, rotation, delta)`, plus a pile of
// dynamic boxes and a ball spawner so riders can be picked up, carried, and dropped off.
import { Environment } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type BodyState, InstancedRigidBodyMesh, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt-addons';
import { button, useControls } from 'leva';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// shared, mutated-in-place so the frame loop driving five platforms allocates nothing
const IDENTITY_QUAT = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function FloatingPlatforms() {
    const { debug, paused, interpolate, physicsKey } = useDemo();
    // keep riders awake and grippy so kinematic platforms actually carry them instead of
    // letting them sleep through the ride or slide straight off - see report for details.
    const defaultBodySettings = {
        mRestitution: 0.1,
        mFriction: 0.9,
        mAllowSleeping: false
    };
    return (
        <Physics
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
            defaultBodySettings={defaultBodySettings}
        >
            <FloatingPlatformsInner />
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

function FloatingPlatformsInner() {
    // platform bodies, driven every frame from useFrame below
    const liftA = useRef<BodyState | undefined>(undefined);
    const liftB = useRef<BodyState | undefined>(undefined);
    const conveyorA = useRef<BodyState | undefined>(undefined);
    const conveyorB = useRef<BodyState | undefined>(undefined);
    const disc = useRef<BodyState | undefined>(undefined);

    // scratch objects reused every frame, one per platform, so the kinematic drive is
    // allocation free (see body-state.ts pose-cache comments for the same convention)
    const liftAPos = useRef(new THREE.Vector3(-16, 10, -4));
    const liftBPos = useRef(new THREE.Vector3(16, 10, 4));
    const conveyorAPos = useRef(new THREE.Vector3(0, 1.5, -16));
    const conveyorBPos = useRef(new THREE.Vector3(0, 1.5, 16));
    const discPos = useRef(new THREE.Vector3(0, 1.5, 0));
    const discRotation = useRef(new THREE.Quaternion());

    // dynamic box pile
    const boxesRef = useRef<BodyState[]>(null);

    // ball spawner - grows an InstancedRigidBodyMesh count and repositions only the new
    // instances, same pattern CubeHeap.tsx uses for its fountain
    const ballsRef = useRef<BodyState[]>(null);
    const previousBallCount = useRef(0);
    const [ballCount, setBallCount] = useState(0);

    const { speed, amplitude } = useControls('Floating Platforms', {
        speed: { value: 1, min: 0.1, max: 4, step: 0.1 },
        amplitude: { value: 5, min: 1, max: 10, step: 0.5 },
        'spawn 20': button(() => setBallCount((count) => count + 20))
    });

    // reposition newly spawned balls above the platforms so they drop in and get carried
    useEffect(() => {
        if (!ballsRef.current) return;
        for (let i = previousBallCount.current; i < ballsRef.current.length; i++) {
            ballsRef.current[i].position = new THREE.Vector3(
                Math.random() * 30 - 15,
                20 + Math.random() * 5,
                Math.random() * 30 - 15
            );
        }
        previousBallCount.current = ballCount;
    }, [ballCount]);

    useFrame((state, delta) => {
        // r3f v10's useFrame state carries timing directly (`elapsed`/`delta`) instead of a
        // THREE.Clock - see @pmndrs/scheduler's FrameTimingState.
        const t = state.elapsed * speed;

        if (liftA.current) {
            liftAPos.current.set(-16, 10 + Math.sin(t) * amplitude, -4);
            liftA.current.moveKinematic(liftAPos.current, IDENTITY_QUAT, delta);
        }
        if (liftB.current) {
            liftBPos.current.set(16, 10 + Math.sin(t + Math.PI) * amplitude, 4);
            liftB.current.moveKinematic(liftBPos.current, IDENTITY_QUAT, delta);
        }
        if (conveyorA.current) {
            conveyorAPos.current.set(Math.sin(t) * amplitude, 1.5, -16);
            conveyorA.current.moveKinematic(conveyorAPos.current, IDENTITY_QUAT, delta);
        }
        if (conveyorB.current) {
            conveyorBPos.current.set(Math.sin(t + Math.PI / 2) * amplitude, 1.5, 16);
            conveyorB.current.moveKinematic(conveyorBPos.current, IDENTITY_QUAT, delta);
        }
        if (disc.current) {
            discRotation.current.setFromAxisAngle(Y_AXIS, t);
            disc.current.moveKinematic(discPos.current, discRotation.current, delta);
        }
    });

    return (
        <>
            {/* Vertical lifts */}
            <RigidBody ref={liftA} type="kinematic" position={[-16, 10, -4]} onlyInitialize>
                <mesh>
                    <boxGeometry args={[6, 1, 6]} />
                    <meshStandardMaterial color="#087E8B" />
                </mesh>
            </RigidBody>
            <RigidBody ref={liftB} type="kinematic" position={[16, 10, 4]} onlyInitialize>
                <mesh>
                    <boxGeometry args={[6, 1, 6]} />
                    <meshStandardMaterial color="#3685B5" />
                </mesh>
            </RigidBody>

            {/* Horizontal conveyors */}
            <RigidBody ref={conveyorA} type="kinematic" position={[0, 1.5, -16]} onlyInitialize>
                <mesh>
                    <boxGeometry args={[10, 1, 4]} />
                    <meshStandardMaterial color="#D64933" />
                </mesh>
            </RigidBody>
            <RigidBody ref={conveyorB} type="kinematic" position={[0, 1.5, 16]} onlyInitialize>
                <mesh>
                    <boxGeometry args={[10, 1, 4]} />
                    <meshStandardMaterial color="#F0A202" />
                </mesh>
            </RigidBody>

            {/* Rotating disc */}
            <RigidBody ref={disc} type="kinematic" position={[0, 1.5, 0]} onlyInitialize>
                <mesh>
                    <cylinderGeometry args={[6, 6, 1, 32]} />
                    <meshStandardMaterial color="#7E52A0" />
                </mesh>
            </RigidBody>

            {/* Pile of dynamic boxes, dropped above the platforms */}
            <InstancedRigidBodyMesh
                ref={boxesRef}
                count={40}
                position={[0, 24, 0]}
                color="#F2CC8F"
                rotation={[0, 0, 0]}
            >
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#F2CC8F" />
            </InstancedRigidBodyMesh>

            {/* Ball spawner, grown 20 at a time from the leva panel. InstancedRigidBodyMesh
                assumes at least one instance (it unconditionally touches instanceColor), so it
                only mounts once the first "spawn 20" click has happened. */}
            {ballCount > 0 && (
                <InstancedRigidBodyMesh
                    ref={ballsRef}
                    count={ballCount}
                    position={[0, 24, 0]}
                    color="#FF0000"
                    rotation={[0, 0, 0]}
                >
                    <sphereGeometry args={[0.6, 16, 16]} />
                    <meshStandardMaterial color="#FF0000" />
                </InstancedRigidBodyMesh>
            )}

            <Floor position={[0, -1, 0]} size={90}>
                <meshStandardMaterial />
            </Floor>
        </>
    );
}
