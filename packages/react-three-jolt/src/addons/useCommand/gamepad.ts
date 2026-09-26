/**
 * A small in-house gamepad poller (issue #12).
 *
 * It replaces the `gamepad.js` dependency: same event payloads (`GamepadInputEvent`), but it
 * only runs while something is listening, it never throws in an environment without the Gamepad
 * API, and it cleans up every listener it adds.
 *
 * The browser gives us no gamepad input events, only a snapshot array from
 * `navigator.getGamepads()`, so the values have to be diffed on a `requestAnimationFrame` loop.
 */

import type { GamepadEventDetail, GamepadInputEvent } from './Command';

/**
 * The W3C "standard gamepad" button order, which is what the presets in `commonCommands.ts` are
 * written against (`jump: [0]` is A, `moveForward: [12]` is dpad up, `fire: [7]` is the right
 * trigger). Exposed so consumers can bind by name instead of by magic number.
 */
export const standardGamepadButtons = [
    'A',
    'B',
    'X',
    'Y',
    'LeftBumper',
    'RightBumper',
    'LeftTrigger',
    'RightTrigger',
    'Back',
    'Start',
    'LeftStick',
    'RightStick',
    'DPadUp',
    'DPadDown',
    'DPadLeft',
    'DPadRight',
    'Home'
] as const;

export type StandardGamepadButton = (typeof standardGamepadButtons)[number];

/** Name of a button index in the standard mapping, or `undefined` for a non standard button. */
export function gamepadButtonName(button: number): StandardGamepadButton | undefined {
    return standardGamepadButtons[button];
}

/** The standard mapping axes of each stick: `[horizontal, vertical]`. */
export const standardGamepadSticks = {
    left: [0, 1],
    right: [2, 3]
} as const;

export type GamepadPollerOptions = {
    /** axis values at or below this magnitude report as 0. defaults to 0.15 */
    deadzone?: number;
    /** an axis only emits once it has moved this far from the last value it emitted. 0.01 */
    axisThreshold?: number;
    /** same idea for the analog value of a button; a pressed change always emits. 0.01 */
    buttonThreshold?: number;
    debug?: boolean;
};

export type GamepadPollerHandlers = {
    onButton?: (event: GamepadInputEvent) => void;
    onAxis?: (event: GamepadInputEvent) => void;
    onConnected?: (event: GamepadInputEvent) => void;
    onDisconnected?: (event: GamepadInputEvent) => void;
};

/** the part of the DOM `Gamepad` we read; kept structural so tests can hand us a plain object */
type GamepadLike = {
    index?: number;
    axes: readonly number[];
    buttons: readonly { pressed?: boolean; value?: number }[];
};

type PadState = {
    axes: number[];
    buttons: { pressed: boolean; value: number }[];
};

const DEFAULT_DEADZONE = 0.15;
const DEFAULT_AXIS_THRESHOLD = 0.01;
const DEFAULT_BUTTON_THRESHOLD = 0.01;

/** Can this environment poll gamepads at all? (node, SSR and older browsers can't.) */
export function hasGamepadSupport(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        typeof navigator.getGamepads === 'function' &&
        typeof window !== 'undefined' &&
        typeof window.requestAnimationFrame === 'function'
    );
}

function makeEvent(type: string, detail: GamepadEventDetail): GamepadInputEvent {
    return { type, detail };
}

export class GamepadPoller {
    private handlers: GamepadPollerHandlers;
    private deadzone: number;
    private axisThreshold: number;
    private buttonThreshold: number;
    private debug: boolean;

    /** last values we emitted, per gamepad index */
    private states = new Map<number, PadState>();
    private frame: number | null = null;
    private running = false;

    constructor(handlers: GamepadPollerHandlers, options: GamepadPollerOptions = {}) {
        this.handlers = handlers;
        this.deadzone = options.deadzone ?? DEFAULT_DEADZONE;
        this.axisThreshold = options.axisThreshold ?? DEFAULT_AXIS_THRESHOLD;
        this.buttonThreshold = options.buttonThreshold ?? DEFAULT_BUTTON_THRESHOLD;
        this.debug = options.debug ?? false;
    }

    /** true while the poll loop is scheduled */
    get isRunning() {
        return this.running;
    }

    /**
     * Start polling. A no-op (not a throw) where there is no Gamepad API, so a caller can always
     * check `isRunning` afterwards to find out whether anything was attached.
     */
    start = () => {
        if (this.running) return;
        if (!hasGamepadSupport()) {
            if (this.debug) console.warn('GamepadPoller: no gamepad API, skipping gamepad input');
            return;
        }
        this.running = true;
        window.addEventListener('gamepadconnected', this.onGamepadConnected);
        window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
        this.schedule();
    };

