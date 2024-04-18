// this command is going to need a re-write to conform to the rest
//but for now will be my universal look command

import { useConst } from '@react-three/jolt';
import { useEffect } from 'react';
import * as THREE from 'three';

export function useLookCommand(
    lookHandler: any,
    zoomHandler: (zoomlevel: number) => void,
    options?: any
) {
    const { invert = { y: false, x: false } } = options || {};
    const targetElement = options?.domElement || document.body;

    const lookVector = useConst(new THREE.Vector2());
    let isMouseDown = false;
    const origin = new THREE.Vector2(0, 0);
    // bind the listeners to the dom element
    useEffect(() => {
        const onMouseMove = (event: MouseEvent) => {
            // set the lookVector based on the movement values
            lookVector.set(event.movementX, event.movementY);
            if (invert.y) lookVector.y = -lookVector.y;
            if (invert.x) lookVector.x = -lookVector.x;
            // if we are pointerlocked or the mouse is down fire the handler
            if (document.pointerLockElement || isMouseDown) {
                lookHandler(lookVector);
            }
        };

        //bind mousedown and up
        const downListener = (event: MouseEvent) => {
            if (options?.lockPointer)
                targetElement.requestPointerLock({
                    unadjustedMovement: options?.useAccelerated ? false : true
                });
            origin.set(event.offsetX, event.offsetY);
            isMouseDown = true;

            // add leave listener
            window.addEventListener('mouseout', onLeave);
        };
        const upListener = () => {
            if (!document.pointerLockElement) isMouseDown = false;
            window.removeEventListener('mouseout', onLeave);
        };
        targetElement.addEventListener('mousedown', downListener);
        targetElement.addEventListener('mouseup', upListener);

        //bind zoom
        const onWheel = (event: WheelEvent) => {
            zoomHandler(event.deltaY);
        };
        targetElement.addEventListener('wheel', onWheel);

        // listener for when mouse escapes the window
        const onLeave = () => {
            isMouseDown = false;
            window.removeEventListener('mouseout', onLeave);
        };

        //bind mousemove
        const moveListener = (event: MouseEvent) => onMouseMove(event);
        targetElement.addEventListener('mousemove', moveListener);

        //return the cleanup
        return () => {
            targetElement.removeEventListener('mousedown', downListener);
            targetElement.removeEventListener('mouseup', upListener);
            targetElement.removeEventListener('mousemove', moveListener);
            targetElement.removeEventListener('wheel', onWheel);
        };
    }, [targetElement]);
}
