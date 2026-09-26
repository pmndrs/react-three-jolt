// Demo: every constraint type useConstraint / constraintSystem.addConstraint supports.
// Closes #91.
import { Environment, Html } from '@react-three/drei';
import {
    type BodyStateRef,
    type ConstraintOptions,
    type ConstraintType,
    Physics,
    RigidBody,
    useConstraint
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, folder, useControls } from 'leva';
import { useEffect, useRef, useState } from 'react';
import { useDemo } from '../App';

// row layout ------------------------------------------------------------
const ROW_Y = 14;
const ROW_Z = 0;
const ARM_DROP = 3;

// * Small building blocks =================================================

/** Mounts (and, on unmount, tears down) a single constraint. Toggling the parent's
 * `enabled` state mounts/unmounts this component, which is what exercises `useConstraint`'s
 * cleanup path (remove/re-add) that the leva "enable" checkboxes are for. */
function JointEffect<T extends ConstraintType>({
    type,
    body1,
    body2,
    options
}: {
    type: T;
    body1: BodyStateRef;
    body2: BodyStateRef;
    options?: ConstraintOptions;
}) {
    useConstraint(type, body1, body2, options);
    return null;
}

/** A hinge whose motor target velocity is pushed live (via `SetTargetAngularVelocity`)
 * instead of round-tripping through `useConstraint`'s options, so dragging the leva slider
 * doesn't tear the joint down and recreate it every frame. */
function MotorHinge({
    body1,
    body2,
    options,
    velocity
}: {
    body1: BodyStateRef;
    body2: BodyStateRef;
    options?: ConstraintOptions;
    velocity: number;
}) {
    const hinge = useConstraint('hinge', body1, body2, options);
    useEffect(() => {
        hinge.current?.SetTargetAngularVelocity(velocity);
    }, [hinge, velocity]);
    return null;
}

/** A slider whose motor target *position* is pushed live via `SetTargetPosition` - the
 * position-mode counterpart to `MotorHinge`'s velocity mode. Used by the sliding door. */
function MotorSlider({
    body1,
    body2,
    options,
    target
}: {
    body1: BodyStateRef;
    body2: BodyStateRef;
    options?: ConstraintOptions;
    target: number;
}) {
    const slider = useConstraint('slider', body1, body2, options);
    useEffect(() => {
        slider.current?.SetTargetPosition(target);
    }, [slider, target]);
    return null;
}

function Label({ position, children }: { position: [number, number, number]; children: string }) {
    return (
        <Html position={position} center distanceFactor={20} zIndexRange={[0, 0]}>
            <div
                style={{
                    color: 'white',
                    fontFamily: 'sans-serif',
                    fontSize: 14,
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

// * Row demos, one per constraint type ====================================

function RowFixed({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - 2, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>fixed</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.2}>
                <mesh>
                    <boxGeometry args={[1.4, 1.4, 1.4]} />
                    <meshStandardMaterial color="#7F055F" />
                </mesh>
            </RigidBody>
            {enabled && <JointEffect type="fixed" body1={anchorRef} body2={bodyRef} />}
        </>
    );
}

function RowPoint({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>point</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.1}>
                <mesh>
                    <sphereGeometry args={[0.9, 16, 16]} />
                    <meshStandardMaterial color="#FF9505" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="point"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ point1: pos }}
                />
            )}
        </>
    );
}

function RowHinge({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>hinge</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.1}>
                <mesh>
                    <boxGeometry args={[1.2, 1.6, 1.2]} />
                    <meshStandardMaterial color="#45F0DF" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="hinge"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ point1: pos, axis: [0, 0, 1] }}
                />
            )}
        </>
    );
}

function RowHingeMotor({
    x,
    enabled,
    velocity
}: {
    x: number;
    enabled: boolean;
    velocity: number;
}) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>hinge (motor)</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1}>
                <mesh>
                    <boxGeometry args={[2.4, 0.4, 0.4]} />
                    <meshStandardMaterial color="#EC4E20" />
                </mesh>
            </RigidBody>
            {enabled && (
                <MotorHinge
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ point1: pos, axis: [0, 0, 1], motor: { type: 'velocity' } }}
                    velocity={velocity}
                />
            )}
        </>
    );
}

