import * as THREE from 'three';

// Take in a three texture, make a new canvas, and scene, and draw the texture to the canvas
// then return the canvas
export function textureToCanvas(texture: THREE.Texture) {
    const canvas = document.createElement('canvas');
    canvas.width = texture.image.width;
    canvas.height = texture.image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No context');
    context.drawImage(texture.image, 0, 0);
    return canvas;
}

export async function imageUrlToImageData(url: string, scalingFactor?: number): Promise<ImageData> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const canvas = document.createElement('canvas');

            const context = canvas.getContext('2d');
            if (!context) {
                reject(new Error('No context'));
                return;
            }
            const width = scalingFactor ? image.width * scalingFactor : image.width;
            const height = scalingFactor ? image.height * scalingFactor : image.height;
            canvas.width = width;
            canvas.height = height;
            context.drawImage(image, 0, 0, width, height);
            const imageData = context.getImageData(0, 0, width, height);
            resolve(imageData);
        };
        image.onerror = () => {
            reject(new Error('Failed to load image'));
        };
        image.src = url;
    });
}

export function textureToImageData(texture: THREE.Texture): ImageData {
    const canvas = document.createElement('canvas');
    const width = texture.image.width;
    const height = texture.image.height;
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
    const vertices = geometry.attributes.position.array as Float32Array;
    const vertexCount = vertices.length / 3;
    // This is the size of the plane, which may not be the same as the image
    const size = Math.sqrt(vertexCount);
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
    displacementScale: number
) {
    let heightmapImgData: ImageData;
    if (typeof heightmap === 'string') {
        heightmapImgData = await imageUrlToImageData(heightmap);
    } else {
        heightmapImgData = textureToImageData(heightmap);
    }
    applyHeightmapImgDataToPlane(plane, heightmapImgData, displacementScale);
}
