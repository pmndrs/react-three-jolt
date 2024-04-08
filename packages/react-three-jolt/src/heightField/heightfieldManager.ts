//this is the main class that works on the main thread
import * as THREE from 'three';
// setup a single worker regardless of how many heightfields we have
const worker = new Worker(new URL('./heightfield-worker.ts', import.meta.url), {
    type: 'module',
});

export class HeightfieldManager {
    // canvas to transfer to the worker
    canvas = document.createElement('canvas');

    constructor() {
        /* console.log('manager created');
        // bind the event handler to the worker
        worker.onmessage = this.handleEvent;

        // send the canvas to the worker
        this.sendCanvas();

        // inital message
        this.sendMessage();
    */
    }
    // send the canvas to the worker as a transferable object (offscreenCanvas)
    sendCanvas() {
        const offscreen = this.canvas.transferControlToOffscreen();
        worker.postMessage({ type: 'newCanvas' }, [offscreen]);
    }

    // send message to the worker
    sendMessage() {
        worker.postMessage('Hello from the main thread');
    }
    testArrayTransfer() {
        const uint8Array = new Uint8Array(1024 * 1024 * 8).map((v, i) => i);
        console.log('Test byte length pre transfer', uint8Array.byteLength);

        // transfer the array
        worker.postMessage(uint8Array, [uint8Array.buffer]);
        console.log('main thread test byte length', uint8Array.byteLength);
    }

    // event handler for a message from the worker
    onMessage(event) {
        console.log('event from worker:', event);
    }

    handleEvent(event) {
        let texture;
        switch (event.data.type) {
            case 'newBitmap':
                texture = new THREE.CanvasTexture(event.bitmap);
                console.log('texture from worker:', texture);
                break;
        }
    }
}
