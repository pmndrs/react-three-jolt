import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GamepadInputEvent } from '../src/useCommand/Command';
import { Commander, type CommandInfo } from '../src/useCommand/Commander';
import { GamepadPoller, gamepadButtonName } from '../src/useCommand/gamepad';

/** A mutable stand in for a `Gamepad`: a test pokes at it between polls. */
type FakePad = {
    index: number;
    axes: number[];
    buttons: { pressed: boolean; value: number }[];
};

function makePad(index = 0, axisCount = 4, buttonCount = 17): FakePad {
    return {
        index,
        axes: new Array(axisCount).fill(0),
        buttons: new Array(buttonCount).fill(null).map(() => ({ pressed: false, value: 0 }))
    };
}

function press(pad: FakePad, button: number, value = 1) {
    pad.buttons[button] = { pressed: value > 0, value };
}

/** Install `navigator.getGamepads` over a mutable list of pads. */
function installGamepads(pads: (FakePad | null)[]) {
    const getGamepads = vi.fn(() => pads as unknown as Gamepad[]);
    Object.defineProperty(navigator, 'getGamepads', {
        value: getGamepads,
        configurable: true,
        writable: true
    });
    return getGamepads;
}

function removeGamepadApi() {
    Object.defineProperty(navigator, 'getGamepads', {
        value: undefined,
        configurable: true,
        writable: true
    });
}

/** Deterministic requestAnimationFrame so the poll loop can be stepped by hand. */
function stubAnimationFrames() {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    let clock = 0;
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
        flush(frames = 1, step = 16) {
            for (let i = 0; i < frames; i++) {
                clock += step;
                const due = [...callbacks.values()];
                callbacks.clear();
                for (const callback of due) callback(clock);
            }
        },
        restore() {
            window.requestAnimationFrame = originalRequest;
            window.cancelAnimationFrame = originalCancel;
        }
    };
}