function RowSlider({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 5.5, ROW_Z]}>slider</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <boxGeometry args={[0.3, 8, 0.3]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={pos} mass={1} linearDamping={0.2}>
                <mesh>
                    <boxGeometry args={[1.6, 0.8, 1.6]} />
                    <meshStandardMaterial color="#F2CC8F" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="slider"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ point1: pos, axis: [0, 1, 0], min: -3, max: 3 }}
                />
            )}
        </>
    );
}

function RowDistance({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>distance</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={pos} mass={1}>
                <mesh>
                    <sphereGeometry args={[0.7, 16, 16]} />
                    <meshStandardMaterial color="#69DDFF" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="distance"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ min: 0, max: 3 }}
                />
            )}
        </>
    );
}

function RowCone({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>cone</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.1}>
                <mesh>
                    <sphereGeometry args={[0.9, 16, 16]} />
                    <meshStandardMaterial color="#8E443D" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="cone"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{ point1: pos, twistAxis: [0, 1, 0], angle: Math.PI / 2 }}
                />
            )}
        </>
    );
}

function RowSwingTwist({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>swingTwist</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.1}>
                <mesh>
                    <boxGeometry args={[1.2, 1.2, 1.2]} />
                    <meshStandardMaterial color="#320A28" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="swingTwist"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{
                        position: pos,
                        twistAxis: [0, 1, 0],
                        planeAxis: [1, 0, 0],
                        normalConeAngle: Math.PI / 6,
                        planeConesAngle: Math.PI / 6,
                        twistMin: -Math.PI / 6,
                        twistMax: Math.PI / 6
                    }}
                />
            )}
        </>
    );
}

function RowSixDOF({ x, enabled }: { x: number; enabled: boolean }) {
    const anchorRef = useRef(null);
    const bodyRef = useRef(null);
    const pos: [number, number, number] = [x, ROW_Y, ROW_Z];
    const bodyPos: [number, number, number] = [x, ROW_Y - ARM_DROP, ROW_Z];
    return (
        <>
            <Label position={[x, ROW_Y + 3, ROW_Z]}>sixDOF</Label>
            <RigidBody ref={anchorRef} type="static" position={pos}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={bodyRef} position={bodyPos} mass={1} angularDamping={0.1}>
                <mesh>
                    <boxGeometry args={[1.2, 1.2, 1.2]} />
                    <meshStandardMaterial color="#ff521b" />
                </mesh>
            </RigidBody>
            {enabled && (
                <JointEffect
                    type="sixDOF"
                    body1={anchorRef}
                    body2={bodyRef}
                    options={{
                        position: pos,
                        fixedTranslationAxis: ['x', 'y', 'z'],
                        limitedRotationAxis: ['x'],
                        limits: { minAngleX: -Math.PI / 4, maxAngleX: Math.PI / 4 }
                    }}
                />
            )}
        </>
    );
}

// * Set pieces =============================================================

const CHAIN_LINKS = 6;
const CHAIN_ANCHOR: [number, number, number] = [-32, 24, -18];
// per-link (dx, dy, dz) offset. A small horizontal tilt means the chain starts away from
// vertical equilibrium so it visibly swings once physics starts, instead of hanging inert.
const CHAIN_SEGMENT = { dx: 1.1, dy: -2.2, dz: 0 };

function computeChainPoints() {
    const points: [number, number, number][] = [CHAIN_ANCHOR];
    for (let i = 0; i < CHAIN_LINKS; i++) {
        const prev = points[i];
        points.push([
            prev[0] + CHAIN_SEGMENT.dx,
            prev[1] + CHAIN_SEGMENT.dy,
            prev[2] + CHAIN_SEGMENT.dz
        ]);
    }
    return points;
}
const CHAIN_POINTS = computeChainPoints();

