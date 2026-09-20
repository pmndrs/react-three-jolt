// creates a jolt constrain given two bodies

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Raw } from '../raw';
import { AdvancedRaycaster, Multicaster, Raycaster, type RaycastHit } from '../systems';
import { useConst, useJolt, useUnmount } from './hooks';

// helper function to take a list of bodies and add them to the same filter group

export const useRaycaster = (
    origin?: THREE.Vector3 | number[] | null,
    direction?: THREE.Vector3 | number[] | null,
    type?: string
) => {
    const { physicsSystem } = useJolt();
    // Tears down the previous raycaster (freeing its jolt allocations) whenever a memo dep
    // changes, not just at unmount - a bare `useMemo` would otherwise leak every raycaster it
    // replaces, since only the LAST instance would ever reach the useUnmount below. Mirrors
    // useMouseRaycaster (issue #192).
    const previous = useRef<Raycaster | null>(null);
    const raycaster: Raycaster = useMemo(() => {
        previous.current?.destroy();
        const caster: Raycaster = physicsSystem.getRaycaster();
        //@ts-ignore
        if (origin) caster.origin = origin;
        //@ts-ignore
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);
        previous.current = caster;
        return caster;
    }, [origin, direction, type, physicsSystem]);
    /* lets try with a memo first
    useImperativeInstance(
        () => {
            raycaster.current = physicsSystem.getRaycaster();
        if (origin) raycaster.current.origin = origin;
        if (direction) raycaster.current.direction = direction;

        },
        (rawConstraint) => {
            //  physicsSystem.constraintSystem.removeConstraint(rawConstraint);
        },
        []
    );
    */
    useUnmount(() => {
        raycaster.destroy();
    });
    return raycaster;
};

export const useAdvancedRaycaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type?: string
) => {
    const { physicsSystem } = useJolt();
    // see useRaycaster above - without this, every dep change leaked the previous instance
    // instead of only the very last one being freed on unmount (issue #192).
    const previous = useRef<AdvancedRaycaster | null>(null);
    const raycaster: AdvancedRaycaster = useMemo(() => {
        previous.current?.destroy();
        const caster = physicsSystem.getAdvancedRaycaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);
        previous.current = caster;
        return caster;
    }, [origin, direction, type, physicsSystem]);
    useUnmount(() => {
        raycaster.destroy();
    });
    return raycaster;
};

export const useMulticaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type?: string
) => {
    const { physicsSystem } = useJolt();
    // see useRaycaster above - Multicaster owns a Raycaster (and its jolt allocations), so the
    // same leak-on-dep-change applies to it (issue #192).
    const previous = useRef<Multicaster | null>(null);
    const raycaster: Multicaster = useMemo(() => {
        previous.current?.destroy();
        const caster = physicsSystem.getMulticaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);
        previous.current = caster;
        return caster;
    }, [origin, direction, type, physicsSystem]);

    useUnmount(() => {
        raycaster.destroy();
    });
    return raycaster;
};

//* Mouse Raycaster =====================================
// issue #47: a ready-to-go raycaster driven by the mouse/pointer, for picking up or shooting at
// whatever is under the cursor.

export type MouseRaycasterMode = 'frame' | 'pointermove';

// the filters a Raycaster exposes as plain, swappable public fields (see raycasters.ts) - passing
// one here transfers ownership of it to the raycaster this hook creates: it replaces (and frees)
// the default filter, and will free yours too on the next filter change or on unmount, so don't
// share a single filter instance across multiple raycasters this hook manages.
export type MouseRaycasterFilter = Partial<
    Pick<Raycaster, 'bpFilter' | 'objectFilter' | 'bodyFilter' | 'shapeFilter'>
>;

export type UseMouseRaycasterOptions = {
    /** Collector type passed to `Raycaster.setCollector()`. Defaults to `'closest'`. */
    type?: string;
    /**
     * `'frame'` (default) rebuilds the ray from the current pointer position every rendered
     * frame, so it stays correct even when only the camera moves. `'pointermove'` only rebuilds
     * it on real `pointermove` events against the canvas.
     */
    mode?: MouseRaycasterMode;
    /** Ray length. Defaults to `camera.far`. */
    length?: number;
    /** Called with the latest hit (or `undefined` on a miss) every time the ray is cast. */
    onHit?: (hit: RaycastHit | RaycastHit[] | undefined) => void;
    filter?: MouseRaycasterFilter;
};

export type UseMouseRaycasterResult = {
    raycaster: Raycaster;
    /**
     * Mutable ref updated in place on every cast instead of React state, so a fast-moving pointer
     * doesn't force a re-render every frame - read `hit.current` from a `useFrame` callback, an
     * event handler, or `onHit`.
     */
    hit: { current: RaycastHit | RaycastHit[] | undefined };
};

