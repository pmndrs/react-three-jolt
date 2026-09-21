import { BodyState, RigidBody, useJolt } from '@react-three/jolt';
import { memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

type ScalerProps = {
    position?: number[];
};
const Scaler: React.FC<ScalerProps> = memo((props) => {
    const [scale, setScale] = useState([1, 1, 1]);
    const [activeColor, setActiveColor] = useState('#B4A6AB');
    const bodyRef = useRef<BodyState | undefined>(undefined);
    const currentScale = useRef(0);
    const { physicsSystem } = useJolt();
    // Same hazard as OneWayPlatform's Launcher, with a much wider window: this timer is 5s, so
    // navigating away almost always leaves it pending, and it then writes a body position into a
    // world that has been destroyed - which traps the wasm module.
    const returnTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(
        () => () => {
            if (returnTimer.current !== undefined) clearTimeout(returnTimer.current);
            returnTimer.current = undefined;
        },
        []
    );
    const colors = ['#B4A6AB', '#CDD5D1', '#DDF8E8'];
    const scales = [
        [1, 1, 1],
        [1.33, 1.33, 1.33],
        [1.8, 1.8, 1.8]
    ];
    const nextScale = () => {
        const next = ++currentScale.current;
        console.log('Changing scale', next);

        if (next >= scales.length) return reset();
        // set the scale
        setScale(scales[next]);
        // set the color
        setActiveColor(colors[next]);
    };
    // this will reset the scale and the color and move the shape so it can animate back in
    const reset = () => {
        console.log('resetting');
        // teleport the shape way out of the scene
        bodyRef.current!.position = new THREE.Vector3(0, 0, 1000);
        // reset the scale
        setScale(scales[0]);
        // reset the color
        setActiveColor(colors[0]);
        currentScale.current = 0;
        // wait 5 seconds then teleport it back to center with a little height
        if (returnTimer.current !== undefined) clearTimeout(returnTimer.current);
        returnTimer.current = setTimeout(() => {
            returnTimer.current = undefined;
            if (!bodyRef.current || physicsSystem.destroyed) return;
            bodyRef.current.position = new THREE.Vector3(0, 8, 0);
        }, 5000);
    };
    return (
        <RigidBody ref={bodyRef} {...props} scale={scale}>
            <mesh onClick={() => nextScale()} castShadow receiveShadow>
                <sphereGeometry args={[1.3, 32, 32]} />
                <meshStandardMaterial color={activeColor} />
            </mesh>
        </RigidBody>
    );
});

export default Scaler;
