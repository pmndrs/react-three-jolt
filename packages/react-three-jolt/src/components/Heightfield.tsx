import { useTexture } from '@react-three/drei';
// React stays a *value* import: this package compiles JSX with the classic runtime, so the
// emitted `React.createElement` calls need it at runtime (biome's organizeImports will offer to
// make it `import type` - don't).
import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { applyHeightmapToPlane } from '../heightField/Generators';
import {
    type HeightfieldScale,
    type HeightGenerator,
    heightfieldMaterialIndices,
    heightfieldToGeometry,
    type MaterialIndexGenerator,
    samplesFromGenerator,
    toSampleArray
} from '../heightField/heightfield';
import type { SurfaceMaterial } from '../heightField/materials';
import { useJolt } from '../hooks';
import type { Vector3Tuple } from '../types';
import { devWarn } from '../utils';

export type HeightfieldProps = {
    /** Heightmap image to sample the terrain from. Loaded asynchronously. */
    url?: string;
    texture?: string;
    /** Width of the field in world units. Ignored when `samples`/`generator` set the scale. */
    width?: number;
    /** Depth of the field in world units. Ignored when `samples`/`generator` set the scale. */
    height?: number;
    /** Samples per edge. Must be a multiple of the block size and at least two blocks wide. */
    size?: number;
    /** Max terrain height for the image path (the white end of the heightmap). */
    displacementScale?: number;
    position?: Vector3Tuple;

    /**
     * Ready made height samples: `size * size` numbers, row major (`row * size + col`). Skips
     * every image load - see `generateHeightfield` for making them from noise.
     */
    samples?: Float32Array | ArrayLike<number>;
    /**
     * Build the heights from a function instead. Called once per sample with the sample's
     * field-local world coordinates (`(0, 0)` is the centre of the field, scaled by `scale`).
     */
    generator?: HeightGenerator;
    /**
     * `[x, y, z]`: distance between samples on x/z and the multiplier applied to the heights.
     * Used by the `samples`/`generator` paths; the field is `(size - 1) * scale` across.
     */
    scale?: HeightfieldScale;

    /** Friction of the whole field (issue #46). */
    friction?: number;
    /** Restitution (bounciness) of the whole field. */
    restitution?: number;
    /**
     * Surfaces this field is made of - `[{ friction: 0.05, name: 'ice' }, { friction: 1.2 }]`.
     * With more than one, `materialIndex` says which quad gets which. Compared by value, so an
     * inline array is fine.
     */
    materials?: SurfaceMaterial[];
    /**
     * Which material each **quad** uses: a `(size - 1)^2` array, or a callback given the quad
     * centre in the same field-local coordinates as `generator`.
     *
     * Compared by identity (a function cannot be compared any other way), so define it outside
     * the component or memoize it - a new function every render rebuilds the body every render.
     * The same goes for `generator` and `samples`.
     */
    materialIndex?: MaterialIndexGenerator | Uint8Array | ArrayLike<number>;
    /** Jolt's heightfield block size (default 2). `size` must be a multiple of it. */
    blockSize?: number;

    /** Material colour for the built in plane material. */
    color?: THREE.ColorRepresentation;
};

// drei's `useTexture` must always be called with a string (rules of hooks forbid skipping it
// conditionally), so when there's no `url` yet we point it at a tiny inert placeholder instead
// of the real heightmap. It's never assigned to the material -- see the effect below.
const EMPTY_TEXTURE_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

type HeightfieldMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;

/**
 * A static heightfield body and the mesh that draws it.
 *
 * Three ways to say what the terrain looks like, in order of precedence:
 *
 * ```tsx
 * <Heightfield samples={samples} size={64} scale={[2, 20, 2]} />   // raw samples (issue #45)
 * <Heightfield generator={(x, z) => Math.sin(x * 0.1) * 4} size={64} />
 * <Heightfield url="heightmaps/wp1024.png" size={512} />           // image, asynchronous
 * ```
 *
 * `samples` and `generator` are **synchronous**: the geometry and the body exist by the time the
 * component has mounted, which is what makes them testable and what keeps the drawn mesh and the
 * simulated field the same numbers. The image path still loads (and can be superseded or
 * cancelled) asynchronously - see #152.
 */
