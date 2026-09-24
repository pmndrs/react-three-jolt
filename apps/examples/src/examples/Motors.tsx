// Demo: constraint motors. Mirrors upstream JoltPhysics.js `Examples/motor.html` (a
// powered-hinge windmill + powered-slider platform) as three side-by-side rigs so the two
// motor modes are visible at once. Look at `useConstraint`'s `options.motor` (sets the mode
// once) and the `SetTargetAngularVelocity` / `SetTargetAngle` / `SetTargetPosition` calls
// below (push a live target every time the leva panel changes) - see #286.
import { Environment, Html } from '@react-three/drei';
import {
    type BodyStateRef,
    type ConstraintOptions,
    Physics,
    RigidBody,
    useConstraint
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useRef } from 'react';
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

/** A hinge in velocity mode: constant angular speed, driven by `SetTargetAngularVelocity`. */
function HingeVelocityMotor({ x, velocity }: { x: number; velocity: number }) {
    const hubRef: BodyStateRef = useRef(null);
    const armRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 0, 1],
        motor: { type: 'velocity' }
    };
    const hinge = useConstraint('hinge', hubRef, armRef, options);
    useEffect(() => {
        hinge.current?.SetTargetAngularVelocity(velocity);
    }, [hinge, velocity]);
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

/** A hinge in position mode: swings to (and holds) a target angle via `SetTargetAngle`. */
function HingePositionMotor({ x, angle }: { x: number; angle: number }) {
    const hubRef: BodyStateRef = useRef(null);
    const armRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 0, 1],
        motor: { type: 'position' }
    };
    const hinge = useConstraint('hinge', hubRef, armRef, options);
    useEffect(() => {
        hinge.current?.SetTargetAngle(angle);
    }, [hinge, angle]);
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

/** A slider in position mode: rides a rail to a target offset via `SetTargetPosition`. */
function SliderPositionMotor({ x, target }: { x: number; target: number }) {
    const railRef: BodyStateRef = useRef(null);
    const blockRef: BodyStateRef = useRef(null);
    const pos: [number, number, number] = [x, RIG_Y, 0];
    const options: ConstraintOptions = {
        point1: pos,
        axis: [0, 1, 0],
        min: -3,
        max: 3,
        motor: { type: 'position' }
    };
    const slider = useConstraint('slider', railRef, blockRef, options);
    useEffect(() => {
        slider.current?.SetTargetPosition(target);
    }, [slider, target]);
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

    const { hingeVelocity, hingeAngle, sliderPosition } = useControls('Motors', {
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

            <HingeVelocityMotor x={-8} velocity={hingeVelocity} />
            <HingePositionMotor x={0} angle={hingeAngle} />
            <SliderPositionMotor x={8} target={sliderPosition} />

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
