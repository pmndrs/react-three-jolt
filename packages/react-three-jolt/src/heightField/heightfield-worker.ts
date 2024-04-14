// this worker has scripts to
/*
1. Generate a array and texture of our heightmap using FBM/PSRD noise
2. Generate a mesh from a heightmap OR image
3. Generate AT LEAST the array of a mesh of the heightmap, if not the mesh
at least the buffer that the geometry can be made from on the main thread
4. try to generate the jolt heightmap or buffer. less likely to be done

Why a worker?
Generating the heightmap will be heavy and while not really a factor when
generating once, it cant be updated or changed.
Doing it in worker frees the main thread
*/
import * as THREE from 'three';

let canvas: OffscreenCanvas;
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let plane: THREE.Mesh;
let camera: THREE.OrthographicCamera;
// TODO: move scene initialization HERE

// read a message from the main thread
self.onmessage = function (event) {
    handleMessage(event.data);
};

// event handler by type
function handleMessage(message) {
    console.log('WORKER: event received on the worker:', message);

    switch (message.type) {
        case 'newCanvas':
            initializeRenderer(message.canvas, message.height, message.width);
            initializeScene(message.width, message.height, message.resolution);
            testRender();
            break;
    }
}

// setup the canvas and renderer
function initializeRenderer(newCanvas: OffscreenCanvas, height = 1024, width = 1024) {
    if (!newCanvas) console.log('WORKER: no canvas sent, creating a new one');
    canvas = newCanvas || new OffscreenCanvas(width, height);
    renderer = new THREE.WebGLRenderer({ canvas });
    renderer.setSize(width, height, false);
    console.log('renderer initialized', renderer);
}

function initializeScene(width = 1024, height = 1024, resolution = 1) {
    //TODO: Detect if a scene exists and clear it
    if (scene) {
        //scene.dispose();
    }

    scene = new THREE.Scene();
    // add orthographic camera
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    scene.add(camera);

    // add a plane with the same resolution as the renderer
    const geometry = new THREE.PlaneGeometry(
        width,
        height,
        width / resolution,
        height / resolution
    );
    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    plane = new THREE.Mesh(geometry, material);
    scene.add(plane);
}
function testRender() {
    renderer.render(scene, camera);
    const newBitmap = canvas.transferToImageBitmap();
    console.log('WORKER: rendered', newBitmap);
    self.postMessage({ type: 'newBitmap', bitmap: newBitmap }, [newBitmap]);
}

export {};
