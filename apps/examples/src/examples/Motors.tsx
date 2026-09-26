// Demo: constraint motors. Mirrors upstream JoltPhysics.js `Examples/motor.html` (a
// powered-hinge windmill + powered-slider platform) as three side-by-side rigs so the two
// motor modes are visible at once. Every rig sweeps its own target on a sine wave every frame
// via `ConstraintSystem.setHingeTargetAngle`/`setHingeTargetAngularVelocity`/
// `setSliderTargetPosition` (issue #299: the raw `HingeConstraint.SetTargetAngle`/
// `SliderConstraint.SetTargetPosition` this used to call directly never activates a body that
// fell asleep at its previous target, which is why two of the three rigs used to look dead).
// Flip "auto sweep" off in the leva panel to drive a rig from its slider instead - see #299.
import { Environment, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import {
    type BodyStateRef,
    type ConstraintOptions,
    Physics,
    RigidBody,
    useConstraint,
    useJolt
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useRef } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const RIG_Y = 6;

function Label({ position, children }: { position: [number, number, number]; children: string }) {
    return (
        <Html position={position} center distanceFactor={16} zIndexRange={[0, 0]}>
            <div
                style={{
                    color: 'white',
                    fontFamily: 'sans-serif',
                    fontSize: 13,
                    fontWeight: 'bold',
                    textShadow: '0 0 4px black, 0 0 4px black',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none'
                }}
            >
                {children}
            </div>
        </Html>
    );
}

/** A hinge in velocity mode: constant angular speed, driven by `setHingeTargetAngularVelocity`. */
function HingeVelocityMotor({ x, auto, velocity }: { x: number; auto: boolean; velocity: number }) {
    const { physicsSystem } = useJolt();
    const hubRef: BodyStateRef = useRef(null);
    const armRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 0, 1],
        motor: { type: 'velocity', velocity: 0, maxTorque: 4000 }
    };
    const hinge = useConstraint('hinge', hubRef, armRef, options);
    useFrame(({ elapsed }) => {
        if (!hinge.current) return;
        // sweeps from -6 to 6 rad/s and back, reversing direction along the way, so the rig
        // never just sits at a single speed even before anyone touches the panel
        const target = auto ? Math.sin(elapsed * 0.5) * 6 : velocity;
        physicsSystem.constraintSystem.setHingeTargetAngularVelocity(hinge.current, target);
    });
    return (
        <>
            <Label position={[x, RIG_Y + 4, 0]}>hinge · velocity</Label>
            <RigidBody ref={hubRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={armRef} position={pos} mass={1}>
                <mesh>
                    <boxGeometry args={[5, 0.4, 0.4]} />
                    <meshStandardMaterial color="#ef476f" />
                </mesh>
            </RigidBody>
        </>
    );
}

/** A hinge in position mode: swings to (and holds) a target angle via `setHingeTargetAngle`. */
function HingePositionMotor({ x, auto, angle }: { x: number; auto: boolean; angle: number }) {
    const { physicsSystem } = useJolt();
    const hubRef: BodyStateRef = useRef(null);
    const armRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 0, 1],
        // a stiffer-than-default spring (see ConstraintSpringOptions) so the arm actually
        // holds its target against gravity instead of settling into a visible sag
        motor: {
            type: 'position',
            target: 0,
            maxTorque: 4000,
            spring: { strength: 12, damping: 1 }
        }
    };
    const hinge = useConstraint('hinge', hubRef, armRef, options);
    useFrame(({ elapsed }) => {
        if (!hinge.current) return;
        const target = auto ? Math.sin(elapsed * 0.6) * 2.2 : angle;
        physicsSystem.constraintSystem.setHingeTargetAngle(hinge.current, target);
    });
    return (
        <>
            <Label position={[x, RIG_Y + 4, 0]}>hinge · position</Label>
            <RigidBody ref={hubRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={armRef} position={pos} mass={1}>
                <mesh>
                    <boxGeometry args={[5, 0.4, 0.4]} />
                    <meshStandardMaterial color="#ffd166" />
                </mesh>
            </RigidBody>
        </>
    );
}

/** A slider in position mode: rides a rail to a target offset via `setSliderTargetPosition`. */
function SliderPositionMotor({ x, auto, target }: { x: number; auto: boolean; target: number }) {
    const { physicsSystem } = useJolt();
    const railRef: BodyStateRef = useRef(null);
    const blockRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 1, 0],
        min: -3,
        max: 3,
        motor: {
            type: 'position',
            target: 0,
            maxForce: 4000,
            spring: { strength: 12, damping: 1 }
        }
    };
    const slider = useConstraint('slider', railRef, blockRef, options);
    useFrame(({ elapsed }) => {
        if (!slider.current) return;
        const value = auto ? Math.sin(elapsed * 0.8) * 2.5 : target;
        physicsSystem.constraintSystem.setSliderTargetPosition(slider.current, value);
    });
    return (
        <>
            <Label position={[x, RIG_Y + 4.5, 0]}>slider · position</Label>
            <RigidBody ref={railRef} type="static" position={pos}>
                <mesh>
                    <boxGeometry args={[0.3, 7, 0.3]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={blockRef} position={pos} mass={1} linearDamping={0.2}>
                <mesh>
                    <boxGeometry args={[1.6, 0.9, 1.6]} />
                    <meshStandardMaterial color="#06d6a0" />
                </mesh>
            </RigidBody>
        </>
    );
}

export function Motors() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const { auto, hingeVelocity, hingeAngle, sliderPosition } = useControls('Motors', {
        auto: { value: true, label: 'auto sweep' },
        hingeVelocity: { value: -3, min: -10, max: 10, step: 0.5, label: 'hinge velocity (rad/s)' },
        hingeAngle: { value: 0.9, min: -3.1, max: 3.1, step: 0.1, label: 'hinge angle (rad)' },
        sliderPosition: { value: 2, min: -3, max: 3, step: 0.25, label: 'slider position (m)' }
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={60}>
                <meshStandardMaterial />
            </Floor>

            <HingeVelocityMotor x={-8} auto={auto} velocity={hingeVelocity} />
            <HingePositionMotor x={0} auto={auto} angle={hingeAngle} />
            <SliderPositionMotor x={8} auto={auto} target={sliderPosition} />

            <directionalLight
                castShadow
                position={[10, 15, 10]}
                shadow-camera-bottom={-20}
                shadow-camera-top={20}
                shadow-camera-left={-20}
                shadow-camera-right={20}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <Environment preset="apartment" />
        </Physics>
    );
}
