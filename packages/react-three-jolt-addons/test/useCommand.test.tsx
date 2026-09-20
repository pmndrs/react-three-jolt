import ReactThreeTestRenderer, { act } from '@react-three/test-renderer';
import React, { StrictMode } from 'react';
import type * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Command } from '../src/useCommand/Command';
import { Commander, type CommandInfo } from '../src/useCommand/Commander';
import {
    type LookCommandOptions,
    useCommand,
    useLookCommand,
    VectorCommand,
    vectorPresets
} from '../src/useCommand/index';

// The window listeners the Commander owns. Nothing else in the tree touches these.
const COMMANDER_EVENTS = ['keydown', 'keyup', 'mousedown', 'mouseup'];

type ListenerEntry = { type: string; listener: unknown };

/**
 * Spy on window.addEventListener/removeEventListener and keep the set of listeners that are
 * currently attached, so a test can assert the count is back to where it started.
 */
function trackWindowListeners() {
    const attached: ListenerEntry[] = [];
    const nativeAdd = window.addEventListener.bind(window);
    const nativeRemove = window.removeEventListener.bind(window);

    vi.spyOn(window, 'addEventListener').mockImplementation(((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ) => {
        attached.push({ type, listener });
        return nativeAdd(type, listener, options);
    }) as typeof window.addEventListener);

    vi.spyOn(window, 'removeEventListener').mockImplementation(((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ) => {
        const index = attached.findIndex(
            (entry) => entry.type === type && entry.listener === listener
        );
        if (index >= 0) attached.splice(index, 1);
        return nativeRemove(type, listener, options);
    }) as typeof window.removeEventListener);

    return {
        /** every window listener currently attached for the given types */
        count: (types: string[] = COMMANDER_EVENTS) =>
            attached.filter((entry) => types.includes(entry.type)).length,
        all: () => attached.slice()
    };
}

/** Install a gamepad API so the Commander starts its poll loop, and count the polls. */
function fakeGamepads() {
    const getGamepads = vi.fn(() => [null, null, null, null] as unknown as Gamepad[]);
    Object.defineProperty(navigator, 'getGamepads', {
        value: getGamepads,
        configurable: true,
        writable: true
    });
    return getGamepads;
}

/** Deterministic requestAnimationFrame so the gamepad poll can be stepped by hand. */
function stubAnimationFrames() {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const originalRequest = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;

    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
        callbacks.delete(id);
    }) as typeof window.cancelAnimationFrame;

    let clock = 0;
    return {
        pending: () => callbacks.size,
        /** run every scheduled frame, advancing the timestamp callbacks receive by `step` ms */
        flush(frames = 1, step = 16) {
            for (let i = 0; i < frames; i++) {
                clock += step;
                const due = [...callbacks.values()];
                callbacks.clear();
                // r3f's own render loop lands in here too; a throw from it isn't our business
                for (const callback of due) {
                    try {
                        callback(clock);
                    } catch {
                        /* ignore */
                    }
                }
            }
        },
        restore() {
            window.requestAnimationFrame = originalRequest;
            window.cancelAnimationFrame = originalCancel;
        }
    };
}

function pressKey(key: string) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}
function releaseKey(key: string) {
    window.dispatchEvent(new KeyboardEvent('keyup', { key }));
}

function Consumer({
    commandString = 'q',
    onStart,
    onEnd
}: {
    commandString?: string;
    onStart?: (info: CommandInfo) => void;
    onEnd?: (info: CommandInfo) => void;
}) {
    useCommand(commandString, onStart, onEnd);
    return <group />;
}

