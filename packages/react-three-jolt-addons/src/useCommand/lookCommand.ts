// this command is going to need a re-write to conform to the rest
//but for now will be my universal look command

import { useConst } from '@react-three/jolt';
import { useEffect } from 'react';
import * as THREE from 'three';

export function useLookCommand(lookHandler: any, options?: any) {
    const { invert = { y: false } } = options || {};
    const targetElement = options?.domElement || document.body;

    const lookVector = useConst(new THREE.Vector2());
    let isMouseDown = false;
    // bind the listeners to the dom element
    useEffect(() => {
        // get the dimensions of the element
        const { height, width } = targetElement.getBoundingClientRect();
        //whichever is bigger will set our percentage factor
        const factor = height < width ? height : width;
        const elementDimensions = { height, width, factor };

        const onMouseMove = (event: MouseEvent) => {
            //   console.log('mouse move', event, isMouseDown);
            // calcualte the position in the range -1 to 1 based on event.offsetX and event.offsetY
            // change the specefics to use factor so whichever is greater
            //lookVector.x = (event.offsetX / elementDimensions.width) * 2 - 1;
            //lookVector.y = (event.offsetY / elementDimensions.height) * 2 - 1;
            // if we are inverting the y axis, then we need to invert the y value

            // calculate the  distance from the center of the element
            const yDistance = event.offsetY - elementDimensions.height / 2;
            const xDistance = event.offsetX - elementDimensions.width / 2;
            lookVector.x = (xDistance / elementDimensions.factor) * 2;
            lookVector.y = (yDistance / elementDimensions.factor) * 2;

            if (invert) lookVector.y = -lookVector.y;
            // if we are pointerlocked or the mouse is down fire the handler
            if (document.pointerLockElement || isMouseDown) {
                lookHandler(lookVector);
            }
        };

        //bind mousedown and up
        const downListener = () => {
            console.log('mousedown');
            isMouseDown = true;
        };
        const upListener = () => {
            isMouseDown = false;
        };
        targetElement.addEventListener('mousedown', downListener);
        targetElement.addEventListener('mouseup', upListener);

        //bind mousemove
        const moveListener = (event: MouseEvent) => onMouseMove(event);
        targetElement.addEventListener('mousemove', moveListener);

        //return the cleanup
        return () => {
            targetElement.removeEventListener('mousedown', downListener);
            targetElement.removeEventListener('mouseup', upListener);
            targetElement.removeEventListener('mousemove', moveListener);
        };
    }, [targetElement]);
}
