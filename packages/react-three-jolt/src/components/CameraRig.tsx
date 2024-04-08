import { useMemo, useContext, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useConst, useJolt } from '../hooks';
import { CameraRigManager } from '../systems/camera-rig-system';
import { CharacterControllerContext } from './CharacterController';
import { RigidBody } from './RidgedBody';
import { useCommand } from '../useCommand';
import * as THREE from 'three';
export function CameraRig() {
    const isAttached = useRef(false);
    const settable = useConst('yep');
    const { characterSystem } = useContext(CharacterControllerContext);
    const { jolt, physicsSystem } = useJolt();
    const { camera, scene, controls } = useThree();
    const { set } = useThree(({ get, set }) => ({ get, set }));

    const cameraRig = useMemo(() => {
        return new CameraRigManager(scene, physicsSystem);
    }, [physicsSystem]);
    const updateCamera = (camera) => {
        set({ camera: camera });
        //controls.update();
    };
    const currentRotation = useRef(0);
    useCommand('z', () => {
        /*
        console.log(
            'Rotating collar to:, ',
            currentRotation.current,
            ', in Rads: ',
            THREE.MathUtils.degToRad(currentRotation.current)
        );
        cameraRig.rotateCollar(
            THREE.MathUtils.degToRad(currentRotation.current)
        );
        

        */
        cameraRig.alignCollar();
    });
    useCommand('x', () => {
        console.log('setting pivot to: ', currentRotation.current);
        cameraRig.rotatePivot(
            THREE.MathUtils.degToRad(currentRotation.current)
        );
        currentRotation.current += 90;
    });

    const getRandomRadian = () => {
        return Math.random() * Math.PI * 2;
    };

    useEffect(() => {
        if (!characterSystem) return;
        // create the camera listener first
        const cameraListener = cameraRig.onCamera((camera) => {
            console.log('updating camera', camera);
            updateCamera(camera);
        });
        // attach to the character system
        cameraRig.attachToCharacter(characterSystem);
        return () => {
            cameraListener();
        };
    }, [characterSystem]);

    return <></>;
}