describe('useCommand', () => {
    beforeEach(() => {
        fakeGamepads();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a mounted consumer receives keydown and keyup', async () => {
        const onStart = vi.fn();
        const onEnd = vi.fn();
        const renderer = await ReactThreeTestRenderer.create(
            <Consumer commandString="q" onStart={onStart} onEnd={onEnd} />
        );

        await act(async () => {
            pressKey('q');
        });
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(onStart.mock.calls[0][0].label).toBe('q');

        await act(async () => {
            releaseKey('q');
        });
        expect(onEnd).toHaveBeenCalledTimes(1);

        await renderer.unmount();
    });

    test('unmounting removes every window listener and stops delivering events', async () => {
        const listeners = trackWindowListeners();
        const baseline = listeners.count();
        expect(baseline).toBe(0);

        const onStart = vi.fn();
        const renderer = await ReactThreeTestRenderer.create(
            <Consumer commandString="q" onStart={onStart} />
        );
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        await act(async () => {
            pressKey('q');
        });
        expect(onStart).toHaveBeenCalledTimes(1);

        await renderer.unmount();

        // every listener the commander added is gone again
        expect(listeners.count()).toBe(baseline);
        // and so is gamepad.js' own window 'error' listener
        expect(listeners.count(['error'])).toBe(0);

        onStart.mockClear();
        await act(async () => {
            pressKey('q');
            releaseKey('q');
        });
        expect(onStart).not.toHaveBeenCalled();
    });

    test('strict mode double rendering leaves exactly one set of listeners', async () => {
        const listeners = trackWindowListeners();
        const onStart = vi.fn();
        let renders = 0;

        function StrictConsumer() {
            renders++;
            useCommand('q', onStart);
            return <group />;
        }

        const renderer = await ReactThreeTestRenderer.create(
            <StrictMode>
                <StrictConsumer />
            </StrictMode>
        );

        // guard the guard: if strict mode ever stopped double rendering here the rest of this
        // test would pass for the wrong reason
        expect(renders).toBeGreaterThan(1);
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        // a double registered command would call the handler twice for one keypress
        await act(async () => {
            pressKey('q');
        });
        expect(onStart).toHaveBeenCalledTimes(1);

        await renderer.unmount();
        expect(listeners.count()).toBe(0);
    });

    test('a remount (what strict mode does to effects) rebalances the listeners', async () => {
        // react-reconciler outside react-dom does not double invoke effects, so drive the
        // mount -> unmount -> mount cycle by hand: the retain count has to come back to one set
        // of listeners, never two and never zero.
        const listeners = trackWindowListeners();
        const onStart = vi.fn();

        const renderer = await ReactThreeTestRenderer.create(
            <>
                <Consumer commandString="q" onStart={onStart} />
                <Consumer commandString="e" />
            </>
        );
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        // unmount one and bring it straight back
        await renderer.update(
            <>
                <Consumer commandString="e" />
            </>
        );
        await renderer.update(
            <>
                <Consumer commandString="q" onStart={onStart} />
                <Consumer commandString="e" />
            </>
        );
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        await act(async () => {
            pressKey('q');
        });
        expect(onStart).toHaveBeenCalledTimes(1);

        await renderer.unmount();
        expect(listeners.count()).toBe(0);
    });

    test('several consumers share one set of listeners until the last one unmounts', async () => {
        const listeners = trackWindowListeners();
        const first = vi.fn();
        const second = vi.fn();

        const renderer = await ReactThreeTestRenderer.create(
            <>
                <Consumer commandString="q" onStart={first} />
                <Consumer commandString="e" onStart={second} />
            </>
        );
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        await act(async () => {
            pressKey('q');
        });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();

        // drop one consumer: the other still works and the listeners stay attached
        await renderer.update(
            <>
                <Consumer commandString="e" onStart={second} />
            </>
        );
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);
        await act(async () => {
            pressKey('e');
        });
        expect(second).toHaveBeenCalledTimes(1);

        await renderer.unmount();
        expect(listeners.count()).toBe(0);
    });

    test('changing the command string re-subscribes without leaking the old listener', async () => {
        const onStart = vi.fn();
        const renderer = await ReactThreeTestRenderer.create(
            <Consumer commandString="q" onStart={onStart} />
        );

        await renderer.update(<Consumer commandString="e" onStart={onStart} />);

        await act(async () => {
            pressKey('q');
            releaseKey('q');
        });
        expect(onStart).not.toHaveBeenCalled();

        await act(async () => {
            pressKey('e');
        });
        expect(onStart).toHaveBeenCalledTimes(1);

        await renderer.unmount();
    });

    test('an inline callback is not re-subscribed on every render', async () => {
        const spy = vi.fn();
        function Rerenderer({ tick }: { tick: number }) {
            // a brand new function identity on every render
            useCommand('q', (info) => spy(info.label, tick));
            return <group />;
        }

        const renderer = await ReactThreeTestRenderer.create(<Rerenderer tick={0} />);
        await renderer.update(<Rerenderer tick={1} />);
        await renderer.update(<Rerenderer tick={2} />);

        await act(async () => {
            pressKey('q');
        });
        // one listener, and it sees the latest props
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('q', 2);

        await renderer.unmount();
    });

    test('the gamepad poll stops after the last consumer unmounts', async () => {
        const frames = stubAnimationFrames();
        const getGamepads = fakeGamepads();
        try {
            const renderer = await ReactThreeTestRenderer.create(<Consumer commandString="q" />);

            frames.flush(3);
            const polledWhileMounted = getGamepads.mock.calls.length;
            expect(polledWhileMounted).toBeGreaterThan(0);

            await renderer.unmount();

            getGamepads.mockClear();
            frames.flush(5);
            expect(getGamepads).not.toHaveBeenCalled();
        } finally {
            frames.restore();
        }
    });

    test('no gamepad API in the environment is not fatal', async () => {
        // @ts-expect-error -- deliberately removing the API
        delete navigator.getGamepads;
        const onStart = vi.fn();
        const renderer = await ReactThreeTestRenderer.create(
            <Consumer commandString="q" onStart={onStart} />
        );
        await act(async () => {
            pressKey('q');
        });
        expect(onStart).toHaveBeenCalledTimes(1);
        await renderer.unmount();
    });
});