function Chain({ enabled }: { enabled: boolean }) {
    // one ref per link, plus the static anchor
    const chainAnchorRef = useRef(null);
    const refs = [
        useRef(null),
        useRef(null),
        useRef(null),
        useRef(null),
        useRef(null),
        useRef(null)
    ];
    const linkCenters: [number, number, number][] = [];
    for (let i = 0; i < CHAIN_LINKS; i++) {
        const a = CHAIN_POINTS[i];
        const b = CHAIN_POINTS[i + 1];
        linkCenters.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    }

    return (
        <>
            <Label position={[CHAIN_ANCHOR[0], CHAIN_ANCHOR[1] + 3, CHAIN_ANCHOR[2]]}>
                hinge chain (x6)
            </Label>
            <RigidBody ref={chainAnchorRef} type="static" position={CHAIN_ANCHOR}>
                <mesh>
                    <sphereGeometry args={[0.5, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            {linkCenters.map((center, i) => (
                <RigidBody
                    key={i}
                    ref={refs[i]}
                    position={center}
                    mass={1}
                    linearDamping={0.05}
                    angularDamping={0.05}
                >
                    <mesh>
                        <boxGeometry args={[0.7, 1.8, 0.7]} />
                        <meshStandardMaterial color={i % 2 === 0 ? '#3d405b' : '#81b29a'} />
                    </mesh>
                </RigidBody>
            ))}
            {enabled &&
                linkCenters.map((_, i) => {
                    const anchorRef = i === 0 ? chainAnchorRef : refs[i - 1];
                    return (
                        <JointEffect
                            key={i}
                            type="hinge"
                            body1={anchorRef}
                            body2={refs[i]}
                            options={{ point1: CHAIN_POINTS[i], axis: [0, 0, 1] }}
                        />
                    );
                })}
        </>
    );
}

const WINDMILL_HUB: [number, number, number] = [30, 16, -14];

function Windmill({ enabled, velocity }: { enabled: boolean; velocity: number }) {
    const hubRef = useRef(null);
    const rotorRef = useRef(null);
    return (
        <>
            <Label position={[WINDMILL_HUB[0], WINDMILL_HUB[1] + 6, WINDMILL_HUB[2]]}>
                motorised windmill
            </Label>
            <RigidBody type="static" position={[WINDMILL_HUB[0], 8, WINDMILL_HUB[2]]}>
                <mesh>
                    <boxGeometry args={[0.6, 16, 0.6]} />
                    <meshStandardMaterial color="#3d405b" />
                </mesh>
            </RigidBody>
            <RigidBody ref={hubRef} type="static" position={WINDMILL_HUB}>
                <mesh>
                    <sphereGeometry args={[0.6, 12, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={rotorRef} position={WINDMILL_HUB} mass={2}>
                <mesh>
                    <boxGeometry args={[9, 0.4, 0.4]} />
                    <meshStandardMaterial color="#f0544f" />
                </mesh>
            </RigidBody>
            {enabled && (
                <MotorHinge
                    body1={hubRef}
                    body2={rotorRef}
                    options={{ point1: WINDMILL_HUB, axis: [0, 0, 1], motor: { type: 'velocity' } }}
                    velocity={velocity}
                />
            )}
        </>
    );
}

const DOOR_ANCHOR: [number, number, number] = [40, 8, -14];
const DOOR_MAX = 4;

function SliderDoor({ enabled, target }: { enabled: boolean; target: number }) {
    const frameRef = useRef(null);
    const doorRef = useRef(null);
    return (
        <>
            <Label position={[DOOR_ANCHOR[0], DOOR_ANCHOR[1] + 4, DOOR_ANCHOR[2]]}>
                slider door
            </Label>
            <RigidBody
                type="static"
                position={[DOOR_ANCHOR[0] - 2.2, DOOR_ANCHOR[1], DOOR_ANCHOR[2]]}
            >
                <mesh>
                    <boxGeometry args={[0.4, 5, 0.4]} />
                    <meshStandardMaterial color="#3d405b" />
                </mesh>
            </RigidBody>
            <RigidBody ref={frameRef} type="static" position={DOOR_ANCHOR}>
                <mesh>
                    <boxGeometry args={[0.3, 5, 0.3]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>
            <RigidBody ref={doorRef} position={DOOR_ANCHOR} mass={1}>
                <mesh>
                    <boxGeometry args={[3, 4, 0.2]} />
                    <meshStandardMaterial color="#81b29a" />
                </mesh>
            </RigidBody>
            {enabled && (
                <MotorSlider
                    body1={frameRef}
                    body2={doorRef}
                    options={{
                        point1: DOOR_ANCHOR,
                        axis: [1, 0, 0],
                        min: 0,
                        max: DOOR_MAX,
                        motor: { type: 'position' }
                    }}
                    target={target}
                />
            )}
        </>
    );
}

// * Scene + controls ========================================================

interface EnabledMap {
    fixed: boolean;
    point: boolean;
    hinge: boolean;
    hingeMotor: boolean;
    slider: boolean;
    distance: boolean;
    cone: boolean;
    swingTwist: boolean;
    sixDOF: boolean;
    chain: boolean;
    windmill: boolean;
    door: boolean;
}

interface ConstraintsSceneProps {
    enabled: EnabledMap;
    motorVelocity: number;
    doorTarget: number;
}

function ConstraintsScene({ enabled, motorVelocity, doorTarget }: ConstraintsSceneProps) {
    return (
        <>
            <RowFixed x={-24} enabled={enabled.fixed} />
            <RowPoint x={-18} enabled={enabled.point} />
            <RowHinge x={-12} enabled={enabled.hinge} />
            <RowHingeMotor x={-6} enabled={enabled.hingeMotor} velocity={motorVelocity} />
            <RowSlider x={0} enabled={enabled.slider} />
            <RowDistance x={6} enabled={enabled.distance} />
            <RowCone x={12} enabled={enabled.cone} />
            <RowSwingTwist x={18} enabled={enabled.swingTwist} />
            <RowSixDOF x={24} enabled={enabled.sixDOF} />

            <Chain enabled={enabled.chain} />
            <Windmill enabled={enabled.windmill} velocity={motorVelocity} />
            <SliderDoor enabled={enabled.door} target={doorTarget} />

            <Floor position={[0, 0, -10]} size={200}>
                <meshStandardMaterial />
            </Floor>
        </>
    );
}

export function Constraints() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const [resetKey, setResetKey] = useState(0);

    const { motorVelocity, doorTarget } = useControls('Motors', {
        motorVelocity: { value: 2, min: -10, max: 10, step: 0.5, label: 'motor velocity' },
        doorTarget: { value: 0, min: 0, max: DOOR_MAX, step: 0.5, label: 'door target' }
    });

    const enabled = useControls('Enable / Disable', {
        row: folder({
            fixed: { value: true },
            point: { value: true },
            hinge: { value: true },
            hingeMotor: { value: true, label: 'hinge (motor)' },
            slider: { value: true },
            distance: { value: true },
            cone: { value: true },
            swingTwist: { value: true },
            sixDOF: { value: true }
        }),
        setPieces: folder({
            chain: { value: true },
            windmill: { value: true },
            door: { value: true, label: 'door' }
        })
    });

    useControls({
        'Reset Scene': button(() => setResetKey((k) => k + 1))
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={`${physicsKey}-${resetKey}`}
            interpolate={interpolate}
            debug={debug}
            gravity={20}
        >
            <ConstraintsScene
                enabled={enabled as EnabledMap}
                motorVelocity={motorVelocity}
                doorTarget={doorTarget}
            />
            <directionalLight
                castShadow
                position={[10, 40, 30]}
                shadow-camera-bottom={-60}
                shadow-camera-top={60}
                shadow-camera-left={-60}
                shadow-camera-right={60}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <Environment preset="apartment" />
        </Physics>
    );
}
