import { Environment } from '@react-three/drei';
import { Heightfield, Physics, RigidBody } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
//import { CameraRig } from './lib/components/CameraRig';
import {
    Vehicle,
    type VehicleEngineState,
    type VehicleSettings,
    type VehicleSkidEvent
} from '@react-three/jolt/controllers';
import { folder, useControls } from 'leva';
import { useCallback, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// the typed settings the vehicle is built from (issue #10): chassis, engine and wheels
const vehicleSettings: VehicleSettings = {
    type: 'fourWheel',
    vehicleWidth: 1.8,
    vehicleHeight: 0.4,
    vehicleLength: 4,
    vehicleMass: 1500,
    maxEngineTorque: 500,
    fourWheelDrive: true,
    antiRollbar: true,
    wheels: {
        radius: 0.5,
        width: 0.3,
        suspensionMinLength: 0.3,
        suspensionMaxLength: 0.5
    }
};

export function FourWheelDemo() {
    //const controllerRef = useRef(null);

    //const options = useConst({ inverted: { y: true } });
    //useGamepadForCameraControls('look', controls, options);
    const { module } = useDemo();

    // body settings so shapes bounce
    const defaultBodySettings = {
        mRestitution: 0
    };

    return (
        <Physics module={module} gravity={25} defaultBodySettings={defaultBodySettings}>
            <JoltMemoryRegistrar />
            <Car />
            <RigidBody
                position={[0, 2, 0]}
                rotation={[THREE.MathUtils.degToRad(10), 0, 0]}
                type="static"
            >
                <mesh>
                    <boxGeometry args={[30, 0.3, 30]} />
                    <meshStandardMaterial color="#E2C2C6" />
                </mesh>
            </RigidBody>
            <Heightfield
                position={[0, 0, 0]}
                url="heightmaps/wp1024.png"
                size={256}
                width={512}
                height={512}
            />

            <Floor size={150} position={[0, 0, 0]} />
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

/**
 * The vehicle, plus a leva panel for the "secondary physics" of issue #41: the presentational
 * layer that sits on top of the constraint. Every knob is live - the manager re-tunes itself
 * instead of rebuilding the vehicle - so what each one does is visible while driving.
 */
function Car() {
    const {
        bodyRollEnabled,
        maxAngle,
        maxPitchAngle,
        referenceAcceleration,
        stiffness,
        damping,
        smoothingEnabled,
        suspension,
        steering,
        skidEnabled,
        longitudinalSlip,
        lateralSlip
    } = useControls('Secondary physics (#41)', {
        'Body roll': folder({
            bodyRollEnabled: { value: true, label: 'enabled' },
            maxAngle: { value: 0.12, min: 0, max: 0.6, step: 0.01, label: 'max roll (rad)' },
            maxPitchAngle: { value: 0.07, min: 0, max: 0.6, step: 0.01, label: 'max pitch (rad)' },
            referenceAcceleration: {
                value: 9.81,
                min: 1,
                max: 30,
                step: 0.5,
                label: 'full at m/s²'
            },
            stiffness: { value: 120, min: 10, max: 400, step: 5 },
            damping: { value: 20, min: 1, max: 60, step: 1 }
        }),
        'Wheel smoothing': folder({
            smoothingEnabled: { value: true, label: 'enabled' },
            suspension: { value: 0.04, min: 0, max: 0.4, step: 0.005, label: 'suspension (s)' },
            steering: { value: 0.05, min: 0, max: 0.4, step: 0.005, label: 'steering (s)' }
        }),
        Skid: folder({
            skidEnabled: { value: true, label: 'enabled' },
            longitudinalSlip: { value: 1.5, min: 0.1, max: 10, step: 0.1, label: 'slip ratio' },
            lateralSlip: { value: 0.25, min: 0.02, max: 1, step: 0.01, label: 'slip angle (rad)' }
        })
    });

    // new objects every render would re-run the component's effects for nothing, so the three
    // option objects are rebuilt only when a slider actually moves
    const bodyRoll = useMemo(
        () =>
            bodyRollEnabled &&
            ({ maxAngle, maxPitchAngle, referenceAcceleration, stiffness, damping } as const),
        [bodyRollEnabled, maxAngle, maxPitchAngle, referenceAcceleration, stiffness, damping]
    );
    const wheelSmoothing = useMemo(
        () => smoothingEnabled && ({ suspension, steering } as const),
        [smoothingEnabled, suspension, steering]
    );
    const skid = useMemo(
        () => skidEnabled && ({ longitudinalSlip, lateralSlip } as const),
        [skidEnabled, longitudinalSlip, lateralSlip]
    );

    // The instrument cluster. `onEngine` fires once per physics step with a *pooled* object, so
    // the numbers are copied out here and pushed to leva a few times a second rather than every
    // step - a React state update at 60 Hz would cost far more than the readout itself.
    const [, setReadout] = useControls('Vehicle readout', () => ({
        speed: { value: '0 km/h', editable: false },
        rpm: { value: '0', editable: false },
        gear: { value: '0', editable: false },
        skids: { value: '0', editable: false }
    }));
    const lastPublished = useRef(0);
    const skidCount = useRef(0);

    const onEngine = useCallback(
        (state: VehicleEngineState) => {
            const now = performance.now();
            if (now - lastPublished.current < 100) return;
            lastPublished.current = now;
            setReadout({
                speed: `${Math.abs(state.speedKmh).toFixed(0)} km/h`,
                rpm: state.rpm.toFixed(0),
                gear: String(state.gear),
                skids: `${skidCount.current}${state.skidding ? ' (sliding)' : ''}`
            });
        },
        [setReadout]
    );

    // where a game would spawn tyre smoke or start a skid mark. The event is pooled as well:
    // read it inside the handler, copy anything that has to outlive it.
    const onSkidStart = useCallback((event: VehicleSkidEvent) => {
        skidCount.current++;
        console.log(
            `skid: ${event.name} at ${event.position.x.toFixed(1)}, ${event.position.z.toFixed(1)}`,
            `(slip ${event.slipRatio.toFixed(2)} / ${event.lateralSlip.toFixed(2)} rad)`
        );
    }, []);

    return (
        /*
            One <Vehicle> for every kind of vehicle (issue #10); `type="twoWheel"` gives a
            motorcycle. Anything rendered inside it is used as the chassis instead of the
            generated box (issue #26) - a <primitive object={gltf.scene} /> works the same way.
            The chassis object is also what issue #41's body roll leans, so the meshes below
            tilt into corners and squat under braking while the physics body stays exactly
            where jolt solved it.
        */
        <Vehicle
            type="fourWheel"
            position={[0, 25, 0]}
            vehicleSettings={vehicleSettings}
            bodyRoll={bodyRoll}
            wheelSmoothing={wheelSmoothing}
            skid={skid}
            onEngine={onEngine}
            onSkidStart={onSkidStart}
        >
            <mesh castShadow>
                <boxGeometry args={[1.8, 0.4, 4]} />
                <meshStandardMaterial color="#C64191" />
            </mesh>
            <mesh position={[0, 0.4, -1]} castShadow>
                <boxGeometry args={[1.8, 0.75, 2]} />
                <meshStandardMaterial color="#5E4AE3" />
            </mesh>
        </Vehicle>
    );
}
