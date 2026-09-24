// useBuoyancy (issue #240): imperative access to a world's water volume registry - the same
// registry `<Water>` adds itself to. Useful for a volume that doesn't map onto a single mounted
// component, or that needs to be added/removed outside of React's render cycle entirely.

import { useMemo } from 'react';
import type { BuoyancyVolumeOptions } from '../systems/buoyancy-system';
import { useJolt } from './hooks';

export interface BuoyancyControls {
    /** Register a new water volume. Returns an id, used to {@link updateVolume} or {@link removeVolume} it. */
    addVolume(options?: BuoyancyVolumeOptions): number;
    /** Replace a volume's options wholesale (not merged). No-op for an unknown id. */
    updateVolume(id: number, options?: BuoyancyVolumeOptions): void;
    /** Remove a previously added volume. Safe to call more than once, or with an unknown id. */
    removeVolume(id: number): void;
    /** Every currently registered volume's id. */
    volumeIds(): number[];
}

/**
 * Imperative access to the world's water volumes - the registry `<Water>` itself is built on.
 *
 * ```tsx
 * function CustomVolume() {
 *     const { addVolume, removeVolume } = useBuoyancy();
 *     useEffect(() => {
 *         const id = addVolume({ position: [0, 0, 0], size: [20, 6, 20], buoyancy: 1.2 });
 *         return () => removeVolume(id);
 *     }, [addVolume, removeVolume]);
 *     return null;
 * }
 * ```
 *
 * The returned object is stable for the lifetime of the `<Physics>` world - calling the hook
 * does not itself add or remove anything - so it is safe to keep in a ref or read from a
 * `useFrame` callback.
 */
export function useBuoyancy(): BuoyancyControls {
    const { physicsSystem } = useJolt();
    return useMemo<BuoyancyControls>(() => {
        const system = physicsSystem.getBuoyancySystem();
        return {
            addVolume: (options) => system.addVolume(options),
            updateVolume: (id, options) => system.updateVolume(id, options),
            removeVolume: (id) => {
                system.removeVolume(id);
            },
            volumeIds: () => system.volumeIds()
        };
    }, [physicsSystem]);
}
