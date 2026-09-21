import { useThree } from '@react-three/fiber';
import { useEventCallback, useForwardedRef, useJolt } from '@react-three/jolt';
import { useCommand } from '@react-three/jolt-addons';
import React, { forwardRef, memo, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CharacterEventMap, HeadHitInfo } from '../systems/character-controller';
import { CharacterControllerSystem } from '../systems/character-controller';
// create a blank context
export const CharacterControllerContext = React.createContext(undefined!);

/**
 * Subscribe `handler` to one of a controller's events for as long as both exist (issues #79,
 * #80, #50).
 *
 * Same contract as core's `useBodyEvent`: the dependency is *whether* there is a handler rather
 * than its identity, so an inline arrow does not resubscribe every render, and the cleanup is
 * the unsubscribe handle rather than a removal by function identity - which could never match an
 * inline arrow in the first place.
 */
export function useCharacterEvent<K extends keyof CharacterEventMap>(
    system: CharacterControllerSystem | undefined,
    type: K,
    handler: CharacterEventMap[K] | undefined
): void {
    const callback = useEventCallback(handler);
    const enabled = handler !== undefined;
    useEffect(() => {
        if (!system || !enabled) return;
        return system.events.on(type, callback as CharacterEventMap[K]);
    }, [system, enabled, type, callback]);
}

interface CControllerProps {
    children?: any;
    radius?: number;
    height?: number;
    debug?: boolean;
    rest?: any;
    position?: any;
    anchor?: any;

    //* Events (issues #79, #80, and the `onAction` half of #50) -------------
    /** Started moving under its own power; the argument is the speed relative to the ground. */
    onMove?: CharacterEventMap['move'];
    /** Stopped moving under its own power. */
    onStop?: CharacterEventMap['stop'];
    /** Started sliding down something too steep to stand on. */
    onSlide?: CharacterEventMap['slide'];
    /** Stopped sliding. */
    onSlideEnd?: CharacterEventMap['slideEnd'];
    /** A jump was accepted; the argument says which jump of the sequence it was. */
    onJump?: CharacterEventMap['jump'];
    /** Touched down, with the time spent unsupported in seconds. */
    onLand?: CharacterEventMap['land'];
    /** Became supported by something. */
    onGround?: CharacterEventMap['ground'];
    /** Stopped being supported by anything. */
    onAirborne?: CharacterEventMap['airborne'];
    onCrouch?: CharacterEventMap['crouch'];
    onStand?: CharacterEventMap['stand'];
    /** A new contact with a body. The payload is pooled - read it, do not keep it. */
    onContactAdded?: CharacterEventMap['contactAdded'];
    onContactPersisted?: CharacterEventMap['contactPersisted'];
    onContactRemoved?: CharacterEventMap['contactRemoved'];
    /** Every action, as `(name, payload)`. The generic escape hatch. */
    onAction?: CharacterEventMap['action'];