    /** Stop polling and forget every pad. Idempotent. */
    stop = () => {
        if (!this.running) return;
        this.running = false;
        window.removeEventListener('gamepadconnected', this.onGamepadConnected);
        window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
        if (this.frame !== null) {
            window.cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        this.states.clear();
    };

    private schedule() {
        this.frame = window.requestAnimationFrame(this.tick);
    }

    private tick = () => {
        this.frame = null;
        if (!this.running) return;
        this.poll();
        // a handler may have stopped us
        if (this.running) this.schedule();
    };

    /**
     * Read every gamepad once and emit what changed. Public so a consumer (or a test) can drive
     * the poller from its own loop instead of `requestAnimationFrame`.
     */
    poll = () => {
        if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
        const pads = navigator.getGamepads() as unknown as (GamepadLike | null)[];
        const seen = new Set<number>();
        for (let slot = 0; slot < pads.length; slot++) {
            const pad = pads[slot];
            if (!pad) continue;
            // the browser reports its own index; fall back to the slot for hand written fakes
            const index = typeof pad.index === 'number' ? pad.index : slot;
            seen.add(index);
            this.updatePad(index, pad);
        }
        // a pad that vanished from the snapshot counts as disconnected, even if the window event
        // never arrived (it doesn't, in some browsers, when the page is backgrounded)
        for (const index of [...this.states.keys()]) if (!seen.has(index)) this.dropPad(index);
    };

    private updatePad(index: number, pad: GamepadLike) {
        const state = this.states.get(index);
        if (!state) {
            // first sighting: take the current values as the baseline without emitting, so a
            // controller that is already holding a button doesn't fire the moment we look at it
            this.states.set(index, {
                axes: Array.from(pad.axes, (value) => this.applyDeadzone(value)),
                buttons: Array.from(pad.buttons, (button) => ({
                    pressed: !!button?.pressed,
                    value: button?.value ?? 0
                }))
            });
            this.handlers.onConnected?.(makeEvent('gamepad:connected', { index, value: 0 }));
            return;
        }

        for (let axis = 0; axis < pad.axes.length; axis++) {
            const value = this.applyDeadzone(pad.axes[axis]);
            const previous = state.axes[axis] ?? 0;
            if (Math.abs(value - previous) < this.axisThreshold) continue;
            state.axes[axis] = value;
            this.handlers.onAxis?.(makeEvent('gamepad:axis', { index, axis, value }));
        }

        for (let button = 0; button < pad.buttons.length; button++) {
            const source = pad.buttons[button];
            const pressed = !!source?.pressed;
            const value = source?.value ?? (pressed ? 1 : 0);
            const previous = state.buttons[button] ?? { pressed: false, value: 0 };
            if (
                pressed === previous.pressed &&
                Math.abs(value - previous.value) < this.buttonThreshold
            )
                continue;
            state.buttons[button] = { pressed, value };
            this.handlers.onButton?.(
                makeEvent('gamepad:button', {
                    index,
                    button,
                    name: gamepadButtonName(button),
                    value,
                    pressed
                })
            );
        }
    }

    /** Forget a pad, releasing anything it was holding so no command can get stuck down. */
    private dropPad(index: number) {
        const state = this.states.get(index);
        if (!state) return;
        this.states.delete(index);
        state.buttons.forEach((button, buttonIndex) => {
            if (!button.pressed && button.value === 0) return;
            this.handlers.onButton?.(
                makeEvent('gamepad:button', {
                    index,
                    button: buttonIndex,
                    name: gamepadButtonName(buttonIndex),
                    value: 0,
                    pressed: false
                })
            );
        });
        state.axes.forEach((value, axis) => {
            if (value === 0) return;
            this.handlers.onAxis?.(makeEvent('gamepad:axis', { index, axis, value: 0 }));
        });
        this.handlers.onDisconnected?.(makeEvent('gamepad:disconnected', { index, value: 0 }));
    }

    private applyDeadzone(value: number | undefined) {
        if (typeof value !== 'number' || Number.isNaN(value)) return 0;
        return Math.abs(value) <= this.deadzone ? 0 : value;
    }

    // Window events ---------------------------------------------------------
    // happy-dom and older lib.dom versions don't always have `GamepadEvent`, so read the gamepad
    // off the event structurally.
    private onGamepadConnected = (event: Event) => {
        const index = gamepadIndexOf(event);
        if (this.debug) console.log('GamepadPoller: gamepad connected', index);
        // pick it up on the next poll; `updatePad` takes the baseline then
    };

    private onGamepadDisconnected = (event: Event) => {
        const index = gamepadIndexOf(event);
        if (this.debug) console.log('GamepadPoller: gamepad disconnected', index);
        if (index === undefined) {
            for (const known of [...this.states.keys()]) this.dropPad(known);
            return;
        }
        this.dropPad(index);
    };
}

function gamepadIndexOf(event: Event): number | undefined {
    const gamepad = (event as Event & { gamepad?: { index?: number } }).gamepad;
    return typeof gamepad?.index === 'number' ? gamepad.index : undefined;
}
