import type { CommandCallback, CommandInfo } from './Commander';
import type { VectorPreset } from './commonCommands';

/** A two axis value, as produced by a `VectorCommand`. */
export type CommandVector = { x: number; y: number };

/** Every value a command can report. */
export type CommandValue = string | number | boolean | CommandVector;

/**
 * The payload the gamepad poller hands us. It is a plain object, not a DOM event, and it keeps
 * the shape `gamepad.js` used to emit (`{ index, axis | button, value, pressed }`) so anything
 * written against the old events still reads.
 */
export type GamepadEventDetail = {
    /** which gamepad (`Gamepad.index`) */
    index: number;
    axis?: number;
    button?: number;
    /** standard mapping name of `button`, e.g. `A` or `DPadUp`; see `gamepad.ts` */
    name?: string;
    value: number;
    pressed?: boolean;
};
export type GamepadInputEvent = {
    type: string;
    detail: GamepadEventDetail;
};

/** Anything that can trigger a command. */
export type CommandEvent = KeyboardEvent | MouseEvent | GamepadInputEvent;

/** DOM UI events carry a numeric `detail`, gamepad events carry the object above. */
export function isGamepadInputEvent(event?: CommandEvent): event is GamepadInputEvent {
    return (
        !!event && 'detail' in event && typeof event.detail === 'object' && event.detail !== null
    );
}

/**
 * Options accepted when creating or reconfiguring a command. Unknown keys are written straight
 * onto the command instance by `setOptions`, which is how consumers attach their own values
 * (`sensitivity`, for example).
 */
export type CommandOptions = {
    keys?: string[];
    buttons?: number[];
    axis?: number[];
    asVector?: boolean;
    /** `VectorCommand` only: name of a preset in `vectorPresets` */
    preset?: string;
    /** `VectorCommand` only: overrides merged onto the preset */
    bindings?: VectorPreset;
    /** `VectorCommand` only: flip an axis */
    inverted?: { x?: boolean; y?: boolean };
    threshold?: number;
    deadzone?: number;
    isVariable?: boolean;
    rate?: number;
    max?: number;
    min?: number;
    active?: boolean;
    [option: string]: unknown;
};

export class Command {
    label: string;
    value: CommandValue = 0;
    downListeners: CommandCallback[] = [];
    upListeners: CommandCallback[] = [];
    keys: string[] = [];
    buttons: number[] = [];
    axis: number[] = [];

    // Options -----------------------------------------
    //throttle rate
    threshold: number = 100;
    deadzone: number = 0.05;

    // if this is a variable rate command
    isVariable: boolean = false;
    rate: number = 1;
    max: number = 1;
    min: number = -1;

    // State Properties --------------------------------
    active = true;
    startTime: number = 0;
    duration: number = 0;
    isInitial: boolean = false;
    running = false;

    constructor(label: string) {
        this.label = label;
    }
    handleDown(event?: CommandEvent, value?: CommandValue) {
        const now = Date.now();
        let duration: number | undefined;
        // check if theres a duration and if its above the threshold (Throttling)
        if (
            !this.active ||
            (this.startTime && now - (this.startTime + this.duration) <= this.threshold)
        )
            return false;

        // Because keydown events fire as long as the key is held down
        // we need to detect if its the first or ongoing
        if (this.running) this.isInitial = false;
        else {
            this.isInitial = true;
            this.running = true;
            this.startTime = now;
            // we do the duration here because we don't need it on initial;
            duration = this.updateDuration();
        }

        // initalize the value to this minimum
        if (this.isVariable) {
            const numeric = typeof value === 'number' ? value : undefined;
            this.value = numeric !== undefined && numeric >= this.min ? numeric : this.min;
        } else this.value = value ?? this.rate;

        const info: CommandInfo = {
            event,
            label: this.label,
            method: event?.type ?? 'update',
            value: this.value,
            command: this,
            isInitial: this.isInitial,
            startTime: this.startTime,
            duration
        };
        this.emit(this.downListeners, info);
        // TODO Fix typescript to allow early returns
        return false;
    }
    handleUp(event?: CommandEvent, value?: CommandValue) {
        // check if we already stopped due to throttling
        if (!this.running) return false;
        // reset the running value
        this.running = false;
        this.value = value ?? 0;
        const info: CommandInfo = {
            event,
            method: event?.type ?? 'update',
            label: this.label,
            value: this.value,
            command: this,
            isInitial: this.isInitial, // not needed?
            startTime: this.startTime,
            duration: this.updateDuration()
        };
        this.emit(this.upListeners, info);
        return false;
    }
    // if the value needs to change because of a tick
    handleUpdate() {
        this.isInitial = false;

        if (typeof this.value === 'number') {
            const newVal = this.value + this.rate;
            this.value = newVal >= this.min ? (newVal <= this.max ? newVal : this.max) : this.min;
        }
        const info: CommandInfo = {
            label: this.label,
            method: 'update',
            value: this.value,
            command: this,
            isInitial: this.isInitial,
            startTime: this.startTime,
            duration: this.updateDuration()
        };
        this.emit(this.downListeners, info);
    }

    /**
     * Takes in an options object and applies it to this command.
     *
     * Note the assignment is by *key*; this used to index by value (`this[options[key]]`) which
     * silently wrote garbage properties and never set the option that was asked for.
     */
    setOptions(options?: CommandOptions) {
        if (!options) return;
        // TODO: should this go into an options object and not direct on the class?
        const target = this as unknown as Record<string, unknown>;
        Object.keys(options).forEach((key: string) => {
            const value = options[key];
            if (value === undefined) return;
            // never let an option clobber one of the command's own methods
            if (typeof target[key] === 'function') return;
            target[key] = value;
        });
    }

    /** Iterate over a copy so a listener that unsubscribes mid-dispatch can't skip its neighbour. */
    private emit(listeners: CommandCallback[], info: CommandInfo) {
        listeners.slice().forEach((listener) => listener(info));
    }

    private updateDuration() {
        this.duration = Date.now() - this.startTime;
        return this.duration;
    }
}
