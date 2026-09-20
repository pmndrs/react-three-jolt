import ReactThreeTestRenderer, { act } from '@react-three/test-renderer';
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Command } from '../src/useCommand/Command';
import { Commander, type CommandInfo } from '../src/useCommand/Commander';
import { useCommand } from '../src/useCommand/index';

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

    return {
        pending: () => callbacks.size,
        flush(frames = 1) {
            for (let i = 0; i < frames; i++) {
                const due = [...callbacks.values()];
                callbacks.clear();
                // r3f's own render loop lands in here too; a throw from it isn't our business
                for (const callback of due) {
                    try {
                        callback(i);
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
