// Step hooks (issue #157). Forces applied from `useFrame` are frame rate dependent, because a
// frame may run zero, one or five physics substeps; these run per *substep*, which is the only
// place a force means a fixed amount of momentum.

import { useEffect } from 'react';
import type { StepCallback } from '../systems/events';
import { useEventCallback, useJolt } from './hooks';

/**
 * Run `fn(deltaTime, subframe)` immediately before each physics substep, before pending body
 * actions are applied and before `Step()`. The subscription is removed on unmount.
 *
 * The callback is held in a ref, so an inline arrow does not resubscribe on every render, and
 * the effect's cleanup is the unsubscribe handle itself - which is what makes it StrictMode
 * safe (mount, unmount, mount leaves exactly one subscription).
 */
export function useBeforePhysicsStep(fn: StepCallback): void {
    const { physicsSystem } = useJolt();
    const callback = useEventCallback(fn);
    useEffect(() => {
        if (!physicsSystem) return;
        return physicsSystem.onBeforeStep(callback);
    }, [physicsSystem, callback]);
}

/**
 * Run `fn(deltaTime, subframe)` after each physics substep, once the contact, sensor and
 * sleep/wake events produced by that step have been dispatched. The subscription is removed on
 * unmount.
 */
export function useAfterPhysicsStep(fn: StepCallback): void {
    const { physicsSystem } = useJolt();
    const callback = useEventCallback(fn);
    useEffect(() => {
        if (!physicsSystem) return;
        return physicsSystem.onAfterStep(callback);
    }, [physicsSystem, callback]);
}