const applyMouseRaycasterFilters = (raycaster: Raycaster, filter?: MouseRaycasterFilter) => {
    if (!filter) return;
    if (filter.bpFilter) {
        Raw.module.destroy(raycaster.bpFilter);
        raycaster.bpFilter = filter.bpFilter;
    }
    if (filter.objectFilter) {
        Raw.module.destroy(raycaster.objectFilter);
        raycaster.objectFilter = filter.objectFilter;
    }
    if (filter.bodyFilter) {
        Raw.module.destroy(raycaster.bodyFilter);
        raycaster.bodyFilter = filter.bodyFilter;
    }
    if (filter.shapeFilter) {
        Raw.module.destroy(raycaster.shapeFilter);
        raycaster.shapeFilter = filter.shapeFilter;
    }
};

/**
 * Builds a world-space ray from the mouse/pointer (every frame, or on real pointer-move events)
 * and runs an existing jolt `Raycaster` with it - the r3f-flavoured equivalent of three.js's own
 * `THREE.Raycaster.setFromCamera()`, but against physics bodies instead of the three.js scene
 * graph. Useful for picking up or shooting at whatever is under the cursor.
 */
export const useMouseRaycaster = (
    options: UseMouseRaycasterOptions = {}
): UseMouseRaycasterResult => {
    const { type = 'closest', mode = 'frame', length, onHit, filter } = options;
    const { physicsSystem } = useJolt();
    const camera = useThree((state) => state.camera);
    const pointer = useThree((state) => state.pointer);
    const size = useThree((state) => state.size);
    const gl = useThree((state) => state.gl);

    // Tears down the previous raycaster (freeing its jolt allocations) whenever `type`/`filter`
    // change, not just at unmount - a bare `useMemo` would otherwise leak every raycaster it
    // replaces, since only the LAST instance would ever reach the useUnmount below.
    const previous = useRef<Raycaster | null>(null);
    const raycaster: Raycaster = useMemo(() => {
        previous.current?.destroy();
        const caster = physicsSystem.getRaycaster();
        caster.setCollector(type);
        applyMouseRaycasterFilters(caster, filter);
        previous.current = caster;
        return caster;
    }, [physicsSystem, type, filter]);

    const hit = useConst<{ current: RaycastHit | RaycastHit[] | undefined }>(() => ({
        current: undefined
    }));
    // three.js already knows how to turn NDC pointer coordinates + a camera into a world-space
    // ray; reuse that instead of re-deriving it from the camera's projection matrix ourselves.
    const threeRaycaster = useConst(() => new THREE.Raycaster());
    const ndc = useConst(() => new THREE.Vector2());

    const castFromNdc = useCallback(
        (ndcX: number, ndcY: number) => {
            ndc.set(ndcX, ndcY);
            threeRaycaster.setFromCamera(ndc, camera);
            const rayLength = length ?? camera.far;
            raycaster.origin = threeRaycaster.ray.origin;
            raycaster.direction = threeRaycaster.ray.direction.clone().multiplyScalar(rayLength);
            const result = raycaster.cast() as RaycastHit | RaycastHit[] | undefined;
            hit.current = result;
            onHit?.(result);
        },
        [raycaster, camera, length, onHit, hit, threeRaycaster, ndc]
    );

    const castFromPointerState = useCallback(
        () => castFromNdc(pointer.x, pointer.y),
        [castFromNdc, pointer]
    );

    useFrame(() => {
        if (mode === 'frame') castFromPointerState();
    });

    useEffect(() => {
        if (mode !== 'pointermove') return;
        const dom = gl.domElement;
        // computed the same way r3f's own pointer-event system derives NDC coordinates from a
        // DOM event, so this matches `pointer` exactly if/when a real pointermove also fires.
        const handlePointerMove = (event: PointerEvent) => {
            const target = event.target as HTMLElement | null;
            const rect = target?.getBoundingClientRect?.();
            const offsetX = rect ? event.clientX - rect.left : event.clientX;
            const offsetY = rect ? event.clientY - rect.top : event.clientY;
            castFromNdc((offsetX / size.width) * 2 - 1, -(offsetY / size.height) * 2 + 1);
        };
        dom.addEventListener('pointermove', handlePointerMove);
        return () => dom.removeEventListener('pointermove', handlePointerMove);
    }, [mode, gl, size, castFromNdc]);

    useUnmount(() => {
        raycaster.destroy();
    });

    return { raycaster, hit };
};
