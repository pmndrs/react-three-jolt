/**
 * CPU noise for heightfield generation (issue #45).
 *
 * The `.glsl` files next to this module are the original GPU implementations of Stefan
 * Gustavson and Ian McEwan's "psrdnoise" (periodic, simplex, rotating, derivative noise,
 * https://github.com/stegu/psrdnoise/, MIT licensed). They are still here for anyone rendering
 * or displacing on the GPU, but a *physics* heightfield has to exist as numbers on the CPU -
 * Jolt reads the samples straight out of a JS array - so this file is a line-by-line port of
 * `psrdnoise2-min.glsl` plus the classic 2D simplex noise, both in plain TypeScript.
 *
 * Everything here is deterministic and allocation free in the hot loop: the same inputs always
 * produce the same outputs, which is what makes `generateHeightfield({ seed })` reproducible.
 */

/** GLSL's `mod` (`x - y * floor(x / y)`), which - unlike JS `%` - never returns a negative. */
const glslMod = (x: number, y: number): number => x - y * Math.floor(x / y);

/** Analytic gradient of a noise sample, filled in place so sampling stays allocation free. */
export interface NoiseGradient {
    x: number;
    y: number;
}

/**
 * Periodic simplex noise with rotating gradients and an analytic gradient - a direct port of
 * `psrdnoise2-min.glsl`.
 *
 * @param x            sample x
 * @param y            sample y
 * @param periodX      tiling period on x; `0` (the default) means "don't tile"
 * @param periodY      tiling period on y; `0` means "don't tile"
 * @param alpha        gradient rotation, in radians. Animating it makes the field swirl.
 * @param gradient     optional out-parameter; receives d(noise)/dx and d(noise)/dy
 * @returns the noise value, roughly in `[-1, 1]`
 */
export function psrdnoise2(
    x: number,
    y: number,
    periodX = 0,
    periodY = 0,
    alpha = 0,
    gradient?: NoiseGradient
): number {
    // skewed simplex lattice coordinates
    const uvx = x + y * 0.5;
    const uvy = y;
    const i0x = Math.floor(uvx);
    const i0y = Math.floor(uvy);
    const f0x = uvx - i0x;
    const f0y = uvy - i0y;
    // step(f0.y, f0.x) - which of the two triangles in the rhombus we are in
    const cmp = f0x >= f0y ? 1 : 0;
    const o1x = cmp;
    const o1y = 1 - cmp;
    const i1x = i0x + o1x;
    const i1y = i0y + o1y;
    const i2x = i0x + 1;
    const i2y = i0y + 1;

    // unskewed corner positions
    const v0x = i0x - i0y * 0.5;
    const v0y = i0y;
    const v1x = v0x + o1x - o1y * 0.5;
    const v1y = v0y + o1y;
    const v2x = v0x + 0.5;
    const v2y = v0y + 1;

    // vectors from the corners to the sample point
    const x0x = x - v0x;
    const x0y = y - v0y;
    const x1x = x - v1x;
    const x1y = y - v1y;
    const x2x = x - v2x;
    const x2y = y - v2y;

    let iu0: number;
    let iu1: number;
    let iu2: number;
    let iv0: number;
    let iv1: number;
    let iv2: number;
    if (periodX > 0 || periodY > 0) {
        // wrap the lattice so the field tiles on the requested period
        const xw0 = periodX > 0 ? glslMod(v0x, periodX) : v0x;
        const xw1 = periodX > 0 ? glslMod(v1x, periodX) : v1x;
        const xw2 = periodX > 0 ? glslMod(v2x, periodX) : v2x;
        const yw0 = periodY > 0 ? glslMod(v0y, periodY) : v0y;
        const yw1 = periodY > 0 ? glslMod(v1y, periodY) : v1y;
        const yw2 = periodY > 0 ? glslMod(v2y, periodY) : v2y;
        iu0 = Math.floor(xw0 + 0.5 * yw0 + 0.5);
        iu1 = Math.floor(xw1 + 0.5 * yw1 + 0.5);
        iu2 = Math.floor(xw2 + 0.5 * yw2 + 0.5);
        iv0 = Math.floor(yw0 + 0.5);
        iv1 = Math.floor(yw1 + 0.5);
        iv2 = Math.floor(yw2 + 0.5);
    } else {
        iu0 = i0x;
        iu1 = i1x;
        iu2 = i2x;
        iv0 = i0y;
        iv1 = i1y;
        iv2 = i2y;
    }

    // hash the three corners into gradient angles
    let h0 = glslMod(iu0, 289);
    let h1 = glslMod(iu1, 289);
    let h2 = glslMod(iu2, 289);
    h0 = glslMod((h0 * 51 + 2) * h0 + iv0, 289);
    h1 = glslMod((h1 * 51 + 2) * h1 + iv1, 289);
    h2 = glslMod((h2 * 51 + 2) * h2 + iv2, 289);
    h0 = glslMod((h0 * 34 + 10) * h0, 289);
    h1 = glslMod((h1 * 34 + 10) * h1, 289);
    h2 = glslMod((h2 * 34 + 10) * h2, 289);

    const psi0 = h0 * 0.07482 + alpha;
    const psi1 = h1 * 0.07482 + alpha;
    const psi2 = h2 * 0.07482 + alpha;
    const g0x = Math.cos(psi0);
    const g0y = Math.sin(psi0);
    const g1x = Math.cos(psi1);
    const g1y = Math.sin(psi1);
    const g2x = Math.cos(psi2);
    const g2y = Math.sin(psi2);

    // radially symmetric falloff, w^4 weighted
    const w0 = Math.max(0.8 - (x0x * x0x + x0y * x0y), 0);
    const w1 = Math.max(0.8 - (x1x * x1x + x1y * x1y), 0);
    const w2 = Math.max(0.8 - (x2x * x2x + x2y * x2y), 0);
    const w0sq = w0 * w0;
    const w1sq = w1 * w1;
    const w2sq = w2 * w2;
    const w0q = w0sq * w0sq;
    const w1q = w1sq * w1sq;
    const w2q = w2sq * w2sq;

    const gdotx0 = g0x * x0x + g0y * x0y;
    const gdotx1 = g1x * x1x + g1y * x1y;
    const gdotx2 = g2x * x2x + g2y * x2y;
    const n = w0q * gdotx0 + w1q * gdotx1 + w2q * gdotx2;

    if (gradient) {
        const dw0 = -8 * w0sq * w0 * gdotx0;
        const dw1 = -8 * w1sq * w1 * gdotx1;
        const dw2 = -8 * w2sq * w2 * gdotx2;
        gradient.x =
            10.9 * (w0q * g0x + dw0 * x0x + (w1q * g1x + dw1 * x1x) + (w2q * g2x + dw2 * x2x));
        gradient.y =
            10.9 * (w0q * g0y + dw0 * x0y + (w1q * g1y + dw1 * x1y) + (w2q * g2y + dw2 * x2y));
    }
    return 10.9 * n;
}