export function Heightfield({
    url,
    texture,
    width = 128,
    height = 128,
    size = 256,
    displacementScale = 256 * 0.1,
    samples,
    generator,
    scale,
    friction,
    restitution,
    materials,
    materialIndex,
    blockSize,
    color = '#8F2D56',
    ...props
}: HeightfieldProps) {
    const planeRef = useRef<HeightfieldMesh>(null);
    // number | null (not falsy checks) -- a real body handle can be 0.
    const activeBody: React.MutableRefObject<number | null> = useRef(null);

    const { bodySystem } = useJolt();
    // if an image url is passed, use drei's (suspenseful) loader for the display texture
    const urlTexture = useTexture(url ?? EMPTY_TEXTURE_URL);

    const [scaleX, scaleY, scaleZ] = scale ?? [1, 1, 1];

    /**
     * The generated geometry, when there is one. `samples` wins over `generator`; with neither,
     * this is `undefined` and the image path builds a plain `<planeGeometry>` below.
     *
     * Generation is synchronous (see the module comment on `heightField/heightfield.ts`): a
     * 512x512 field is a few milliseconds, anything much larger should be generated off the
     * render path and handed in through `samples`.
     */
    const generated = useMemo(() => {
        if (!samples && !generator) return undefined;
        const heights = samples
            ? toSampleArray(samples)
            : samplesFromGenerator(size, generator!, scaleX, blockSize).samples;
        return heightfieldToGeometry(heights, size, [scaleX, scaleY, scaleZ]);
    }, [samples, generator, size, scaleX, scaleY, scaleZ, blockSize]);

    // a geometry we made is a geometry we dispose
    useEffect(() => () => generated?.dispose(), [generated]);

    // Materials are plain data, so they are compared by value: `materials={[{ friction: 1 }]}`
    // written inline is a new array every render, and rebuilding the body for that would be a
    // nasty surprise. (A `materialIndex` *function* can only be compared by identity - hence the
    // note on the prop.)
    const materialKey = materials ? JSON.stringify(materials) : '';
    // (the dep is materialKey, deliberately, not materials)
    const stableMaterials = useMemo(() => materials, [materialKey]);

    const indices = useMemo(() => {
        if (!materialIndex || !stableMaterials || stableMaterials.length < 2) return undefined;
        return heightfieldMaterialIndices(size, materialIndex, scaleX);
    }, [materialIndex, stableMaterials, size, scaleX]);

    // the plane ships facing up; the image path's `<planeGeometry>` only ever needs rotating
    // once (a generated geometry comes out of `heightfieldToGeometry` already flat)
    useEffect(() => {
        if (generated) return;
        planeRef.current?.geometry.rotateX(-Math.PI / 2);
    }, [generated]);

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
        if (!mesh) return;
        const bodyOptions = {
            friction,
            restitution,
            materials: stableMaterials,
            materialIndices: indices,
            blockSize
        };

        // the generated paths have their heights already; no load, no race, no async at all
        if (generated) {
            activeBody.current = bodySystem.addHeightfield(mesh, bodyOptions);
            return () => {
                if (activeBody.current !== null) {
                    bodySystem.removeBody(activeBody.current, true);
                    activeBody.current = null;
                }
            };
        }
        if (!url) return;

        let cancelled = false;
        const controller = new AbortController();

        applyHeightmapToPlane(mesh, url, displacementScale, controller.signal)
            .then(() => {
                if (cancelled) return;
                activeBody.current = bodySystem.addHeightfield(mesh, bodyOptions);
            })
            .catch((error: unknown) => {
                if (cancelled || controller.signal.aborted) return;
                devWarn('Heightfield: failed to load height map', url, error);
            });

        return () => {
            cancelled = true;
            controller.abort();
            if (activeBody.current !== null) {
                bodySystem.removeBody(activeBody.current, true);
                activeBody.current = null;
            }
        };
    }, [
        url,
        displacementScale,
        bodySystem,
        generated,
        friction,
        restitution,
        stableMaterials,
        indices,
        blockSize
    ]);

    return (
        <mesh ref={planeRef} {...props}>
            {generated ? (
                <primitive object={generated} attach="geometry" />
            ) : (
                <planeGeometry args={[width, height, size - 1, size - 1]} />
            )}
            <meshStandardMaterial transparent={true} color={color} side={THREE.DoubleSide} />
        </mesh>
    );
}
