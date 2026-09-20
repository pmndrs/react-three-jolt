import { useTexture } from '@react-three/drei';
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { applyHeightmapToPlane } from '../heightField/Generators';
import { useJolt } from '../hooks';
import type { Vector3Tuple } from '../types';

export type HeightfieldProps = {
    url?: string;
    texture?: string;
    width?: number;
    height?: number;
    size?: number;
    displacementScale?: number;
    position?: Vector3Tuple;
};

// drei's `useTexture` must always be called with a string (rules of hooks forbid skipping it
// conditionally), so when there's no `url` yet we point it at a tiny inert placeholder instead
// of the real heightmap. It's never assigned to the material -- see the effect below.
const EMPTY_TEXTURE_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

type HeightfieldMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

export function Heightfield({
    url,
    texture,
    width = 128,
    height = 128,
    size = 256,
    displacementScale = 256 * 0.1,
    ...props
}: HeightfieldProps) {
    const planeRef = useRef<HeightfieldMesh>(null);
    // number | null (not falsy checks) -- a real body handle can be 0.
    const activeBody: React.MutableRefObject<number | null> = useRef(null);

    const { bodySystem } = useJolt();
    // if an image url is passed, use drei's (suspenseful) loader for the display texture
    const urlTexture = useTexture(url ?? EMPTY_TEXTURE_URL);

    // the plane ships facing up; it only ever needs to be rotated once
    useEffect(() => {
        planeRef.current?.geometry.rotateX(-Math.PI / 2);
    }, []);

    // apply the loaded texture to the material, unless an explicit named `texture` is used instead
    useEffect(() => {
        if (texture || !url || !planeRef.current) return;
        planeRef.current.material.map = urlTexture;
    }, [texture, url, urlTexture]);

    // Load the heightmap and (re)build the jolt body whenever the source changes.
    //
    // Fixes #152: this used to be a bare `async` effect with no cancellation, so if `url`
    // changed (or the component unmounted) before a previous load resolved, whichever load
    // finished *last* won -- not necessarily the most recent one -- and its body was never
    // cleaned up. `cancelled` (closed over by this effect run only) and the AbortController
    // make a superseded/unmounted load a no-op: it neither creates a body nor touches the
    // mesh. The body this effect run owns is removed in its own cleanup, which React runs
    // before the next run's effect body, so at most one heightfield body exists at a time.
    useEffect(() => {
        const mesh = planeRef.current;
        if (!mesh || !url) return;

        let cancelled = false;
        const controller = new AbortController();

        applyHeightmapToPlane(mesh, url, displacementScale, controller.signal)
            .then(() => {
                if (cancelled) return;
                activeBody.current = bodySystem.addHeightfield(mesh);
            })
            .catch((error: unknown) => {
                if (cancelled || controller.signal.aborted) return;
                console.warn('Heightfield: failed to load height map', url, error);
            });

        return () => {
            cancelled = true;
            controller.abort();
            if (activeBody.current !== null) {
                bodySystem.removeBody(activeBody.current, true);
                activeBody.current = null;
            }
        };
    }, [url, displacementScale, bodySystem]);

    return (
        <mesh ref={planeRef} {...props}>
            <planeGeometry args={[width, height, size - 1, size - 1]} />
            <meshStandardMaterial transparent={true} color="#8F2D56" side={THREE.DoubleSide} />
        </mesh>
    );
}
