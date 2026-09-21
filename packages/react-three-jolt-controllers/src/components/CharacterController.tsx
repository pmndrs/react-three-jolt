import { type ThreeElements, useThree } from '@react-three/fiber';
import { useEventCallback, useForwardedRef, useJolt } from '@react-three/jolt';
import { type CommandVector, isCommandVector, useCommand } from '@react-three/jolt-addons';
import React, { forwardRef, memo, type ReactNode, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { CharacterEventMap, HeadHitInfo } from '../systems/character-controller';
import { CharacterControllerSystem } from '../systems/character-controller';
/** What `<CharacterController>` puts on its context; `undefined` until the system exists. */
export interface CharacterControllerContextValue {
    characterSystem: CharacterControllerSystem | undefined;
}

// `createContext(undefined!)` inferred `never` here, which is why the Provider below needed a
// suppression on the one value it could ever be handed.
export const CharacterControllerContext = React.createContext<CharacterControllerContextValue>({
    characterSystem: undefined
});

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

export interface CControllerProps extends Omit<ThreeElements['object3D'], 'ref' | 'children'> {
    children?: ReactNode;
    /** Capsule radius, in metres. Wired to `setCapsule` at creation and on every change. @default 1 */
    radius?: number;
    /** Capsule height, in metres. Wired to `setCapsule` at creation and on every change. @default 2 */
    height?: number;
    /**
     * Where the character spawns (and is teleported to on every change) - the actual
     * `CharacterVirtual` position, not just a local transform on the rendered children. Inherited
     * from `object3D`, but handled separately: the underlying `<object3D>` this creates is a
     * child of the character's own three object, so applying `position` to it as well would
     * offset the visuals from the capsule instead of moving the capsule (issue #212).
     */
    position?: ThreeElements['object3D']['position'];
    debug?: boolean;

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
// The `ref` on `<CharacterController>` hands back the `CharacterControllerSystem` itself (see the
// comment on `characterRef.current = newCCS` below) - `forwardRef`'s type parameters say so
// explicitly, rather than the previous `React.FC<CControllerProps>` annotation, which quietly
// erased the ref from the public type even though the runtime always supported it (issue #212).
export const CharacterController = memo(
    forwardRef<CharacterControllerSystem, CControllerProps>((props, forwardedRef) => {
        const {
            children,
            radius = 1,
            height = 2,
            position,
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
            ...objectProps
        } = props;
        // pass the body via the ref
        const characterRef = useForwardedRef<CharacterControllerSystem | null>(forwardedRef);

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
            if (objectRef.current) newCCS.add(objectRef.current);
            newCCS.addToScene(scene);
            // expose the controller through the forwarded ref (this is what the ref was always
            // for; nothing ever assigned it, so `ref` silently stayed null)
            characterRef.current = newCCS;
            // radius/height/position are applied by the effects below, which run right after this
            // one on the same mount (issue #212) - `characterSystem` only becomes defined once
            // `setCharacterSystem` below commits, so nothing has stepped the controller yet.

            setCharacterSystem(newCCS);
            // destroy on unload. `destroy()` frees every jolt object the controller owns and
            // takes its pre-step listener back off the physics system (issue #138); dropping the
            // state as well keeps the commands below from driving a destroyed controller.
            return () => {
                newCCS.destroy();
                characterRef.current = null;
                setCharacterSystem(undefined);
            };
        }, [physicsSystem, scene]);

        // set debugging
        useEffect(() => {
            if (!characterSystem) return;
            characterSystem.debug = debug;
        }, [characterSystem, debug]);

        // radius/height were accepted but never reached the CharacterVirtual (issue #212):
        // `setCapsule` rebuilds both the standing and crouching shapes and pushes the standing
        // one onto the character immediately, at creation and on every later change.
        useEffect(() => {
            if (!characterSystem) return;
            characterSystem.setCapsule(radius, height);
        }, [characterSystem, radius, height]);

        // `position` used to be silently absorbed into `objectProps` and applied to the child
        // `<object3D>` instead of the character itself, so it never moved the capsule (issue
        // #212). Normalize whatever shape `object3D.position` accepts (a Vector3, a tuple or a
        // uniform scalar) the same way `<Vehicle position>` does, then drive the actual
        // `CharacterVirtual` position with it, at creation and on every later change.
        const [px, py, pz] =
            position === undefined
                ? [undefined, undefined, undefined]
                : typeof position === 'number'
                  ? [position, position, position]
                  : position instanceof THREE.Vector3
                    ? [position.x, position.y, position.z]
                    : position;
        useEffect(() => {
            if (!characterSystem || px === undefined || py === undefined || pz === undefined)
                return;
            characterSystem.position = new THREE.Vector3(px, py, pz);
        }, [characterSystem, px, py, pz]);

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
                // `move` is bound with `{ asVector: true }`, so its value is the two axis
                // kind; narrow rather than cast, since reading `.x` off a scalar would quietly
                // build a NaN direction.
                if (!isCommandVector(info.value)) return;
                const move: CommandVector = info.value;
                const direction = new THREE.Vector3(move.x, 0, move.y)
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

        const contextValue: CharacterControllerContextValue = {
            characterSystem
        };

        return (
            <CharacterControllerContext.Provider value={contextValue}>
                <object3D ref={objectRef} {...objectProps}>
                    {children}
                </object3D>
            </CharacterControllerContext.Provider>
        );
    })
);
