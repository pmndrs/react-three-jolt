// Ring buffer rewind helper built on PhysicsSystem.saveState()/restoreState() (issue #247).

import type Jolt from 'jolt-physics';
import { useCallback, useEffect, useRef } from 'react';
import type { PhysicsSnapshot } from '../systems';
import { useConst, useJolt } from './hooks';
import { useAfterPhysicsStep } from './use-physics-step';

export interface UseRewindOptions {
    /**
     * Ring buffer capacity: how many snapshots to keep before the oldest is dropped and its WASM
     * heap freed. Each snapshot is a full world save, so pick this with `PhysicsSystem.saveState`'s
     * `state`/`filter` narrowing in mind if you need a long history. Default `300`.
     */
    frames?: number;
    /** Record a snapshot every `interval` physics substeps rather than every one. Default `1`. */
    interval?: number;
    /** What to save - see `PhysicsSystem.saveState`. Default is Jolt's own default (everything). */
    state?: Jolt.EStateRecorderState;
}

export interface UseRewindApi {
    /**
     * Rewind `n` recorded frames back from the most recent recording (`1` is the last one taken,
     * `2` the one before that, and so on). Restores the world to that snapshot and drops every
     * snapshot recorded after it - once you resume stepping, that recorded future never happened
     * - freeing each one as it goes.
     *
     * @returns `false` (and does nothing) if there's nothing that far back yet, or the world has
     * been destroyed; otherwise Jolt's own `RestoreState` success flag.
     */
    rewind: (n: number) => boolean;
    /** Free every buffered snapshot and empty the ring buffer. */
    clear: () => void;
    /**
     * How many snapshots are currently buffered, `0..frames`. Not reactive - this reads the
     * buffer's live length, so call it from your own render loop (`useFrame`, a slider's
     * `onPointerDown`) rather than expecting a React re-render when it changes.
     */
    getFrameCount: () => number;
}

/**
 * Record a rolling history of {@link PhysicsSystem.saveState} snapshots and rewind the world back
 * into one of them on demand - the building block behind a scrub-back / replay demo. Recording
 * happens from `onAfterStep`, so `frames` covers physics substeps, not render frames.
 *
 * The buffer belongs to this hook: it is freed on unmount, and `rewind()`/`clear()` free whatever
 * snapshots they drop as they go, so nothing here leaks WASM heap on its own. Keeping `frames`
 * large trades heap for history depth - each entry is a full world save.
 */
export function useRewind(options: UseRewindOptions = {}): UseRewindApi {
    const frames = Math.max(1, Math.floor(options.frames ?? 300));
    const interval = Math.max(1, Math.floor(options.interval ?? 1));
    const { state } = options;
    const { physicsSystem } = useJolt();

    const buffer = useConst<PhysicsSnapshot[]>(() => []);
    const stepCount = useRef(0);

    // `useAfterPhysicsStep` holds this in a ref internally (see `useEventCallback`) and only
    // resubscribes when `physicsSystem` changes, so a fresh closure every render is fine - it
    // always reads the latest `interval`/`frames`/`state`, same as every other consumer of this
    // hook in the codebase.
    useAfterPhysicsStep(() => {
        stepCount.current++;
        if (stepCount.current % interval !== 0) return;
        if (!physicsSystem || physicsSystem.destroyed) return;
        buffer.push(physicsSystem.saveState(state));
        while (buffer.length > frames) {
            buffer.shift()?.destroy();
        }
    });

    const rewind = useCallback(
        (n: number): boolean => {
            if (!physicsSystem || physicsSystem.destroyed) return false;
            const index = buffer.length - n;
            if (index < 0 || index >= buffer.length) return false;
            const restored = physicsSystem.restoreState(buffer[index]);
            // everything after the frame we rewound to is a future that no longer happens once
            // the caller resumes stepping - drop and free it instead of leaving it to be
            // silently skipped over by the next recording.
            for (let i = index + 1; i < buffer.length; i++) buffer[i].destroy();
            buffer.length = index + 1;
            return restored;
        },
        [physicsSystem, buffer]
    );

    const clear = useCallback(() => {
        for (const snapshot of buffer) snapshot.destroy();
        buffer.length = 0;
    }, [buffer]);

    const getFrameCount = useCallback(() => buffer.length, [buffer]);

    // Unmount-only cleanup: `clear`'s identity only ever changes with `buffer`, which is a
    // `useConst` and therefore never does, so this effect never re-runs early.
    useEffect(() => clear, [clear]);

    return { rewind, clear, getFrameCount };
}
