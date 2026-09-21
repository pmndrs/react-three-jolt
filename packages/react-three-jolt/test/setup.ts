// React's `act()` (used internally by @react-three/test-renderer's create/update/waitFor)
// warns "the current testing environment is not configured to support act(...)" and, worse,
// defers effect flushing to a slower macrotask-based path instead of running synchronously
// inside `act`, unless this flag is set. Without it, tests that await multiple renders/effects
// (suspense resolving, subsequent state updates) can time out or observe stale state.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
