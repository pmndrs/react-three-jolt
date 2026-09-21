/**
 * First class heightfield generation (issue #45) - no image required.
 *
 * A Jolt heightfield is `size * size` float samples in row major order: index `row * size + col`
 * is the height at grid position `(col, row)`. This module builds those samples (from noise or
 * from your own callback) and the matching `PlaneGeometry`, so what is drawn and what is
 * simulated are the *same numbers* rather than two independent samplings of an image.
 *
 * ## Coordinates
 *
 * Both `generateHeightfield` and `<Heightfield generator>` hand the sampler **field local world
 * coordinates**: `(0, 0)` is the centre of the field, x grows with the column index and z grows
 * with the row index, both in units of `spacing`. That is exactly where the corresponding
 * vertex of {@link heightfieldToGeometry} ends up, so `(x, z) => Math.sin(x * 0.1)` does what it
 * looks like it does.
 *
 * ## Synchronous
 *
 * Generation runs on the calling thread. A 512x512 field with 4 octaves is ~1M noise samples,
 * a handful of milliseconds; a 2048x2048 one is not, and it will drop frames. There is no
 * built in worker: pass `samples` you generated wherever you like (a worker, the server, a
 * previous session) to `<Heightfield samples={...}>` and nothing here has to move off thread.
 */

import * as THREE from 'three';
import { getValidatedHeightfieldSampleCount } from './generators';
import { type FbmOptions, fbm2, type NoiseKind, resolveNoise } from './noise';

/** Distance between samples on x and z, and the multiplier applied to the height. */
export type HeightfieldScale = [x: number, y: number, z: number];

/** A generated field: the samples Jolt needs plus the range they cover. */
export interface HeightfieldData {
    /** `size * size` heights, row major (`row * size + col`). */
    samples: Float32Array;
    /** Samples per edge. */
    size: number;
    min: number;
    max: number;
}

/** `(x, z) => height`, in field local world coordinates (see the module comment). */
export type HeightGenerator = (x: number, z: number) => number;

export interface GenerateHeightfieldOptions extends FbmOptions {
    /** Samples per edge. Must satisfy Jolt's block-size rule - see {@link validateHeightfieldSize}. */
    size: number;
    /** `'psrd'` (the default, the ported psrddnoise), `'simplex'`, or your own `(x, z) => value`. */
    noise?: NoiseKind;
    /** Distance between samples in world units; the sampler sees `x`/`z` scaled by it. */
    spacing?: number;
    /** Jolt's heightfield block size, used only to validate `size`. */
    blockSize?: number;
}

/**
 * Check `size` against Jolt's real `HeightFieldShapeSettings` constraint (square, a multiple of
 * the block size, at least two blocks per edge) and hand it back. Throws with a message naming
 * the nearest valid sizes otherwise.
 */
export const validateHeightfieldSize = (size: number, blockSize = 2): number =>
    getValidatedHeightfieldSampleCount(size * size, blockSize);

/** Where sample `index` along an edge sits, in field local world units. */
const axisPosition = (index: number, size: number, spacing: number) =>
    (index - (size - 1) / 2) * spacing;

/**
 * Sample any `(x, z) => height` function into a Jolt-ready sample grid.
 *
 * This is what `<Heightfield generator={...}>` uses.
 */
export function samplesFromGenerator(
    size: number,
    generator: HeightGenerator,
    spacing = 1,
    blockSize = 2
): HeightfieldData {
    validateHeightfieldSize(size, blockSize);
    const samples = new Float32Array(size * size);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < size; row++) {
        const z = axisPosition(row, size, spacing);
        for (let col = 0; col < size; col++) {
            const index = row * size + col;
            samples[index] = generator(axisPosition(col, size, spacing), z);
            // read back the stored float32, so min/max are values that really are in the array
            const height = samples[index];
            if (height < min) min = height;
            if (height > max) max = height;
        }
    }
    return { samples, size, min, max };
}

