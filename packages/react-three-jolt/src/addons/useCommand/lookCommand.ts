// A universal "look" input: mouse drag / pointer lock, one finger touch drag, and a gamepad
// stick, all reported to the same handler as a delta (issue #87).

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useConst } from '../../index';
import { hasGamepadSupport, standardGamepadSticks } from './gamepad';

/** Per source multipliers applied to the raw delta before the handler sees it. */
export type LookSensitivity = {
    /** scales the pixel delta of a mouse move. 1 */
    mouse?: number;
    /** scales the pixel delta of a touch drag. 1 */
    touch?: number;
    /** stick deflection is per second, so this is "units at full deflection per second". 200 */
    gamepad?: number;
};

export type LookGamepadOptions = {
    /** which stick to read: `left` is axes 0/1, `right` is axes 2/3 */
    stick: 'left' | 'right';
    /** deflection at or below this magnitude counts as centered. 0.15 */
    deadzone?: number;
};

export type LookCommandOptions = {
    /** element the pointer listeners are bound to. defaults to `document.body` */
    domElement?: HTMLElement;
    invert?: { x?: boolean; y?: boolean };
    /** shorthand for `invert.y` */
    invertY?: boolean;
    /** request pointer lock on mouse down */
    lockPointer?: boolean;
    /** use the OS pointer acceleration curve while locked */
    useAccelerated?: boolean;

    // sources -----------------------------------------------------------------
    /** mouse drag / pointer lock. default true */
    mouse?: boolean;
    /** one finger touch drag. default true */
    touch?: boolean;
    /** gamepad stick, defaults to the right stick. default true */
    gamepad?: boolean | LookGamepadOptions;
    sensitivity?: LookSensitivity;
};

export type LookHandler = (look: THREE.Vector2) => void;
export type ZoomHandler = (zoomLevel: number) => void;

const DEFAULT_GAMEPAD_DEADZONE = 0.15;
const DEFAULT_GAMEPAD_SENSITIVITY = 200;
/** a tab that was in the background can hand us a huge frame delta; clamp it */
const MAX_FRAME_DELTA = 0.1;

