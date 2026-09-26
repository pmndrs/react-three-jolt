// Subscription helpers behind the `<RigidBody on*>` / `<Physics on*>` props (issues #32, #21,
// #156).
//
// Two things make these correct where the hand rolled effect in RigidBody was not: the
// dependency is the *body instance* (a mutable `ref.current` in a dep array is not reactive, so
// the old effect never registered on the pass that created the body), and the effect's cleanup
// is the unsubscribe handle rather than a removal by function identity, which could never match
// an inline arrow.

import { useEffect } from 'react';
import type { BodyState } from '../systems/body-state';
import type { BodyEventMap, SoftBodyEventMap, WorldEventMap } from '../systems/events';
import type { PhysicsSystem } from '../systems/physics-system';
import type { SoftBodyState } from '../systems/soft-body-system';
import { useEventCallback, useJolt } from './hooks';

/** Subscribe `handler` to one of `body`'s events for as long as both exist. */
export function useBodyEvent<K extends keyof BodyEventMap>(
    body: BodyState | undefined,
    type: K,
    handler: BodyEventMap[K] | undefined
): void {
    const callback = useEventCallback(handler);
    // Depend on *whether* there is a handler, not on its identity: an inline arrow would
    // otherwise resubscribe on every render.
    const enabled = handler !== undefined;
    useEffect(() => {
        if (!body || !enabled) return;
        return body.on(type, callback as BodyEventMap[K]);
    }, [body, enabled, type, callback]);
}

/** Subscribe `handler` to one of `body`'s events, for a `<SoftBody>` (issue #245). Same contract
 * as {@link useBodyEvent}. */
export function useSoftBodyEvent<K extends keyof SoftBodyEventMap>(
    body: SoftBodyState | undefined,
    type: K,
    handler: SoftBodyEventMap[K] | undefined
): void {
    const callback = useEventCallback(handler);
    const enabled = handler !== undefined;
    useEffect(() => {
        if (!body || !enabled) return;
        return body.on(type, callback as SoftBodyEventMap[K]);
    }, [body, enabled, type, callback]);
}

/** Subscribe `handler` to one of a world's events. */
export function useSystemEvent<K extends keyof WorldEventMap>(
    system: PhysicsSystem | undefined,
    type: K,
    handler: WorldEventMap[K] | undefined
): void {
    const callback = useEventCallback(handler);
    const enabled = handler !== undefined;
    useEffect(() => {
        if (!system || !enabled) return;
        return system.events.on(type, callback as WorldEventMap[K]);
    }, [system, enabled, type, callback]);
}

/** Subscribe to a world event from inside `<Physics>`. Unsubscribes on unmount. */
export function useWorldEvent<K extends keyof WorldEventMap>(
    type: K,
    handler: WorldEventMap[K]
): void {
    const { physicsSystem } = useJolt();
    useSystemEvent(physicsSystem, type, handler);
}
