// Issue #54 (memory profiler): two small pieces that together put a live number on screen for
// leak hunting.
//
// `<JoltMemoryRegistrar>` has to be mounted *inside* `<Physics>` - `useJolt()` only works there -
// so it lives in every demo's Physics tree, right next to the other props read off `useDemo()`.
// It renders nothing (r3f's Canvas tree can't host plain DOM), it only publishes the active
// world's `joltInterface` to `joltMemory.ts`'s module-level slot.
//
// `<JoltMemoryReadout>` is the actual UI: an always-outside-the-canvas DOM overlay that polls
// that slot. It is cheap and harmless to mount for every variant, but per the issue it only
// renders anything for `debug-wasm-compat`.
import { useJolt } from '@react-three/jolt';
import { useEffect, useState } from 'react';
import { readJoltMemory, registerActiveJoltInterface } from './joltMemory';
import type { JoltVariant } from './joltModules';

/** Mount once inside every demo's `<Physics>` tree. */
export function JoltMemoryRegistrar() {
    const { joltInterface } = useJolt();
    useEffect(() => {
        registerActiveJoltInterface(joltInterface ?? null);
        return () => registerActiveJoltInterface(null);
    }, [joltInterface]);
    return null;
}

const bytesToMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** Mount once, outside the `<Canvas>`, in the app's DOM overlay. */
export function JoltMemoryReadout({ variant }: { variant: JoltVariant }) {
    const [reading, setReading] = useState(() => readJoltMemory());

    useEffect(() => {
        if (variant !== 'debug-wasm-compat') return;
        const id = window.setInterval(() => setReading(readJoltMemory()), 500);
        return () => window.clearInterval(id);
    }, [variant]);

    if (variant !== 'debug-wasm-compat' || !reading) return null;

    const usedBytes = reading.totalBytes - reading.freeBytes;
    return (
        <div
            style={{
                position: 'absolute',
                bottom: 12,
                left: 12,
                padding: '6px 10px',
                background: 'rgba(0, 0, 0, 0.65)',
                color: '#9EE493',
                fontFamily: 'monospace',
                fontSize: 12,
                borderRadius: 4,
                pointerEvents: 'none'
            }}
        >
            jolt heap: {bytesToMB(usedBytes)} / {bytesToMB(reading.totalBytes)} MB used
        </div>
    );
}
