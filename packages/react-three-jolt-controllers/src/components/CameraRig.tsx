import { useEffect, forwardRef, useImperativeHandle, useContext } from 'react';
import { useCameraRig } from '../hooks';
import type { BodyState } from '@react-three/jolt';
import { useCommand, useLookCommand } from '@react-three/jolt-addons';
import * as THREE from 'three';
import React from 'react';
import { useJolt } from '@react-three/jolt';

//lets try importing the character context
import { CharacterControllerContext } from './CharacterController';
import { CollisionResult } from '../../../react-three-jolt/dist/systems/queries/collider';
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
            cameraRig.look(lookVector);
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
    let height = 2;
    useCommand('z', () => {
        
        collider.position = new THREE.Vector3(30,height,30);
        console.log('triggering collision test', collider.position);
        collider.cast((hit: CollisionResult) => {
            console.log('Hit:', hit);
        },() => {
            console.log('No Hit');
        
        })
        height++;
        /*
        console.log(
            'Rotating collar to:, ',
            currentRotation.current,
            ', in Rads: ',
            THREE.MathUtils.degToRad(currentRotation.current)
        );
        */
    });

    /*    const getRandomRadian = () => {
        return Math.random() * Math.PI * 2;
    };
*/

    // send the parent the rig in the ref
    useImperativeHandle(ref, () => cameraRig, [cameraRig]);

    return <></>;
});
