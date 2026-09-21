// Coverage for first class heightfield generation (issue #45): the CPU noise port, the
// sample-count rule from #152, the geometry that has to agree with the samples, and - against
// the real jolt-physics module - a body actually rolling down a generated slope.
import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import {
    fbm2,
    generateHeightfield,
    heightfieldMaterialIndices,
    heightfieldToGeometry,
    psrdnoise2,
    samplesFromGenerator,
    simplex2,
    validateHeightfieldSize
} from '../src/heightField';
import { initJolt } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import { describeShape, type HeightfieldShapeDescriptor } from '../src/systems/shape-system';

describe('noise', () => {
    test('psrdnoise2 is deterministic, bounded and continuous', () => {
        assert.equal(psrdnoise2(1.5, 2.25), psrdnoise2(1.5, 2.25));
        for (let i = 0; i < 200; i++) {
            const value = psrdnoise2(i * 0.37, i * -0.21);
            assert.isTrue(value >= -1.2 && value <= 1.2, `psrdnoise2 out of range: ${value}`);
        }
        // neighbouring samples are close: noise, not white noise
        const a = psrdnoise2(3, 4);
        const b = psrdnoise2(3.001, 4);
        assert.isBelow(Math.abs(a - b), 0.05);
    });

    test('psrdnoise2 tiles on the period it is given', () => {
        const period = 4;
        for (const [x, z] of [
            [0.3, 1.7],
            [2.25, 3.5],
            [1, 1]
        ]) {
            assert.closeTo(
                psrdnoise2(x, z, period, period),
                psrdnoise2(x + period, z + period, period, period),
                1e-6
            );
        }
    });

    test('psrdnoise2 fills the gradient out-parameter with the analytic derivative', () => {
        const gradient = { x: 0, y: 0 };
        const h = 1e-4;
        psrdnoise2(0.6, -1.3, 0, 0, 0, gradient);
        const numeric = (psrdnoise2(0.6 + h, -1.3) - psrdnoise2(0.6 - h, -1.3)) / (2 * h);
        assert.closeTo(gradient.x, numeric, 1e-2);
    });

    test('simplex2 is deterministic and bounded', () => {
        assert.equal(simplex2(0.5, 0.5), simplex2(0.5, 0.5));
        for (let i = 0; i < 200; i++) {
            const value = simplex2(i * 0.31, i * 0.17);
            assert.isTrue(value >= -1.5 && value <= 1.5, `simplex2 out of range: ${value}`);
        }
    });

    test('fbm2 adds detail without moving the field for the same seed', () => {
        const one = fbm2(psrdnoise2, 1, 2, { octaves: 1, seed: 3 });
        const four = fbm2(psrdnoise2, 1, 2, { octaves: 4, seed: 3 });
        assert.equal(fbm2(psrdnoise2, 1, 2, { octaves: 4, seed: 3 }), four);
        assert.notEqual(one, four);
    });
});

describe('generateHeightfield', () => {
    test('is deterministic for a seed and different for another', () => {
        const options = { size: 32, octaves: 3, seed: 1234 } as const;
        const a = generateHeightfield(options);
        const b = generateHeightfield(options);
        assert.deepEqual(Array.from(a.samples), Array.from(b.samples));

        const other = generateHeightfield({ ...options, seed: 1235 });
        assert.notDeepEqual(Array.from(other.samples), Array.from(a.samples));
        // ...and it is actually terrain, not a constant
        assert.isAbove(a.max - a.min, 0.1);
    });

    test('produces size*size samples and reports their range', () => {
        const { samples, size, min, max } = generateHeightfield({ size: 16, seed: 7 });
        assert.equal(size, 16);
        assert.equal(samples.length, 16 * 16);
        assert.equal(min, Math.min(...samples));
        assert.equal(max, Math.max(...samples));
    });

    test('a custom noise function and simplex are both accepted', () => {
        const flat = generateHeightfield({ size: 8, noise: () => 1, octaves: 1, amplitude: 2 });
        for (const height of flat.samples) assert.equal(height, 2);

        const simplex = generateHeightfield({ size: 8, noise: 'simplex', seed: 2 });
        assert.equal(simplex.samples.length, 64);
    });

    test('enforces the sample-count rule from #152', () => {
        // 8 samples/edge: square, a multiple of blockSize 2, two blocks wide
        assert.equal(validateHeightfieldSize(8), 8);
        expect(() => generateHeightfield({ size: 9 })).toThrow(/multiple of the block size/);
        expect(() => generateHeightfield({ size: 2 })).toThrow(/at least/);
        // block size 4 moves the goalposts with it
        assert.equal(validateHeightfieldSize(8, 4), 8);
        expect(() => generateHeightfield({ size: 6, blockSize: 4 })).toThrow(
            /multiple of the block size/
        );
    });

    test('the generator callback sees field local world coordinates', () => {
        const size = 8;
        const spacing = 2;
        const seen: [number, number][] = [];
        samplesFromGenerator(
            size,
            (x, z) => {
                seen.push([x, z]);
                return 0;
            },
            spacing
        );
        assert.equal(seen.length, size * size);
        // first sample is the -x/-z corner, last is +x/+z, and the field is centred
        assert.deepEqual(seen[0], [-7, -7]);
        assert.deepEqual(seen[seen.length - 1], [7, 7]);
    });
});