/* --------------------------------------------------------------------------
 * Classic 2D simplex noise (Gustavson/McEwan's `snoise`, the one every GLSL
 * snippet on the internet is a copy of). Cheaper than psrdnoise - no rotation,
 * no period, no derivative - and it is what `noise: 'simplex'` selects.
 * ------------------------------------------------------------------------ */

const mod289 = (x: number) => x - Math.floor(x * (1 / 289)) * 289;
const permute = (x: number) => mod289((x * 34 + 10) * x);

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** Classic 2D simplex noise, roughly in `[-1, 1]`. */
export function simplex2(x: number, y: number): number {
    // skew into simplex space
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    // which of the two triangles are we in
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = mod289(i);
    const jj = mod289(j);
    const p0 = permute(permute(jj) + ii);
    const p1 = permute(permute(jj + j1) + ii + i1);
    const p2 = permute(permute(jj + 1) + ii + 1);

    // gradients: 41 points uniformly over a unit circle
    const gradient = (p: number, ox: number, oy: number) => {
        const phi = (p % 41) * (((2 * Math.PI) / 41) as number);
        return ox * Math.cos(phi) + oy * Math.sin(phi);
    };

    const t0 = 0.5 - x0 * x0 - y0 * y0;
    const t1 = 0.5 - x1 * x1 - y1 * y1;
    const t2 = 0.5 - x2 * x2 - y2 * y2;
    let n = 0;
    if (t0 > 0) n += t0 * t0 * t0 * t0 * gradient(p0, x0, y0);
    if (t1 > 0) n += t1 * t1 * t1 * t1 * gradient(p1, x1, y1);
    if (t2 > 0) n += t2 * t2 * t2 * t2 * gradient(p2, x2, y2);
    // scale so the output lands in roughly [-1, 1]
    return 70 * n;
}

/** A 2D noise function: `(x, z) => value`, normally in `[-1, 1]`. */
export type NoiseFunction2D = (x: number, z: number) => number;

/** Built in noise kinds, or your own `(x, z) => value`. */
export type NoiseKind = 'psrd' | 'simplex' | NoiseFunction2D;

/** Resolve a {@link NoiseKind} to a plain sampling function. */
export const resolveNoise = (noise: NoiseKind = 'psrd'): NoiseFunction2D => {
    if (typeof noise === 'function') return noise;
    if (noise === 'simplex') return simplex2;
    return (x: number, z: number) => psrdnoise2(x, z);
};

/**
 * Deterministic seed offset. Neither noise here takes a seed (both hash their lattice
 * coordinates), so a seed is applied the usual way: as a large, well scattered offset of the
 * sample coordinates. Same seed, same field; a different seed, a completely different one.
 */
export const seedOffset = (seed: number): [number, number] => {
    // two rounds of a cheap integer hash, mapped into a large but float-safe range
    let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    const a = (Math.imul(h, 0xc2b2ae35) >>> 0) / 0xffffffff;
    let g = Math.imul(seed ^ 0x165667b1, 0x27d4eb2f) >>> 0;
    g ^= g >>> 15;
    const b = (Math.imul(g, 0x9e3779b1) >>> 0) / 0xffffffff;
    return [a * 1024 - 512, b * 1024 - 512];
};

/** Options shared by every fractal (fBm) sampler. */
export interface FbmOptions {
    /** How many layers of noise to sum. `1` is plain noise. */
    octaves?: number;
    /** Base frequency, in cycles per world unit. */
    frequency?: number;
    /** Height of the first octave; later octaves are scaled by `gain`. */
    amplitude?: number;
    /** Frequency multiplier per octave. */
    lacunarity?: number;
    /** Amplitude multiplier per octave. */
    gain?: number;
    /** Any number; the same seed always produces the same field. */
    seed?: number;
}

/**
 * Fractal brownian motion over any 2D noise: sum `octaves` layers, each `lacunarity` times
 * higher in frequency and `gain` times lower in amplitude.
 */
export function fbm2(
    noise: NoiseFunction2D,
    x: number,
    z: number,
    {
        octaves = 4,
        frequency = 1,
        amplitude = 1,
        lacunarity = 2,
        gain = 0.5,
        seed = 0
    }: FbmOptions = {}
): number {
    const [ox, oz] = seedOffset(seed);
    let value = 0;
    let f = frequency;
    let a = amplitude;
    for (let octave = 0; octave < octaves; octave++) {
        value += a * noise((x + ox) * f, (z + oz) * f);
        f *= lacunarity;
        a *= gain;
    }
    return value;
}