describe('CommandCallback info (#78)', () => {
    beforeEach(() => {
        fakeGamepads();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('isInitial is typed and is true only for the first keydown', async () => {
        const seen: boolean[] = [];
        const renderer = await ReactThreeTestRenderer.create(
            <Consumer
                commandString="q"
                onStart={(info) => {
                    // no @ts-expect-error needed: `info` is the payload, not the callback type
                    seen.push(info.isInitial);
                }}
            />
        );

        await act(async () => {
            pressKey('q');
        });
        expect(seen).toEqual([true]);

        // key repeat: the command is already running, so this one is not initial.
        // handleDown throttles on `threshold`, so wait it out first.
        await new Promise((resolve) => setTimeout(resolve, 120));
        await act(async () => {
            pressKey('q');
        });
        expect(seen).toEqual([true, false]);

        await renderer.unmount();
    });
});

describe('Command.setOptions', () => {
    test('assigns by key, not by value', () => {
        const command = new Command('look');
        command.setOptions({ sensitivity: 2, threshold: 50 });
        expect((command as unknown as Record<string, unknown>).sensitivity).toBe(2);
        expect(command.threshold).toBe(50);
        // the old implementation indexed by value and wrote `command[2] = 2`
        expect((command as unknown as Record<string, unknown>)['2']).toBeUndefined();
    });

    test('will not clobber a method', () => {
        const command = new Command('look');
        command.setOptions({ handleDown: 'nope' });
        expect(typeof command.handleDown).toBe('function');
    });
});

describe('Commander lifecycle', () => {
    beforeEach(() => {
        fakeGamepads();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('retain/release is reference counted and idempotent', () => {
        const listeners = trackWindowListeners();
        const commander = new Commander();
        expect(commander.isConnected).toBe(false);
        expect(listeners.count()).toBe(0);

        const releaseA = commander.retain();
        const releaseB = commander.retain();
        expect(commander.isConnected).toBe(true);
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        releaseA();
        releaseA(); // a double release must not unbalance the count
        expect(commander.isConnected).toBe(true);
        expect(listeners.count()).toBe(COMMANDER_EVENTS.length);

        releaseB();
        expect(commander.isConnected).toBe(false);
        expect(commander.consumerCount).toBe(0);
        expect(listeners.count()).toBe(0);
    });
});

describe('Commander state', () => {
    beforeEach(() => {
        fakeGamepads();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a command that goes inactive is cleared from the state', () => {
        const commander = new Commander();
        const release = commander.retain();
        try {
            const held = commander.addCommand('q');
            commander.addCommand('e');

            pressKey('q');
            expect(commander.getSnapshot().q).toBe(1);

            // deactivating a command used to leave its last value in the state forever
            held.active = false;
            pressKey('e');

            const snapshot = commander.getSnapshot();
            expect('q' in snapshot).toBe(false);
            expect(snapshot.e).toBe(1);
        } finally {
            release();
            commander.destroy();
        }
    });
});

describe('vectorPresets.look (#177 leftover)', () => {
    beforeEach(() => {
        fakeGamepads();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('the look preset binds up/down to the vertical axis', () => {
        // the preset names its vertical directions up/down, and only forward/backward used to
        // map to `y` -- so looking up moved the *horizontal* axis
        expect(vectorPresets.look.up.orientation).toBe(-1);

        const commander = new Commander();
        const release = commander.retain();
        try {
            const look = commander.addCommand('look', { asVector: true }) as VectorCommand;

            pressKey('ArrowUp');
            expect(look.value).toEqual({ x: 0, y: -1 });
            releaseKey('ArrowUp');

            pressKey('ArrowLeft');
            expect(look.value).toEqual({ x: -1, y: 0 });
            releaseKey('ArrowLeft');
        } finally {
            release();
            commander.destroy();
        }
    });
});

// Touch and gamepad support for useLookCommand (#87) -------------------------

type FakePad = { index: number; axes: number[]; buttons: { pressed: boolean; value: number }[] };

function installPads(pads: (FakePad | null)[]) {
    const getGamepads = vi.fn(() => pads as unknown as Gamepad[]);
    Object.defineProperty(navigator, 'getGamepads', {
        value: getGamepads,
        configurable: true,
        writable: true
    });
    return getGamepads;
}

function makePad(index = 0): FakePad {
    return {
        index,
        axes: [0, 0, 0, 0],
        buttons: new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }))
    };
}

/**
 * happy-dom's PointerEvent constructor ignores `pointerType`, so build the event by hand. The
 * hook only ever reads pointerId/pointerType/clientX/clientY.
 */
function pointerEvent(
    type: string,
    props: { pointerId: number; clientX?: number; clientY?: number; pointerType?: string }
) {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, {
        pointerType: 'touch',
        clientX: 0,
        clientY: 0,
        ...props
    });
    return event;
}

/** Spy on one element's listeners so a test can assert they are all gone again. */
function trackElementListeners(element: HTMLElement) {
    const attached: ListenerEntry[] = [];
    const nativeAdd = element.addEventListener.bind(element);
    const nativeRemove = element.removeEventListener.bind(element);

    vi.spyOn(element, 'addEventListener').mockImplementation(((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ) => {
        attached.push({ type, listener });
        return nativeAdd(type, listener, options);
    }) as typeof element.addEventListener);

    vi.spyOn(element, 'removeEventListener').mockImplementation(((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ) => {
        const index = attached.findIndex(
            (entry) => entry.type === type && entry.listener === listener
        );
        if (index >= 0) attached.splice(index, 1);
        return nativeRemove(type, listener, options);
    }) as typeof element.removeEventListener);

    return {
        count: () => attached.length,
        types: () => attached.map((entry) => entry.type)
    };
}

describe('useLookCommand (#87)', () => {
    let element: HTMLElement;
    let deltas: { x: number; y: number }[];
    let look: (vector: THREE.Vector2) => void;
    const zoom = vi.fn();

    beforeEach(() => {
        installPads([]);
        element = document.createElement('div');
        document.body.appendChild(element);
        deltas = [];
        // the hook reuses one Vector2, so snapshot each call
        look = (vector) => {
            deltas.push({ x: vector.x, y: vector.y });
        };
    });
    afterEach(() => {
        element.remove();
        zoom.mockClear();
        vi.restoreAllMocks();
    });

    function LookConsumer({ options }: { options?: LookCommandOptions }) {
        useLookCommand(look, zoom, options);
        return <group />;
    }

    const touchOnly: LookCommandOptions = { mouse: false, gamepad: false };

    test('a one finger drag reports the pointer delta', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer options={{ ...touchOnly, domElement: element }} />
        );

        await act(async () => {
            element.dispatchEvent(
                pointerEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 1, clientX: 15, clientY: 30 })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 1, clientX: 15, clientY: 35 })
            );
        });

        expect(deltas).toEqual([
            { x: 5, y: 20 },
            { x: 0, y: 5 }
        ]);

        // and the drag ends with the finger
        await act(async () => {
            element.dispatchEvent(
                pointerEvent('pointerup', { pointerId: 1, clientX: 15, clientY: 35 })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 90 })
            );
        });
        expect(deltas).toHaveLength(2);

        await renderer.unmount();
    });

    test('touch sensitivity and invertY scale the delta', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer
                options={{
                    ...touchOnly,
                    domElement: element,
                    invertY: true,
                    sensitivity: { touch: 2 }
                }}
            />
        );

        await act(async () => {
            element.dispatchEvent(
                pointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 1, clientX: 3, clientY: 4 })
            );
        });
        expect(deltas).toEqual([{ x: 6, y: -8 }]);

        await renderer.unmount();
    });

    test('a second finger (pinch) is not a look', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer options={{ ...touchOnly, domElement: element }} />
        );

        await act(async () => {
            element.dispatchEvent(
                pointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
            );
            element.dispatchEvent(
                pointerEvent('pointerdown', { pointerId: 2, clientX: 50, clientY: 50 })
            );
            // pinching apart moves both fingers
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 1, clientX: -20, clientY: 0 })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', { pointerId: 2, clientX: 70, clientY: 50 })
            );
        });
        expect(deltas).toEqual([]);

        await renderer.unmount();
    });

    test('a mouse pointer is ignored by the touch path', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer options={{ ...touchOnly, domElement: element }} />
        );

        await act(async () => {
            element.dispatchEvent(
                pointerEvent('pointerdown', {
                    pointerId: 1,
                    pointerType: 'mouse',
                    clientX: 0,
                    clientY: 0
                })
            );
            element.dispatchEvent(
                pointerEvent('pointermove', {
                    pointerId: 1,
                    pointerType: 'mouse',
                    clientX: 40,
                    clientY: 40
                })
            );
        });
        expect(deltas).toEqual([]);

        await renderer.unmount();
    });

    test('the right stick is sampled per frame and scaled by the frame delta', async () => {
        const pad = makePad();
        installPads([pad]);
        const frames = stubAnimationFrames();
        try {
            const renderer = await ReactThreeTestRenderer.create(
                <LookConsumer
                    options={{
                        domElement: element,
                        mouse: false,
                        touch: false,
                        gamepad: { stick: 'right' },
                        sensitivity: { gamepad: 100 }
                    }}
                />
            );

            // centered sticks say nothing
            frames.flush(2, 16);
            expect(deltas).toEqual([]);

            // right stick: axes 2 (x) and 3 (y). The left stick must not be read.
            pad.axes[0] = 1;
            pad.axes[1] = 1;
            pad.axes[2] = 0.5;
            pad.axes[3] = -0.25;
            await act(async () => {
                frames.flush(1, 16);
            });
            // 0.5 * 100 * 0.016s
            expect(deltas).toHaveLength(1);
            expect(deltas[0].x).toBeCloseTo(0.8, 5);
            expect(deltas[0].y).toBeCloseTo(-0.4, 5);

            // inside the deadzone the stick is treated as centered
            deltas.length = 0;
            pad.axes[2] = 0.1;
            pad.axes[3] = -0.1;
            await act(async () => {
                frames.flush(2, 16);
            });
            expect(deltas).toEqual([]);

            // and the loop stops with the hook
            pad.axes[2] = 0.9;
            await renderer.unmount();
            deltas.length = 0;
            frames.flush(3, 16);
            expect(deltas).toEqual([]);
        } finally {
            frames.restore();
        }
    });

    test('the left stick can be selected instead', async () => {
        const pad = makePad();
        installPads([pad]);
        const frames = stubAnimationFrames();
        try {
            const renderer = await ReactThreeTestRenderer.create(
                <LookConsumer
                    options={{
                        domElement: element,
                        mouse: false,
                        touch: false,
                        gamepad: { stick: 'left', deadzone: 0.05 },
                        sensitivity: { gamepad: 100 }
                    }}
                />
            );
            frames.flush(1, 16);
            pad.axes[0] = 0.5;
            await act(async () => {
                frames.flush(1, 16);
            });
            expect(deltas).toHaveLength(1);
            expect(deltas[0].x).toBeCloseTo(0.8, 5);

            await renderer.unmount();
        } finally {
            frames.restore();
        }
    });

    test('gamepad: false never starts a loop', async () => {
        const pad = makePad();
        pad.axes[2] = 1;
        const getGamepads = installPads([pad]);
        const frames = stubAnimationFrames();
        try {
            const renderer = await ReactThreeTestRenderer.create(
                <LookConsumer options={{ ...touchOnly, domElement: element }} />
            );
            getGamepads.mockClear();
            frames.flush(3, 16);
            expect(getGamepads).not.toHaveBeenCalled();
            expect(deltas).toEqual([]);
            await renderer.unmount();
        } finally {
            frames.restore();
        }
    });

    test('the mouse path still works and respects its sensitivity', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer
                options={{
                    domElement: element,
                    touch: false,
                    gamepad: false,
                    sensitivity: { mouse: 0.5 }
                }}
            />
        );

        const move = (movementX: number, movementY: number) => {
            const event = new Event('mousemove', { bubbles: true });
            Object.assign(event, { movementX, movementY });
            element.dispatchEvent(event);
        };

        // nothing while the button is up
        await act(async () => {
            move(10, 10);
        });
        expect(deltas).toEqual([]);

        await act(async () => {
            const down = new Event('mousedown', { bubbles: true });
            Object.assign(down, { offsetX: 0, offsetY: 0 });
            element.dispatchEvent(down);
            move(10, -20);
        });
        expect(deltas).toEqual([{ x: 5, y: -10 }]);

        await renderer.unmount();
    });

    test('the wheel drives the zoom handler', async () => {
        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer options={{ ...touchOnly, domElement: element }} />
        );
        await act(async () => {
            const wheel = new Event('wheel', { bubbles: true });
            Object.assign(wheel, { deltaY: 42 });
            element.dispatchEvent(wheel);
        });
        expect(zoom).toHaveBeenCalledWith(42);
        await renderer.unmount();
    });

    test('unmounting removes every pointer listener it added', async () => {
        const listeners = trackElementListeners(element);
        const previousTouchAction = element.style.touchAction;

        const renderer = await ReactThreeTestRenderer.create(
            <LookConsumer options={{ domElement: element }} />
        );
        expect(listeners.count()).toBeGreaterThan(0);
        expect(listeners.types()).toEqual(
            expect.arrayContaining([
                'mousedown',
                'mouseup',
                'mousemove',
                'wheel',
                'pointerdown',
                'pointermove',
                'pointerup',
                'pointercancel'
            ])
        );
        // the browser would pan the page instead of handing us the drag
        expect(element.style.touchAction).toBe('none');

        await renderer.unmount();
        expect(listeners.count()).toBe(0);
        expect(element.style.touchAction).toBe(previousTouchAction);

        // and a stray event afterwards reaches nobody
        element.dispatchEvent(
            pointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 })
        );
        element.dispatchEvent(
            pointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY: 50 })
        );
        expect(deltas).toEqual([]);
    });
});