describe('heightfieldToGeometry', () => {
    test("the geometry's heights are the samples, in the same order", () => {
        const { samples } = generateHeightfield({ size: 16, seed: 42 });
        const geometry = heightfieldToGeometry(samples, 16, [1, 1, 1]);
        const positions = geometry.attributes.position.array as Float32Array;
        assert.equal(positions.length / 3, samples.length);
        for (let i = 0; i < samples.length; i++)
            assert.closeTo(positions[i * 3 + 1], samples[i], 1e-5);
        geometry.dispose();
    });

    test('scale sets the spacing on x/z and multiplies the heights', () => {
        const samples = new Float32Array(8 * 8).fill(3);
        const geometry = heightfieldToGeometry(samples, 8, [2, 10, 4]);
        // 8 samples span 7 segments
        assert.equal(geometry.parameters.width, 14);
        assert.equal(geometry.parameters.height, 28);
        const positions = geometry.attributes.position.array as Float32Array;
        assert.closeTo(positions[1], 30, 1e-4);
        geometry.dispose();
    });

    test('what the shape pipeline reads back out is what went in', () => {
        const size = 16;
        const scale: [number, number, number] = [2, 5, 2];
        const { samples } = generateHeightfield({ size, seed: 9 });
        const mesh = new THREE.Mesh(heightfieldToGeometry(samples, size, scale));

        const descriptor = describeShape(mesh, {
            type: 'heightfield'
        }) as HeightfieldShapeDescriptor;
        assert.equal(descriptor.sampleCount, size);
        // the distance between samples, not width/sampleCount - the physics field covers
        // exactly the ground the drawn mesh does
        assert.closeTo(descriptor.scale[0], scale[0], 1e-6);
        assert.closeTo(descriptor.scale[2], scale[2], 1e-6);
        for (let i = 0; i < samples.length; i++)
            assert.closeTo(descriptor.heights[i] as number, samples[i] * scale[1], 1e-4);
        mesh.geometry.dispose();
    });

    test('too few samples is an error, not a field of NaN', () => {
        expect(() => heightfieldToGeometry(new Float32Array(10), 8)).toThrow(/expected 64 samples/);
    });
});

describe('heightfieldMaterialIndices', () => {
    test('is one entry per quad, sampled at the quad centres', () => {
        const size = 8;
        const indices = heightfieldMaterialIndices(size, (x) => (x < 0 ? 0 : 1));
        assert.equal(indices.length, (size - 1) * (size - 1));
        // 7 quads per row, centres at -3, -2, -1, 0, 1, 2, 3 -> three on the -x side
        assert.deepEqual(Array.from(indices.slice(0, 7)), [0, 0, 0, 1, 1, 1, 1]);
    });

    test('an existing array is validated against the quad count', () => {
        expect(() => heightfieldMaterialIndices(8, new Uint8Array(10))).toThrow(
            /one entry per quad/
        );
        const exact = new Uint8Array(49).fill(1);
        assert.strictEqual(heightfieldMaterialIndices(8, exact), exact);
    });
});

describe('a generated field in the real simulation', () => {
    beforeAll(async () => {
        await initJolt();
    });

    test('a sphere dropped on a generated slope rolls downhill', () => {
        const ps = new PhysicsSystem('heightfield-slope');
        const size = 32;
        // a clean ramp: height falls off along +z, so downhill is +z
        const { samples } = samplesFromGenerator(size, (_x, z) => -z * 0.5);
        const mesh = new THREE.Mesh(heightfieldToGeometry(samples, size, [1, 1, 1]));
        const handle = ps.bodySystem.addHeightfield(mesh);
        assert.isNumber(handle);

        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16));
        // above the middle of the ramp, whose surface height there is 0
        sphere.position.set(0, 2, 0);
        const ball = ps.bodySystem.getBody(ps.bodySystem.addBody(sphere))!;

        for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);

        const { x, y, z } = ball.position;
        // it landed on the field rather than falling through it: the surface at this z is
        // -z * 0.5, and the ball's centre sits a radius above it
        assert.isAbove(y, -z * 0.5 - 1, `ball fell through the heightfield (y ${y}, z ${z})`);
        assert.isAbove(z, 2, `ball did not roll downhill (z ${z})`);
        // downhill is +z only; it should not have wandered sideways
        assert.isBelow(Math.abs(x), 1, `ball drifted sideways (x ${x})`);

        ps.destroy();
    });

    test('a field generated from noise is solid ground', () => {
        const ps = new PhysicsSystem('heightfield-noise');
        const size = 32;
        const { samples, max } = generateHeightfield({ size, seed: 5, amplitude: 2 });
        const mesh = new THREE.Mesh(heightfieldToGeometry(samples, size, [1, 1, 1]));
        ps.bodySystem.addHeightfield(mesh);

        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        box.position.set(0, max + 10, 0);
        const boxState = ps.bodySystem.getBody(ps.bodySystem.addBody(box))!;

        for (let i = 0; i < 180; i++) ps.onUpdate(1 / 60);
        assert.isAbove(boxState.position.y, -5, 'box fell through the generated terrain');
        assert.isBelow(boxState.position.y, max + 10, 'box never fell');

        ps.destroy();
    });
});
