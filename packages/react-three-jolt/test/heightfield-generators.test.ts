// Unit coverage for the heightmap-sampling helpers behind <Heightfield> (see #152). These
// exercise `Generators.ts` directly, independent of React/jolt, covering:
//   - the sample-count guard that stands in for Jolt's real HeightFieldShapeSettings constraints
//     (square grid, edge length a multiple of the block size)
//   - the Float32Array guard on the geometry's position attribute
//   - `imageUrlToImageData`'s AbortSignal support, used by <Heightfield> to cancel a superseded
//     or post-unmount load instead of letting it resolve into a stale body
import * as THREE from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
    applyHeightmapImgDataToPlane,
    getValidatedHeightfieldSampleCount,
    imageUrlToImageData
} from '../src/heightField/Generators';

function fakeImageData(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
}

// A deterministic stand-in for the DOM `Image` so tests control exactly when (or whether)
// loading "completes", instead of depending on happy-dom's image-loading timing/support for a
// given `src` (data URIs there resolve near-synchronously; unrecognized schemes never settle).
class FakeImage {
    static instances: FakeImage[] = [];
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 4;
    height = 4;
    src = '';
    constructor() {
        FakeImage.instances.push(this);
    }
}

beforeEach(() => {
    FakeImage.instances.length = 0;
    vi.stubGlobal('Image', FakeImage);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

test('getValidatedHeightfieldSampleCount accepts a square, block-size-aligned grid', () => {
    // an 8x8 plane geometry -> 8 samples/edge, matches the default block size (2) with margin
    expect(getValidatedHeightfieldSampleCount(8 * 8)).toBe(8);
    // the project default (size=256 prop -> 256 vertices/edge)
    expect(getValidatedHeightfieldSampleCount(256 * 256)).toBe(256);
});

test('getValidatedHeightfieldSampleCount rejects a non-square vertex count', () => {
    expect(() => getValidatedHeightfieldSampleCount(10)).toThrow(/perfect square/);
});

test('getValidatedHeightfieldSampleCount rejects a size that is not a multiple of the block size', () => {
    // 9x9 -> size 9, not a multiple of blockSize 2
    expect(() => getValidatedHeightfieldSampleCount(9 * 9)).toThrow(/multiple of the block size/);
});

test('getValidatedHeightfieldSampleCount rejects a size below two blocks', () => {
    // 2x2 -> size 2, which is a multiple of blockSize 2 but only one block wide
    expect(() => getValidatedHeightfieldSampleCount(2 * 2, 2)).toThrow(/at least/);
});

test('applyHeightmapImgDataToPlane writes heights into a valid plane', () => {
    const geometry = new THREE.PlaneGeometry(8, 8, 7, 7); // 8x8 vertex grid
    const mesh = new THREE.Mesh(geometry);
    const heightmap = fakeImageData(8, 8);
    // give every texel a known, non-zero value so we can assert it actually landed
    heightmap.data.fill(255);

    applyHeightmapImgDataToPlane(mesh, heightmap, 10);
    const positions = geometry.attributes.position.array as Float32Array;
    // every vertex's height (the Y component, since the plane isn't rotated here) should now be
    // maxHeight (255/255 * 10)
    for (let i = 0; i < positions.length / 3; i++) {
        expect(positions[i * 3 + 1]).toBeCloseTo(10);
    }
});

test('applyHeightmapImgDataToPlane rejects a non-Float32Array position attribute', () => {
    const geometry = new THREE.PlaneGeometry(8, 8, 7, 7);
    const badArray = Float64Array.from(geometry.attributes.position.array);
    geometry.setAttribute('position', new THREE.BufferAttribute(badArray as any, 3));

    expect(() => applyHeightmapImgDataToPlane(geometry, fakeImageData(8, 8), 10)).toThrow(
        /Float32Array/
    );
});

test('imageUrlToImageData rejects immediately if the signal is already aborted, without touching Image', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
        imageUrlToImageData('fake://x', undefined, controller.signal)
    ).rejects.toBeDefined();
    expect(FakeImage.instances).toHaveLength(0);
});

test('imageUrlToImageData rejects (not resolves) when aborted mid-flight, even if the load finishes afterwards', async () => {
    const controller = new AbortController();
    const promise = imageUrlToImageData('fake://x', undefined, controller.signal);
    const [image] = FakeImage.instances;
    expect(image).toBeDefined();

    controller.abort();
    // the underlying "network" request finishes anyway, after cancellation -- must not resolve
    image.onload?.();

    await expect(promise).rejects.toBeDefined();
});

test('imageUrlToImageData rejects with a clear error when the image fails to load', async () => {
    const promise = imageUrlToImageData('fake://nope');
    const [image] = FakeImage.instances;
    image.onerror?.();

    await expect(promise).rejects.toThrow(/Failed to load heightmap image/);
});

test('imageUrlToImageData resolves with sampled pixel data on success', async () => {
    const fakeContext = {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => fakeImageData(4, 4))
    };
    const getContextSpy = vi
        .spyOn(window.HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(fakeContext as any);

    const promise = imageUrlToImageData('fake://ok');
    const [image] = FakeImage.instances;
    image.onload?.();

    const result = await promise;
    expect(result.width).toBe(4);
    expect(fakeContext.drawImage).toHaveBeenCalledTimes(1);

    getContextSpy.mockRestore();
});
