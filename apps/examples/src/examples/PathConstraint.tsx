// Demo: `path` constraint (#242) - a roller-coaster cart riding a CatmullRomCurve3, with a
// velocity motor pushing it along the track and a rendered TubeGeometry standing in for rail.
import { Environment } from '@react-three/drei';
import {
    type BodyStateRef,
    type PathRotationConstraintType,
    Physics,
    RigidBody,
    useConstraint
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// control points for a wavy, closed loop with real hills - deliberately not flat, so the
// rotation-constraint controls below have something to show
const TRACK_POINTS: [number, number, number][] = [
    [0, 6, 22],
    [16, 4, 15],
    [22, 12, 0],
    [16, 17, -15],
    [0, 10, -22],
    [-16, 5, -15],
    [-22, 1, 0],
    [-16, 9, 15]
];

const ROTATION_CONSTRAINT_TYPES: PathRotationConstraintType[] = [
    'free',
    'constrainAroundTangent',
    'constrainAroundNormal',
    'constrainAroundBinormal',
    'constrainToPath',
    'fullyConstrained'
];

// * Track visual ===========================================================

function Track({ curve }: { curve: THREE.CatmullRomCurve3 }) {
    return (
        <mesh castShadow receiveShadow>
            <tubeGeometry args={[curve, 300, 0.35, 12, true]} />
            <meshStandardMaterial color="#3d405b" metalness={0.4} roughness={0.5} />
        </mesh>
    );
}

// * Cart: the `path` constraint itself =====================================

function Cart({
    curve,
    railRef,
    velocity,
    rotationConstraintType
}: {
    curve: THREE.CatmullRomCurve3;
    railRef: BodyStateRef;
    velocity: number;
    rotationConstraintType: PathRotationConstraintType;
}) {
    const cartRef = useRef(null);
    const start = useMemo(() => curve.getPointAt(0), [curve]);

    const constraint = useConstraint('path', railRef, cartRef, {
        path: curve,
        closed: true,
        rotationConstraintType,
        maxFrictionForce: 4,
        motor: { type: 'velocity' }
    });

    // pushed live via `SetTargetVelocity` (same pattern as `MotorHinge` in Constraints.tsx) so
    // dragging the leva slider doesn't tear the constraint down and re-create it every frame
    useEffect(() => {
        constraint.current?.SetTargetVelocity(velocity);
    }, [constraint, velocity]);

    return (
        <RigidBody
            ref={cartRef}
            position={[start.x, start.y, start.z]}
            mass={2}
            angularDamping={0.4}
            linearDamping={0}
        >
            <mesh castShadow>
                <boxGeometry args={[1.4, 0.8, 2]} />
                <meshStandardMaterial color="#EC4E20" />
            </mesh>
            <mesh castShadow position={[0, 0.55, 0]}>
                <boxGeometry args={[1.6, 0.3, 0.3]} />
                <meshStandardMaterial color="#222222" />
            </mesh>
        </RigidBody>
    );
}

// * Scene + controls ========================================================

function PathConstraintScene({
    velocity,
    rotationConstraintType
}: {
    velocity: number;
    rotationConstraintType: PathRotationConstraintType;
}) {
    // stable identity across re-renders - `useConstraint` compares options by JSON value, but
    // there's no reason to rebuild the curve itself on every render
    const curve = useMemo(
        () =>
            new THREE.CatmullRomCurve3(
                TRACK_POINTS.map((p) => new THREE.Vector3(...p)),
                true,
                'catmullrom',
                0.5
            ),
        []
    );
    const railRef = useRef(null);

    return (
        <>
            {/* the path frame's anchor - a static body at the curve's own origin, so
            `pathPosition` can stay at its default of (0,0,0) */}
            <RigidBody ref={railRef} type="static" position={[0, 0, 0]}>
                <mesh>
                    <sphereGeometry args={[0.6, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>

            <Track curve={curve} />
            <Cart
                curve={curve}
                railRef={railRef}
                velocity={velocity}
                rotationConstraintType={rotationConstraintType}
            />

            <Floor position={[0, -8, 0]} size={200}>
                <meshStandardMaterial />
            </Floor>
        </>
    );
}

export function PathConstraint() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const { velocity, rotationConstraintType } = useControls('Path Constraint', {
        velocity: { value: 6, min: -15, max: 15, step: 0.5, label: 'motor velocity' },
        rotationConstraintType: {
            value: 'constrainAroundTangent' as PathRotationConstraintType,
            options: ROTATION_CONSTRAINT_TYPES,
            label: 'rotation constraint'
        }
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={20}
        >
            <PathConstraintScene
                velocity={velocity}
                rotationConstraintType={rotationConstraintType}
            />
            <directionalLight
                castShadow
                position={[20, 40, 20]}
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