/**
 * Generate a heightfield from noise.
 *
 * Deterministic: the same `{ size, noise, octaves, frequency, amplitude, seed, ... }` always
 * produces the same samples, on any machine. `seed` is applied as a large coordinate offset
 * (neither noise takes a seed of its own - see `noise.ts`).
 *
 * ```ts
 * const { samples } = generateHeightfield({ size: 64, noise: 'psrd', octaves: 4, seed: 7 });
 * <Heightfield samples={samples} size={64} scale={[2, 20, 2]} />
 * ```
 */
export function generateHeightfield({
    size,
    noise = 'psrd',
    spacing = 1,
    blockSize = 2,
    octaves = 4,
    // ~4 features across the field whatever the resolution, so `size` alone never changes
    // the shape of the terrain - only how finely it is sampled
    frequency = 4 / (size * spacing),
    amplitude = 1,
    lacunarity = 2,
    gain = 0.5,
    seed = 0
}: GenerateHeightfieldOptions): HeightfieldData {
    const sample = resolveNoise(noise);
    const fbmOptions: FbmOptions = { octaves, frequency, amplitude, lacunarity, gain, seed };
    return samplesFromGenerator(size, (x, z) => fbm2(sample, x, z, fbmOptions), spacing, blockSize);
}

/** Accepts anything sample shaped and normalises it to the `Float32Array` Jolt wants. */
export const toSampleArray = (samples: ArrayLike<number>): Float32Array =>
    samples instanceof Float32Array ? samples : Float32Array.from(samples);

/**
 * Build the `PlaneGeometry` that matches a set of heightfield samples: `size - 1` segments per
 * edge, already rotated so that **+y is up** (the orientation the physics side samples), with
 * every vertex's height taken straight from `samples`.
 *
 * `scale` is `[x, y, z]`: x/z are the distance between samples and y multiplies the heights, so
 * the geometry's width is `(size - 1) * scaleX` - exactly the extent the Jolt shape covers.
 * Feeding this geometry to `bodySystem.addHeightfield` (which is what `<Heightfield>` does)
 * round trips the same numbers back out, so render and physics can't drift apart.
 */
export function heightfieldToGeometry(
    samples: ArrayLike<number>,
    size: number,
    scale: HeightfieldScale = [1, 1, 1]
): THREE.PlaneGeometry {
    const [scaleX, scaleY, scaleZ] = scale;
    if (samples.length < size * size)
        throw new Error(
            `Heightfield: expected ${size * size} samples for a ${size}x${size} field, got ${samples.length}.`
        );
    const geometry = new THREE.PlaneGeometry(
        (size - 1) * scaleX,
        (size - 1) * scaleZ,
        size - 1,
        size - 1
    );
    // the plane ships facing +z; lay it flat so its vertex y is the height
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < size * size; i++) positions[i * 3 + 1] = samples[i] * scaleY;
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    return geometry;
}

/** `(x, z) => materialIndex`, in field local world coordinates, called once per **quad**. */
export type MaterialIndexGenerator = (x: number, z: number) => number;

/**
 * Build Jolt's per-quad material index map: `(size - 1)^2` bytes, row major, one per quad.
 *
 * A callback is sampled at each quad's centre in the same field local coordinates the height
 * generator sees; an existing array is validated and copied.
 */
export function heightfieldMaterialIndices(
    size: number,
    source: MaterialIndexGenerator | ArrayLike<number>,
    spacing = 1
): Uint8Array {
    const quads = (size - 1) * (size - 1);
    if (typeof source !== 'function') {
        if (source.length !== quads)
            throw new Error(
                `Heightfield: materialIndex needs one entry per quad - ${quads} for a ${size}x${size} ` +
                    `field (size - 1 squared), got ${source.length}.`
            );
        return source instanceof Uint8Array ? source : Uint8Array.from(source);
    }
    const indices = new Uint8Array(quads);
    for (let row = 0; row < size - 1; row++) {
        // quad centres sit half a step past the sample they start at
        const z = axisPosition(row, size, spacing) + spacing / 2;
        for (let col = 0; col < size - 1; col++) {
            const x = axisPosition(col, size, spacing) + spacing / 2;
            indices[row * (size - 1) + col] = source(x, z);
        }
    }
    return indices;
}