function disconnectEvent(index: number) {
    const event = new Event('gamepaddisconnected') as Event & { gamepad?: { index: number } };
    event.gamepad = { index };
    return event;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('GamepadPoller (#12)', () => {
    test('a button press emits a down event, releasing it emits an up event', () => {
        const pad = makePad();
        installGamepads([pad]);
        const onButton = vi.fn();
        const poller = new GamepadPoller({ onButton });
        try {
            // the first poll only takes a baseline, it must not report the pad's resting state
            poller.poll();
            expect(onButton).not.toHaveBeenCalled();

            press(pad, 0);
            poller.poll();
            expect(onButton).toHaveBeenCalledTimes(1);
            const down = onButton.mock.calls[0][0] as GamepadInputEvent;
            expect(down.type).toBe('gamepad:button');
            expect(down.detail).toMatchObject({
                index: 0,
                button: 0,
                name: 'A',
                value: 1,
                pressed: true
            });

            // an unchanged pad is silent
            poller.poll();
            expect(onButton).toHaveBeenCalledTimes(1);

            press(pad, 0, 0);
            poller.poll();
            expect(onButton).toHaveBeenCalledTimes(2);
            expect((onButton.mock.calls[1][0] as GamepadInputEvent).detail).toMatchObject({
                button: 0,
                value: 0,
                pressed: false
            });
        } finally {
            poller.stop();
        }
    });

    test('the deadzone suppresses tiny axis values', () => {
        const pad = makePad();
        installGamepads([pad]);
        const onAxis = vi.fn();
        const poller = new GamepadPoller({ onAxis }, { deadzone: 0.15 });
        poller.poll();

        // a stick resting slightly off center is noise, not input
        pad.axes[2] = 0.1;
        pad.axes[3] = -0.14;
        poller.poll();
        expect(onAxis).not.toHaveBeenCalled();

        // past the deadzone it reports the real (un-rescaled) value
        pad.axes[2] = 0.4;
        poller.poll();
        expect(onAxis).toHaveBeenCalledTimes(1);
        expect((onAxis.mock.calls[0][0] as GamepadInputEvent).detail).toMatchObject({
            index: 0,
            axis: 2,
            value: 0.4
        });

        // and it snaps back to exactly 0 when the stick re-centers inside the deadzone
        pad.axes[2] = 0.05;
        poller.poll();
        expect((onAxis.mock.calls[1][0] as GamepadInputEvent).detail.value).toBe(0);
    });

    test('a per axis change threshold filters out jitter', () => {
        const pad = makePad();
        installGamepads([pad]);
        const onAxis = vi.fn();
        const poller = new GamepadPoller({ onAxis }, { deadzone: 0.15, axisThreshold: 0.1 });
        poller.poll();

        pad.axes[0] = 0.5;
        poller.poll();
        expect(onAxis).toHaveBeenCalledTimes(1);

        // below the threshold: not worth an event
        pad.axes[0] = 0.55;
        poller.poll();
        expect(onAxis).toHaveBeenCalledTimes(1);

        pad.axes[0] = 0.8;
        poller.poll();
        expect(onAxis).toHaveBeenCalledTimes(2);
    });

    test('several gamepads are reported separately, by index', () => {
        const first = makePad(0);
        const second = makePad(1);
        installGamepads([first, null, second]);
        const onButton = vi.fn();
        const poller = new GamepadPoller({ onButton });
        poller.poll();

        press(second, 12);
        poller.poll();
        expect(onButton).toHaveBeenCalledTimes(1);
        expect((onButton.mock.calls[0][0] as GamepadInputEvent).detail).toMatchObject({
            index: 1,
            button: 12,
            name: 'DPadUp'
        });
    });

    test('start() is a no-op without a Gamepad API, and never throws', () => {
        removeGamepadApi();
        const poller = new GamepadPoller({ onButton: vi.fn(), onAxis: vi.fn() });
        expect(() => poller.start()).not.toThrow();
        expect(poller.isRunning).toBe(false);
        expect(() => poller.poll()).not.toThrow();
        expect(() => poller.stop()).not.toThrow();
    });

    test('the standard mapping names match the button indices the presets use', () => {
        // commonCommands binds jump to 0, crouch to 1, fire to 7 and moveForward to 12
        expect(gamepadButtonName(0)).toBe('A');
        expect(gamepadButtonName(1)).toBe('B');
        expect(gamepadButtonName(7)).toBe('RightTrigger');
        expect(gamepadButtonName(12)).toBe('DPadUp');
        expect(gamepadButtonName(99)).toBeUndefined();
    });
});

describe('Commander gamepad integration (#12)', () => {
    test('a gamepad button press fires the command bound to it', () => {
        const pad = makePad();
        installGamepads([pad]);
        const frames = stubAnimationFrames();
        const commander = new Commander();
        const started: CommandInfo[] = [];
        const ended: CommandInfo[] = [];
        try {
            // `jump` is a common command: keys [' '], buttons [0]
            commander.addCommand('jump');
            commander.addListener('jump', (info) => started.push(info));
            commander.addListener('jump', (info) => ended.push(info), true);
            const release = commander.retain();

            frames.flush(1);
            expect(started).toHaveLength(0);

            press(pad, 0);
            frames.flush(1);
            expect(started).toHaveLength(1);
            expect(started[0].label).toBe('jump');
            expect(started[0].method).toBe('gamepad:button');
            expect(commander.getSnapshot().jump).toBe(1);

            press(pad, 0, 0);
            frames.flush(1);
            expect(ended).toHaveLength(1);
            expect(ended[0].label).toBe('jump');

            release();
        } finally {
            frames.restore();
            commander.destroy();
        }
    });

    test('the poll loop starts on the first retain and stops after the last release', () => {
        const pad = makePad();
        const getGamepads = installGamepads([pad]);
        const frames = stubAnimationFrames();
        const commander = new Commander();
        try {
            // constructing one attaches nothing
            expect(frames.pending()).toBe(0);
            expect(commander.isPollingGamepads).toBe(false);

            const first = commander.retain();
            const second = commander.retain();
            expect(commander.isPollingGamepads).toBe(true);
            expect(frames.pending()).toBe(1);

            frames.flush(3);
            expect(getGamepads.mock.calls.length).toBe(3);
            // exactly one frame is ever in flight, the loop doesn't fan out
            expect(frames.pending()).toBe(1);

            first();
            expect(commander.isPollingGamepads).toBe(true);
            frames.flush(1);
            expect(getGamepads.mock.calls.length).toBe(4);

            second();
            expect(commander.isPollingGamepads).toBe(false);
            expect(frames.pending()).toBe(0);

            getGamepads.mockClear();
            frames.flush(5);
            expect(getGamepads).not.toHaveBeenCalled();
        } finally {
            frames.restore();
            commander.destroy();
        }
    });

    test('gamepaddisconnected releases what was held and stops further events', () => {
        const pad = makePad();
        installGamepads([pad]);
        const frames = stubAnimationFrames();
        const commander = new Commander();
        const started: CommandInfo[] = [];
        const ended: CommandInfo[] = [];
        try {
            commander.addCommand('jump');
            commander.addListener('jump', (info) => started.push(info));
            commander.addListener('jump', (info) => ended.push(info), true);
            commander.retain();

            // one frame to take the baseline, then press
            frames.flush(1);
            press(pad, 0);
            frames.flush(1);
            expect(started).toHaveLength(1);
            expect(ended).toHaveLength(0);

            // yanking the controller must not leave the command stuck down
            window.dispatchEvent(disconnectEvent(0));
            expect(ended).toHaveLength(1);

            // the button is still "pressed" on the stale pad object; no more events either way
            started.length = 0;
            ended.length = 0;
            frames.flush(3);
            expect(started).toHaveLength(0);
            expect(ended).toHaveLength(0);
        } finally {
            frames.restore();
            commander.destroy();
        }
    });

    test('stopping the poller removes its window listeners', () => {
        installGamepads([makePad()]);
        const frames = stubAnimationFrames();
        const added: string[] = [];
        const removed: string[] = [];
        const nativeAdd = window.addEventListener.bind(window);
        const nativeRemove = window.removeEventListener.bind(window);
        vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, ...rest: []) => {
            added.push(type);
            return nativeAdd(type, ...rest);
        }) as typeof window.addEventListener);
        vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, ...rest: []) => {
            removed.push(type);
            return nativeRemove(type, ...rest);
        }) as typeof window.removeEventListener);

        const commander = new Commander();
        try {
            const release = commander.retain();
            expect(added).toContain('gamepadconnected');
            expect(added).toContain('gamepaddisconnected');
            release();
            expect(removed).toContain('gamepadconnected');
            expect(removed).toContain('gamepaddisconnected');
            // gamepad.js used to add a window 'error' listener it never removed
            expect(added).not.toContain('error');
        } finally {
            frames.restore();
            commander.destroy();
        }
    });
});
