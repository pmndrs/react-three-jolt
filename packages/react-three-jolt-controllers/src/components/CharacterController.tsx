import React, { useState } from 'react';
import { useRef, useEffect, forwardRef, memo } from 'react';
import { useThree } from '@react-three/fiber';
import { useJolt } from '@react-three/jolt';
import * as THREE from 'three';
import { characterControllerSystem } from '../systems/character-controller';
import { useCommand } from '@react-three/jolt';
import { useForwardedRef } from '@react-three/jolt';
// create a blank context
export const CharacterControllerContext = React.createContext(undefined!);
interface CControllerProps {
    children?: any;
    radius?: number;
    height?: number;
    debug?: boolean;
    rest?: any;
    position?: any;
}
export const CharacterController: React.FC<CControllerProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,
            radius = 1,
            height = 2,
            debug = false,
            //@ts-ignore
            ...objectProps
        } = props;
        //@ts-ignore pass the body via the ref
        const characterRef = useForwardedRef(forwardedRef);

        const objectRef = useRef<THREE.Object3D>(null);
        const offsetObject = useRef<THREE.Object3D>(null);
        const debugCapsule = useRef<THREE.Mesh>(null);
        const { physicsSystem } = useJolt();
        //TODO: Not really sure why we had to do this as a state but oh well
        const [characterSystem, setCharacterSystem] = useState<
            characterControllerSystem | undefined
        >(undefined);

        // we need the three camera
        const { camera } = useThree();

        const cameraRotation = new THREE.Quaternion();
        // set values and initializers for characterSystem
        useEffect(() => {
            const newCCS = new characterControllerSystem(physicsSystem);
            //@ts-ignore
            newCCS.threeCharacter = objectRef.current;
            newCCS.setCapsule(radius, height);

            setCharacterSystem(newCCS);
        }, []);
        // trigger commands
        useCommand(
            'run',
            (info) => {
                // TODO Check this TS error. isInitial should exist
                //@ts-ignore
                if (!info.isInitial) return;
                // console.log('Start running', info);
                characterSystem!.startRunning();
            },
            () => {
                //console.log('Stop running', info);
                characterSystem!.stopRunning();
            }
        );
        // TODO move to utils
        // gets the horizontal rotation of the camera
        const getHorizontalRotation = () => {
            const cameraRotation = new THREE.Quaternion();
            camera.getWorldQuaternion(cameraRotation);
            cameraRotation.x = 0;
            cameraRotation.z = 0;
            cameraRotation.normalize();
            return cameraRotation;
        };
        useCommand(
            'jump',
            (info) => {
                //@ts-ignore
                if (!info.isInitial) return;
                if (characterSystem) characterSystem.jump();
            },
            undefined,
            { rate: 0.1, keys: [' '] }
        );
        useCommand(
            'move',
            (info) => {
                // get the camera direction
                camera.getWorldQuaternion(cameraRotation);
                const direction = new THREE.Vector3(
                    //@ts-ignore
                    info.value.x,
                    0,
                    //@ts-ignore
                    info.value.y
                )
                    .applyQuaternion(getHorizontalRotation())
                    .normalize();

                if (characterSystem) characterSystem.move(direction);
            },
            () => {
                if (characterSystem) characterSystem.move(new THREE.Vector3(0, 0, 0));
            },
            { asVector: true }
        );

        const contextValue = {
            characterSystem
        };

        // if you change the radius or height, you need to update the capsule
        useEffect(() => {
            const newCapsule = new THREE.CapsuleGeometry(radius, height, 32);
            debugCapsule.current!.geometry = newCapsule;
            // we also need to set the shape on the character controller
            if (characterSystem) characterSystem.setCapsule(radius, height);
        }, [radius, height]);

        return (
            //@ts-ignore
            <CharacterControllerContext.Provider value={contextValue}>
                <object3D ref={objectRef}>
                    <object3D ref={offsetObject} position-y={radius + height / 2}>
                        <mesh ref={debugCapsule} visible={debug}>
                            <capsuleGeometry args={[radius, height, 32]} />
                            <meshStandardMaterial wireframe={false} color="red" />
                            <mesh position-z={-1}>
                                <boxGeometry args={[0.1, 0.5, 1]} />
                                <meshStandardMaterial color="orange" />
                            </mesh>
                        </mesh>
                        {children}
                    </object3D>
                </object3D>
            </CharacterControllerContext.Provider>
        );
    })
);
