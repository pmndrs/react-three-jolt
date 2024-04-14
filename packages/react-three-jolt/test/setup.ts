// mock canvas.getContext return

const canvasContext = new Proxy(
    {},
    {
        get: () => () => {},
        set: () => true,
        apply: () => {}
    }
);

window.HTMLCanvasElement.prototype.getContext = () => canvasContext as any;
