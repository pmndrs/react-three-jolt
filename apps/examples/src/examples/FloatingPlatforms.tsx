// Demo: kinematic platforms (vertical lifts, horizontal conveyors, a rotating disc) aimed each
// frame from useFrame via `bodyState.setKinematicTarget(position, rotation?)` - the step loop
// then drives them with the real substep dt - plus a pile of dynamic boxes and a ball spawner so
// riders can be picked up, carried, and dropped off.
import { Environment } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { type BodyState, InstancedRigidBodies, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, useControls } from 'leva';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// shared, mutated-in-place so the frame loop driving five platforms allocates nothing
const IDENTITY_QUAT = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function FloatingPlatforms() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    // Riders are woken by the platforms on their own now (a driven kinematic body has a real
    // velocity, and Jolt wakes what it touches), so `mAllowSleeping: false` is belt and braces
    // for the bumpier rides. The friction is not optional though: at Jolt's default of 0.2 a
    // rider lags behind a fast platform and slides off the back.
    const defaultBodySettings = {
        mRestitution: 0.1,
        mFriction: 0.9,
        mAllowSleeping: false
    };
    return (
        <Physics
            module={module}
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

    // ball spawner - grows an InstancedRigidBodies count and repositions only the new
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

    useFrame((state) => {
        // r3f v10's useFrame state carries timing directly (`elapsed`/`delta`) instead of a
        // THREE.Clock - see @pmndrs/scheduler's FrameTimingState.
        const t = state.elapsed * speed;

        // `setKinematicTarget` only records where the platform should be; the fixed step loop
        // re-aims it every substep with that substep's own dt, which is both smoother than
        // passing a frame delta and correct when one frame runs several steps.
        if (liftA.current) {
            liftAPos.current.set(-16, 10 + Math.sin(t) * amplitude, -4);
            liftA.current.setKinematicTarget(liftAPos.current, IDENTITY_QUAT);
        }
        if (liftB.current) {
            liftBPos.current.set(16, 10 + Math.sin(t + Math.PI) * amplitude, 4);
            liftB.current.setKinematicTarget(liftBPos.current, IDENTITY_QUAT);
        }
        if (conveyorA.current) {
            conveyorAPos.current.set(Math.sin(t) * amplitude, 1.5, -16);
            conveyorA.current.setKinematicTarget(conveyorAPos.current, IDENTITY_QUAT);
        }
        if (conveyorB.current) {
            conveyorBPos.current.set(Math.sin(t + Math.PI / 2) * amplitude, 1.5, 16);
            conveyorB.current.setKinematicTarget(conveyorBPos.current, IDENTITY_QUAT);
        }
        if (disc.current) {
            discRotation.current.setFromAxisAngle(Y_AXIS, t);
            disc.current.setKinematicTarget(discPos.current, discRotation.current);
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
            <InstancedRigidBodies
                ref={boxesRef}
                count={40}
                position={[0, 24, 0]}
                color="#F2CC8F"
                rotation={[0, 0, 0]}
            >
                <boxGeometry args={[1, 1, 1]} />
                <meshStandardMaterial color="#F2CC8F" />
            </InstancedRigidBodies>

            {/* Ball spawner, grown 20 at a time from the leva panel. Mounted at count 0 and
                grown in place (#194) - it used to be held back until the first click, because
                InstancedRigidBodies threw with no instances. */}
            <InstancedRigidBodies
                ref={ballsRef}
                count={ballCount}
                position={[0, 24, 0]}
                color="#FF0000"
                rotation={[0, 0, 0]}
            >
                <sphereGeometry args={[0.6, 16, 16]} />
                <meshStandardMaterial color="#FF0000" />
            </InstancedRigidBodies>

            <Floor position={[0, -1, 0]} size={90}>
                <meshStandardMaterial />
            </Floor>
        </>
    );
}