    /** Relative speed (m/s) above which the character counts as moving. Default 0.5. */
    moveThreshold?: number;
    /** Speed (m/s) along a steep surface above which it counts as sliding. Default 0.5. */
    slideThreshold?: number;
    /**
     * Half-angle (radians) of the cone around straight-down within which a contact counts as a
     * head/ceiling hit and cancels the character's upward velocity. See
     * `CharacterControllerSystem.headAngle` (issue #88). Defaults to 30 degrees.
     */
    headAngle?: number;
    /**
     * Called once per new head/ceiling contact. See `CharacterControllerSystem.onHeadHit`
     * (issue #88).
     */
    onHeadHit?: (info: HeadHitInfo) => void;
}
export const CharacterController: React.FC<CControllerProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,
            radius = 1,
            height = 2,
            debug = true,
            onMove,
            onStop,
            onSlide,
            onSlideEnd,
            onJump,
            onLand,
            onGround,
            onAirborne,
            onCrouch,
            onStand,
            onContactAdded,
            onContactPersisted,
            onContactRemoved,
            onAction,
            moveThreshold,
            slideThreshold,
            headAngle,
            onHeadHit,
            //@ts-ignore
            ...objectProps
        } = props;
        //@ts-ignore pass the body via the ref
        const characterRef = useForwardedRef(forwardedRef);

        const objectRef = useRef<THREE.Object3D>(null);

        const { physicsSystem } = useJolt();
        //TODO: Not really sure why we had to do this as a state but oh well
        const [characterSystem, setCharacterSystem] = useState<
            CharacterControllerSystem | undefined
        >(undefined);

        // we need the three camera
        const { camera, scene } = useThree();

        const cameraRotation = new THREE.Quaternion();
        // set values and initializers for characterSystem
        useEffect(() => {
            const newCCS = new CharacterControllerSystem(physicsSystem);
            //@ts-ignore
            newCCS.add(objectRef.current);
            newCCS.addToScene(scene);
            //newCCS.setCapsule(radius, height);

            setCharacterSystem(newCCS);
            // destroy on unload. `destroy()` frees every jolt object the controller owns and
            // takes its pre-step listener back off the physics system (issue #138); dropping the
            // state as well keeps the commands below from driving a destroyed controller.
            return () => {
                newCCS.destroy();
                setCharacterSystem(undefined);
            };
        }, [physicsSystem, scene]);

        // set debugging
        useEffect(() => {
            if (!characterSystem) return;
            characterSystem.debug = debug;
        }, [characterSystem, debug]);

        //* Events -------------------------------------------
        // Each of these is an effect whose cleanup is the unsubscribe handle, keyed on the
        // controller instance. Nothing subscribes for a prop that was not passed, so the mask
        // behind the forwarded contact stream stays clear and costs nothing per contact.
        useCharacterEvent(characterSystem, 'move', onMove);
        useCharacterEvent(characterSystem, 'stop', onStop);
        useCharacterEvent(characterSystem, 'slide', onSlide);
        useCharacterEvent(characterSystem, 'slideEnd', onSlideEnd);
        useCharacterEvent(characterSystem, 'jump', onJump);
        useCharacterEvent(characterSystem, 'land', onLand);
        useCharacterEvent(characterSystem, 'ground', onGround);
        useCharacterEvent(characterSystem, 'airborne', onAirborne);
        useCharacterEvent(characterSystem, 'crouch', onCrouch);
        useCharacterEvent(characterSystem, 'stand', onStand);
        useCharacterEvent(characterSystem, 'contactAdded', onContactAdded);
        useCharacterEvent(characterSystem, 'contactPersisted', onContactPersisted);
        useCharacterEvent(characterSystem, 'contactRemoved', onContactRemoved);
        useCharacterEvent(characterSystem, 'action', onAction);

        useEffect(() => {
            if (!characterSystem) return;
            if (moveThreshold !== undefined) characterSystem.moveThreshold = moveThreshold;
            if (slideThreshold !== undefined) characterSystem.slideThreshold = slideThreshold;
        }, [characterSystem, moveThreshold, slideThreshold]);

        // wire up head/ceiling collision configuration (issue #88)
        useEffect(() => {
            if (!characterSystem) return;
            if (headAngle !== undefined) characterSystem.headAngle = headAngle;
            characterSystem.onHeadHit = onHeadHit;
        }, [characterSystem, headAngle, onHeadHit]);

        // trigger commands
        useCommand(
            'run',
            (info) => {
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
        useCommand(
            'c',
            (info) => {
                if (!info.isInitial) return;
                characterSystem?.setCrouched(true);
            },
            () => {
                characterSystem?.setCrouched(false);
            }
        );

        const contextValue = {
            characterSystem
        };

        // if you change the radius or height, you need to update the capsule
        useEffect(() => {
            //if (characterSystem) characterSystem.setCapsule(radius, height);
        }, [radius, height]);

        return (
            //@ts-ignore
            <CharacterControllerContext.Provider value={contextValue}>
                <object3D ref={objectRef}>{children}</object3D>
            </CharacterControllerContext.Provider>
        );
    })
);