export function useLookCommand(
    lookHandler: LookHandler,
    zoomHandler: ZoomHandler,
    options?: LookCommandOptions
) {
    const invertX = options?.invert?.x ?? false;
    const invertY = options?.invertY ?? options?.invert?.y ?? false;
    const lockPointer = options?.lockPointer ?? false;
    const useAccelerated = options?.useAccelerated ?? false;
    const targetElement =
        options?.domElement ?? (typeof document === 'undefined' ? undefined : document.body);

    const mouseEnabled = options?.mouse ?? true;
    const touchEnabled = options?.touch ?? true;
    const gamepadOption = options?.gamepad ?? true;
    const gamepadEnabled = gamepadOption !== false;
    const gamepadStick = typeof gamepadOption === 'object' ? gamepadOption.stick : 'right';
    const gamepadDeadzone =
        (typeof gamepadOption === 'object' ? gamepadOption.deadzone : undefined) ??
        DEFAULT_GAMEPAD_DEADZONE;

    const mouseSensitivity = options?.sensitivity?.mouse ?? 1;
    const touchSensitivity = options?.sensitivity?.touch ?? 1;
    const gamepadSensitivity = options?.sensitivity?.gamepad ?? DEFAULT_GAMEPAD_SENSITIVITY;

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

    // the invert flags are read through a ref too: flipping one shouldn't tear down the
    // listeners, and the gamepad loop below wants the current value on every frame
    const invertRef = useRef({ x: invertX, y: invertY });
    invertRef.current = { x: invertX, y: invertY };

    /** apply the invert flags and hand the vector to the current look handler */
    const emit = useConst<(x: number, y: number) => void>(() => (x: number, y: number) => {
        if (x === 0 && y === 0) return;
        const { x: flipX, y: flipY } = invertRef.current;
        lookVector.set(flipX ? -x : x, flipY ? -y : y);
        lookHandlerRef.current(lookVector);
    });

    // Mouse ------------------------------------------------------------------
    useEffect(() => {
        if (!targetElement || !mouseEnabled) return;

        const onMouseMove = (event: MouseEvent) => {
            // if we are pointerlocked or the mouse is down fire the handler
            if (!document.pointerLockElement && !isMouseDown.current) return;
            emit(event.movementX * mouseSensitivity, event.movementY * mouseSensitivity);
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

        targetElement.addEventListener('mousedown', downListener);
        targetElement.addEventListener('mouseup', upListener);
        targetElement.addEventListener('mousemove', onMouseMove);

        //return the cleanup
        return () => {
            targetElement.removeEventListener('mousedown', downListener);
            targetElement.removeEventListener('mouseup', upListener);
            targetElement.removeEventListener('mousemove', onMouseMove);
            // downListener may have added this to the window; removing it is a no-op otherwise
            window.removeEventListener('mouseout', onLeave);
            isMouseDown.current = false;
        };
    }, [targetElement, mouseEnabled, mouseSensitivity, lockPointer, useAccelerated, origin, emit]);

    // Zoom (wheel) -----------------------------------------------------------
    // bound independently of the mouse look, a trackpad/wheel zoom is useful either way
    useEffect(() => {
        if (!targetElement) return;
        const onWheel = (event: WheelEvent) => {
            zoomHandlerRef.current(event.deltaY);
        };
        targetElement.addEventListener('wheel', onWheel);
        return () => targetElement.removeEventListener('wheel', onWheel);
    }, [targetElement]);

    // Touch ------------------------------------------------------------------
    // one finger drag = look. Pointer events give us touch, pen and mouse through one API, so
    // filter on `pointerType`; a second finger means a pinch/zoom gesture, not a look.
    useEffect(() => {
        if (!targetElement || !touchEnabled) return;

        const activePointers = new Set<number>();
        const last = new THREE.Vector2();
        let trackedPointer: number | null = null;

        const onPointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            activePointers.add(event.pointerId);
            if (activePointers.size > 1) {
                // a pinch started: stop looking until every finger is off the glass again
                trackedPointer = null;
                return;
            }
            trackedPointer = event.pointerId;
            last.set(event.clientX, event.clientY);
        };

        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            if (trackedPointer === null || event.pointerId !== trackedPointer) return;
            if (activePointers.size > 1) return;
            const deltaX = (event.clientX - last.x) * touchSensitivity;
            const deltaY = (event.clientY - last.y) * touchSensitivity;
            last.set(event.clientX, event.clientY);
            emit(deltaX, deltaY);
        };

        const onPointerEnd = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            activePointers.delete(event.pointerId);
            // don't resume mid gesture: the remaining finger's last position is unknown and
            // would produce one enormous jump. The next pointerdown starts a fresh drag.
            if (event.pointerId === trackedPointer) trackedPointer = null;
        };

        // the browser would otherwise pan/zoom the page instead of giving us the drag
        const previousTouchAction = targetElement.style.touchAction;
        targetElement.style.touchAction = 'none';

        targetElement.addEventListener('pointerdown', onPointerDown);
        targetElement.addEventListener('pointermove', onPointerMove);
        targetElement.addEventListener('pointerup', onPointerEnd);
        targetElement.addEventListener('pointercancel', onPointerEnd);
        targetElement.addEventListener('pointerleave', onPointerEnd);

        return () => {
            targetElement.removeEventListener('pointerdown', onPointerDown);
            targetElement.removeEventListener('pointermove', onPointerMove);
            targetElement.removeEventListener('pointerup', onPointerEnd);
            targetElement.removeEventListener('pointercancel', onPointerEnd);
            targetElement.removeEventListener('pointerleave', onPointerEnd);
            targetElement.style.touchAction = previousTouchAction;
            activePointers.clear();
            trackedPointer = null;
        };
    }, [targetElement, touchEnabled, touchSensitivity, emit]);

    // Gamepad ----------------------------------------------------------------
    // sticks report a position, not a delta, so they have to be sampled on a loop and scaled by
    // the frame delta to stay frame rate independent.
    useEffect(() => {
        if (!gamepadEnabled || !hasGamepadSupport()) return;
        const [horizontal, vertical] = standardGamepadSticks[gamepadStick];

        let frame: number | null = null;
        let previousTime: number | null = null;

        const deadzoned = (value: number | undefined) =>
            typeof value === 'number' && Math.abs(value) > gamepadDeadzone ? value : 0;

        const tick = (time: number) => {
            frame = window.requestAnimationFrame(tick);
            const delta = previousTime === null ? 0 : (time - previousTime) / 1000;
            previousTime = time;
            // the first frame has no delta to scale by, so there is nothing to apply yet
            if (delta <= 0) return;

            const pads = navigator.getGamepads();
            for (const pad of pads) {
                if (!pad) continue;
                const x = deadzoned(pad.axes[horizontal]);
                const y = deadzoned(pad.axes[vertical]);
                if (x === 0 && y === 0) continue;
                const scale = gamepadSensitivity * Math.min(delta, MAX_FRAME_DELTA);
                emit(x * scale, y * scale);
                // one stick drives the camera; ignore the other pads this frame
                break;
            }
        };

        frame = window.requestAnimationFrame(tick);
        return () => {
            if (frame !== null) window.cancelAnimationFrame(frame);
            frame = null;
        };
    }, [gamepadEnabled, gamepadStick, gamepadDeadzone, gamepadSensitivity, emit]);
}
