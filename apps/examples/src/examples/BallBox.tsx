//import * as THREE from "three";
import { useThree } from '@react-three/fiber';
import { Attractor, type AttractorType, Physics, RigidBody } from '@react-three/jolt';
import { useControls } from 'leva';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';
import { BoxContainer } from './Bodies/BoxContainer';
import Changer from './Bodies/Changer';
import { JoltBolt } from './Bodies/joltBolt';
import Scaler from './Bodies/Scaler';

export function BallBox() {
    // This demo used to hardcode `module={InitJolt}` (a static `import InitJolt from
    // 'jolt-physics'` duplicating raw.ts's own dynamic default import - it also tripped
    // rolldown's [INEFFECTIVE_DYNAMIC_IMPORT] warning). It now follows the same
    // app-wide build-variant selector as every other demo (see joltModules.ts).
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const { controls, camera } = useThree();
    //* disable controls
    useEffect(() => {
        if (!controls) return;
        //@ts-expect-error r3f types `controls` as unknown
        controls.rotate(0, 0, false);
        setTimeout(() => {
            //@ts-expect-error r3f types `controls` as unknown
            controls.enabled = false;
        }, 100);
        return () => {
            //@ts-expect-error r3f types `controls` as unknown
            controls!.enabled = true;
        };
    }, [controls, camera]);

    const defaultBodySettings = {
        mRestitution: 0.5
    };

    const positions = useMemo(() => {
        const allPos = [];

        for (let i = 0; i < 15; i++) {
            allPos.push([Math.random() * 20 - 10, Math.random() * 10, 0]);
        }
        return allPos;
    }, []);

    const [gravity, setGravity] = useState([0, -9.8, 0]);
    const [showPrompt, setShowPrompt] = useState(false);

    //* Attractor (issue #159) ----------------------------------
    // Off by default so the demo still opens as the gravity toy it has always been. Turn it on
    // and the balls orbit the marker instead of piling up in a corner; `strength` is a force in
    // newtons, and these bodies are around a kilogram each.
    const attractor = useControls('Attractor', {
        enabled: false,
        strength: { value: 40, min: -200, max: 200, step: 5 },
        range: { value: 14, min: 1, max: 40, step: 1 },
        type: { value: 'linear' as AttractorType, options: ['static', 'linear', 'newtonian'] },
        height: { value: 4, min: -2, max: 12, step: 0.5 }
    });

    //* Changing gravity with mouse ----------------------------
    const updateGravityOnMouse = (e: MouseEvent) => {
        // if the right click isn't pressed, don't update the gravity
        if (!e.buttons || e.buttons !== 2) return;

        const x = (e.clientX / window.innerWidth) * 20 - 10;
        const y = (e.clientY / window.innerHeight) * 20 - 10;
        setGravity([x, -y, 0]);
    };
    // attach event listener to mouse move with removal on return
    useEffect(() => {
        window.addEventListener('mousemove', updateGravityOnMouse);
        function preventDefault(e: MouseEvent) {
            e.preventDefault();
        }
        window.addEventListener('contextmenu', preventDefault);
        return () => {
            window.removeEventListener('mousemove', updateGravityOnMouse);
            window.removeEventListener('contextmenu', preventDefault);
        };
    }, []);

    //* Changing gravity with device ----------------------------

    const promptUser = () => {
        //@ts-expect-error iOS only, not in lib.dom
        DeviceMotionEvent.requestPermission()
            .then((permissionState: PermissionState) => {
                console.log('Permission state', permissionState);
                if (permissionState === 'granted') {
                    console.log('*** Permission granted, adding event listener');
                    window.addEventListener('devicemotion', updateGravityOnDevice);
                    setShowPrompt(false);
                }
            })
            .catch(console.error);
    };

    // detect device orientation and set gravity
    const updateGravityOnDevice = (e: DeviceMotionEvent) => {
        if (!e.accelerationIncludingGravity || e.accelerationIncludingGravity.x === null) return;
        const { x, y, z } = e.accelerationIncludingGravity!;
        //console.log("setting from device", e);
        setGravity([x || 0, y || 0, z || 0]);
    };

    // attach event listener to device orientation with removal on return
    useEffect(() => {
        //@ts-expect-error iOS only, not in lib.dom
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            // we are on an iOS 13+ device
            setShowPrompt(true);
        } else {
            // handle regular non iOS 13+ devices
            window.addEventListener('devicemotion', updateGravityOnDevice);
        }

        return () => {
            window.removeEventListener('devicemotion', updateGravityOnDevice);
        };
    }, []);

    return (
        <>
            <Physics
                module={module}
                paused={paused}
                key={physicsKey}
                interpolate={interpolate}
                debug={debug}
                gravity={gravity}
                defaultBodySettings={defaultBodySettings}
            >
                <JoltMemoryRegistrar />
                {showPrompt && (
                    <mesh position={[0, -1, 0]} receiveShadow onClick={promptUser}>
                        <sphereGeometry args={[10, 32, 32]} />
                        <meshStandardMaterial color="#CE7B91" />
                    </mesh>
                )}

                <BoxContainer />

                <Attractor
                    position={[0, attractor.height, 0]}
                    enabled={attractor.enabled}
                    strength={attractor.strength}
                    range={attractor.range}
                    type={attractor.type as AttractorType}
                >
                    {attractor.enabled && (
                        <mesh>
                            <sphereGeometry args={[0.4, 16, 16]} />
                            <meshStandardMaterial
                                color="#ffd23d"
                                emissive="#ffd23d"
                                emissiveIntensity={0.6}
                            />
                        </mesh>
                    )}
                </Attractor>

                <RigidBody
                    scale={[0.03, 0.03, 0.03]}
                    rotation={[3.14, 0, 0]}
                    position={[-1, 3, 1]}
                    onlyInitialize
                >
                    <JoltBolt />
                </RigidBody>

                {positions.map((pos) => (
                    <Fragment key={pos.toString()}>
                        <Scaler position={pos} />
                        <Changer
                            position={[pos[0] - Math.random(), pos[1] + Math.random(), pos[2]]}
                        />
                    </Fragment>
                ))}
            </Physics>
            <ambientLight intensity={0.5} />
            <directionalLight
                position={[-29, 5, 20]}
                shadow-camera-bottom={-16}
                shadow-camera-top={16}
                shadow-camera-left={-16}
                shadow-camera-right={16}
                shadow-camera-near={0.1}
                shadow-camera-far={70}
                shadow-mapSize-width={1024}
                shadow-bias={0.001}
                shadow-normalBias={0.03}
                intensity={3}
                castShadow
            />
        </>
    );
}
