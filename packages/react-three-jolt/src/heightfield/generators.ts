import * as THREE from 'three';

// three types Texture.image as its (unknown by default) TImage generic since r175, so the
// drawable image of a plain THREE.Texture has to be narrowed at the use site.
type DrawableImage = CanvasImageSource & { width: number; height: number };
const drawableImage = (texture: THREE.Texture): DrawableImage => texture.image as DrawableImage;

// Must match `BLOCK_SIZE` in `systems/shape-system.ts` (generateHeightfieldShapeFromThree) --
// that's where the Jolt HeightFieldShapeSettings is actually built from the plane this module
// prepares, and both need to agree on what a valid sample grid looks like.
const HEIGHTFIELD_BLOCK_SIZE = 2;

// Jolt's HeightFieldShapeSettings (see jrouwe/JoltPhysics HeightFieldShape.h) requires a square
// grid of samples (mSampleCount x mSampleCount) whose edge length is a multiple of the block
// size (mBlockSize, default 2) and at least two blocks wide. A power-of-two ratio is only a
// *performance* recommendation upstream ("...is the most efficient in terms of performance and
// storage"), not a hard requirement, so we don't reject non-power-of-two sizes that otherwise
// satisfy the real constraint.
export function getValidatedHeightfieldSampleCount(
    vertexCount: number,
    blockSize: number = HEIGHTFIELD_BLOCK_SIZE
): number {
    const size = Math.sqrt(vertexCount);
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error(
            `Heightfield: expected a square grid of samples (equal width/height segments), ` +
                `but got ${vertexCount} vertices which is not a perfect square.`
        );
    }
    if (size % blockSize !== 0 || size / blockSize < 2) {
        throw new Error(
            `Heightfield: sample count per edge (${size}) must be a multiple of the block size ` +
                `(${blockSize}) and at least ${blockSize * 2}. Adjust the "size" prop so ` +
                `(size - 1) segments produce a valid sample count.`
        );
    }
    return size;
}

// Take in a three texture, make a new canvas, and scene, and draw the texture to the canvas
// then return the canvas
export function textureToCanvas(texture: THREE.Texture) {
    const image = drawableImage(texture);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No context');
    context.drawImage(image, 0, 0);
    return canvas;
}

export async function imageUrlToImageData(
    url: string,
    scalingFactor?: number,
    signal?: AbortSignal
): Promise<ImageData> {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    return new Promise((resolve, reject) => {
        const image = new Image();
        // the canvas only exists to sample pixels out of the loaded image; drop the reference
        // as soon as we're done with it (success, failure, or cancellation) instead of letting
        // it, and the ImageData it produced, dangle off the closure for the life of the promise.
        let canvas: HTMLCanvasElement | null = document.createElement('canvas');

        const cleanup = () => {
            image.onload = null;
            image.onerror = null;
            signal?.removeEventListener('abort', onAbort);
            canvas = null;
        };
        const onAbort = () => {
            cleanup();
            // stop the in-flight network request
            image.src = '';
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort);

        image.onload = () => {
            if (!canvas) return;
            const context = canvas.getContext('2d');
            if (!context) {
                cleanup();
                reject(new Error('No context'));
                return;
            }
            const width = scalingFactor ? image.width * scalingFactor : image.width;
            const height = scalingFactor ? image.height * scalingFactor : image.height;
            canvas.width = width;
            canvas.height = height;
            context.drawImage(image, 0, 0, width, height);
            const imageData = context.getImageData(0, 0, width, height);
            cleanup();
            resolve(imageData);
        };
        image.onerror = () => {
            cleanup();
            reject(new Error(`Failed to load heightmap image: ${url}`));
        };
        image.src = url;
    });
}

export function textureToImageData(texture: THREE.Texture): ImageData {
    const canvas = document.createElement('canvas');
    const { width, height } = drawableImage(texture);
    canvas.width = width;
    canvas.height = height;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(
        width / -2,
        width / 2,
        height / 2,
        height / -2,
        1,
        1000
    );
    const planeGeometry = new THREE.PlaneGeometry(width, height);
    const planeMaterial = new THREE.MeshBasicMaterial({ map: texture });
    const plane = new THREE.Mesh(planeGeometry, planeMaterial);
    scene.add(plane);

    const renderer = new THREE.WebGLRenderer({ canvas });
    renderer.setSize(width, height);
    renderer.render(scene, camera);

    const context = canvas.getContext('2d');
    if (!context) throw new Error('No context');
    const imageData = context.getImageData(0, 0, width, height);
    return imageData;
}

// apply heightmap ImgData to a plane
export function applyHeightmapImgDataToPlane(
    plane: THREE.Mesh | THREE.PlaneGeometry,
    heightmap: ImageData,
    maxHeight: number
) {
    // This is the size data of the image, not the plane
    // const { width, height } = heightmap;
    const { width } = heightmap;
    const geometry = plane instanceof THREE.Mesh ? plane.geometry : plane;
    const vertices = geometry.attributes.position.array;
    if (!(vertices instanceof Float32Array)) {
        throw new Error(
            "Heightfield: expected the plane geometry's position attribute to be a Float32Array."
        );
    }
    const vertexCount = vertices.length / 3;
    // This is the size of the plane, which may not be the same as the image; throws a clear
    // error if the grid isn't a shape Jolt's HeightFieldShapeSettings can actually accept.
    const size = getValidatedHeightfieldSampleCount(vertexCount);
    // step is the percentage of image width and plane width
    const factor = Math.floor(width / size);

    // loop over vertices and apply heightmap
    for (let i = 0; i < vertexCount; i++) {
        const x = i % size;
        const y = Math.floor(i / size);
        const imageX = Math.floor(x * factor);
        const imageY = Math.floor(y * factor);
        const index = (imageY * width + imageX) * 4;
        const r = heightmap.data[index];
        const g = heightmap.data[index + 1];
        const b = heightmap.data[index + 2];
        const mapHeight = (r + g + b) / 3;
        // scared to change this because it works with a standard plane
        //but if I rote the geo first this is wrong
        //vertices[i * 3 + 2] = (mapHeight / 255) * displacementScale;
        // if the geo is rotated on x then the y is the height
        vertices[i * 3 + 1] = (mapHeight / 255) * maxHeight;
    }

    geometry.attributes.position.needsUpdate = true;
}

// take either a URL or a texture and apply the heightmap to a plane
export async function applyHeightmapToPlane(
    plane: THREE.Mesh,
    heightmap: string | THREE.Texture,
    displacementScale: number,
    signal?: AbortSignal
) {
    let heightmapImgData: ImageData;
    if (typeof heightmap === 'string') {
        heightmapImgData = await imageUrlToImageData(heightmap, undefined, signal);
    } else {
        heightmapImgData = textureToImageData(heightmap);
    }
    // the load above is the only await point; re-check after it in case we were cancelled
    // while it was in flight, so a superseded/unmounted call never touches the plane.
    if (signal?.aborted) return;
    applyHeightmapImgDataToPlane(plane, heightmapImgData, displacementScale);
}
