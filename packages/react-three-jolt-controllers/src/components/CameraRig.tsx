import { useEffect, forwardRef, useImperativeHandle, useContext } from 'react';
import { useCameraRig } from '../hooks';
import type { BodyState } from '@react-three/jolt';
import { useCommand, useLookCommand } from '@react-three/jolt-addons';
//import * as THREE from 'three';
import React from 'react';
import { useJolt } from '@react-three/jolt';

//lets try importing the character context
import { CharacterControllerContext } from './CharacterController';
//import { CharacterControllerSystem } from 'src/systems';
interface CameraRigProps {
    anchor?: BodyState;
}

export const CameraRig = forwardRef(function CameraRig(props: CameraRigProps, ref) {
    const { anchor } = props;

    const cameraRig = useCameraRig();
    const { physicsSystem } = useJolt();

    const collider = physicsSystem.getShapeCollider();

    useEffect(() => {
        console.log('Collider:', collider);
    },[]);
    // bind the look command for look and zoom
    useLookCommand(
        (lookVector: any) => {
            cameraRig.moveBoom(lookVector);
        },
        (zoomLevel: number) => {
            cameraRig.zoom(zoomLevel);
        }
    );

    // bind the cameraRig to the anchor
    useEffect(() => {
        if (!anchor) return;
        cameraRig.attach(anchor);
        return () => {
            cameraRig.detach();
        };
    }, [anchor]);

    // lets try and see if we are in a character context
    const { characterSystem } = useContext(CharacterControllerContext);

    useEffect(() => {
        if (!characterSystem) return;
        //@ts-ignore
        cameraRig.attach(characterSystem.anchor);
        cameraRig.setActiveCamera('main');
        return () => cameraRig.detach();
    }, [characterSystem]);
    useCommand('z', () => {
        cameraRig.controls.doObstructionTest();
    });
    useCommand('c', () => {
        const collision = cameraRig.controls.doCollisionTest();
        console.log('Collision:', collision);
    });
    // reset to follow cam
    useCommand('r', () => {
        cameraRig.controls.setRotation(cameraRig.anchor.rotation.y);
    });

    /*    const getRandomRadian = () => {
        return Math.random() * Math.PI * 2;
    };
*/

    // send the parent the rig in the ref
    useImperativeHandle(ref, () => cameraRig, [cameraRig]);

    return <></>;
});
