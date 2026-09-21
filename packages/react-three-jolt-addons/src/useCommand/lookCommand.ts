// this command is going to need a re-write to conform to the rest
//but for now will be my universal look command

import { useConst } from '@react-three/jolt';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export type LookCommandOptions = {
    /** element the pointer listeners are bound to. defaults to `document.body` */
    domElement?: HTMLElement;
    invert?: { x?: boolean; y?: boolean };
    /** request pointer lock on mouse down */
    lockPointer?: boolean;
    /** use the OS pointer acceleration curve while locked */
    useAccelerated?: boolean;
};

export type LookHandler = (look: THREE.Vector2) => void;
export type ZoomHandler = (zoomLevel: number) => void;

export function useLookCommand(
    lookHandler: LookHandler,
    zoomHandler: ZoomHandler,
    options?: LookCommandOptions
) {
    const invertX = options?.invert?.x ?? false;
    const invertY = options?.invert?.y ?? false;
    const lockPointer = options?.lockPointer ?? false;
    const useAccelerated = options?.useAccelerated ?? false;
    const targetElement =
        options?.domElement ?? (typeof document === 'undefined' ? undefined : document.body);

    const lookVector = useConst(() => new THREE.Vector2());
    // these are state that has to survive a re-render; as plain locals the effect below closed
    // over the values from the render that happened to create it.
    const isMouseDown = useRef(false);
    const origin = useConst(() => new THREE.Vector2(0, 0));

    // the handlers are read through refs so a new inline arrow doesn't rebind every listener
    const lookHandlerRef = useRef(lookHandler);
    const zoomHandlerRef = useRef(zoomHandler);
    useEffect(() => {
        lookHandlerRef.current = lookHandler;
        zoomHandlerRef.current = zoomHandler;
    });

    // bind the listeners to the dom element
    useEffect(() => {
        if (!targetElement) return;

        const onMouseMove = (event: MouseEvent) => {
            // set the lookVector based on the movement values
            lookVector.set(event.movementX, event.movementY);
            if (invertY) lookVector.y = -lookVector.y;
            if (invertX) lookVector.x = -lookVector.x;
            // if we are pointerlocked or the mouse is down fire the handler
            if (document.pointerLockElement || isMouseDown.current) {
                lookHandlerRef.current(lookVector);
            }
        };

        // listener for when mouse escapes the window
        const onLeave = () => {
            isMouseDown.current = false;
            window.removeEventListener('mouseout', onLeave);
        };

        //bind mousedown and up
        const downListener = (event: MouseEvent) => {
            if (lockPointer)
                targetElement.requestPointerLock({
                    unadjustedMovement: !useAccelerated
                });
            origin.set(event.offsetX, event.offsetY);
            isMouseDown.current = true;

            // add leave listener
            window.addEventListener('mouseout', onLeave);
        };
        const upListener = () => {
            if (!document.pointerLockElement) isMouseDown.current = false;
            window.removeEventListener('mouseout', onLeave);
        };

        //bind zoom
        const onWheel = (event: WheelEvent) => {
            zoomHandlerRef.current(event.deltaY);
        };

        targetElement.addEventListener('mousedown', downListener);
        targetElement.addEventListener('mouseup', upListener);
        targetElement.addEventListener('mousemove', onMouseMove);
        targetElement.addEventListener('wheel', onWheel);

        //return the cleanup
        return () => {
            targetElement.removeEventListener('mousedown', downListener);
            targetElement.removeEventListener('mouseup', upListener);
            targetElement.removeEventListener('mousemove', onMouseMove);
            targetElement.removeEventListener('wheel', onWheel);
            // downListener may have added this to the window; removing it is a no-op otherwise
            window.removeEventListener('mouseout', onLeave);
            isMouseDown.current = false;
        };
    }, [targetElement, invertX, invertY, lockPointer, useAccelerated, lookVector, origin]);
}
