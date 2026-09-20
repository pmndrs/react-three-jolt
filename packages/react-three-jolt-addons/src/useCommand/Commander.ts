import {
    Command,
    type CommandEvent,
    type CommandOptions,
    type CommandValue,
    type GamepadInputEvent
} from './Command';
import { type CommonCommand, commonCommands } from './commonCommands';
import { GamepadPoller, type GamepadPollerOptions } from './gamepad';
import { VectorCommand } from './VectorCommand';

// im not sure yet if I'll include other libraries

// `commandString` is free-form, so look the presets up through a widened view of the table.
const commonCommandsByName: Record<string, CommonCommand | undefined> = commonCommands;

/** The payload every command listener receives. */
export type CommandInfo = {
    command: Command;
    label: string;
    method: string;
    value: CommandValue;

    isInitial: boolean;

    startTime: number;
    event?: CommandEvent;
    duration?: number;
};

export type CommandCallback = (info: CommandInfo) => void;

/** The flattened state of every active command, keyed by command label. */
export type CommandState = Record<string, CommandValue>;
export type CommandStateListener = (state: CommandState) => void;

export type CommanderOptions = {
    debug?: boolean;
    /** deadzone/thresholds for the built in gamepad poller */
    gamepad?: GamepadPollerOptions;
};

export class Commander {
    commands: Map<string, Command | VectorCommand> = new Map();
    // listeners for state changes
    private stateListeners: CommandStateListener[] = [];
    // state object
    state: CommandState = {};
    // state flags
    isDirty = false;
    paused = false;
    debug = false;

    // Lifecycle ==========================================
    // The commander owns window listeners and a gamepad polling loop, so it is not allowed to
    // attach anything until someone retains it, and it must let go of everything when the last
    // consumer releases it. Constructing one is side effect free.
    private gamepadPoller: GamepadPoller | null = null;
    private gamepadOptions: GamepadPollerOptions;
    private connected = false;
    private refCount = 0;

    constructor(options?: CommanderOptions) {
        this.debug = options?.debug ?? false;
        this.gamepadOptions = options?.gamepad ?? {};
    }

    /** true while the gamepad poll loop is running (false without a Gamepad API) */
    get isPollingGamepads() {
        return this.gamepadPoller?.isRunning ?? false;
    }

    /** true while the window/gamepad listeners are attached */
    get isConnected() {
        return this.connected;
    }
    /** how many live consumers (hooks) currently hold this commander */
    get consumerCount() {
        return this.refCount;
    }

    /**
     * Register interest in this commander. The first retain attaches the listeners; the returned
     * release function detaches them again once the last consumer has let go. The release function
     * is idempotent, so a double invoke (React Strict Mode, a re-run effect) can't unbalance the
     * count.
     */
    retain = () => {
        this.refCount++;
        if (this.refCount === 1) this.connect();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.refCount = Math.max(0, this.refCount - 1);
            if (this.refCount === 0) this.disconnect();
        };
    };

    /** Attach the window and gamepad listeners. Idempotent. */
    connect = () => {
        if (this.connected || typeof window === 'undefined') return;
        this.connected = true;

        // keyboard
        window.addEventListener('keydown', this.keyEventListener);
        window.addEventListener('keyup', this.keyEventListener);

        // mouse
        window.addEventListener('mousedown', this.mouseEventListener);
        window.addEventListener('mouseup', this.mouseEventListener);

        // gamepad (polls with requestAnimationFrame while running)
        this.connectGamepad();
    };

    /** Remove every listener and stop the gamepad poll. Idempotent. */
    disconnect = () => {
        if (!this.connected) return;
        this.connected = false;

        window.removeEventListener('keydown', this.keyEventListener);
        window.removeEventListener('keyup', this.keyEventListener);
        window.removeEventListener('mousedown', this.mouseEventListener);
        window.removeEventListener('mouseup', this.mouseEventListener);

        this.disconnectGamepad();
    };

    /** Force a full teardown regardless of the retain count. */
    destroy = () => {
        this.refCount = 0;
        this.disconnect();
    };

    private connectGamepad() {
        if (this.gamepadPoller) return;
        const poller = new GamepadPoller(
            {
                onButton: this.onButtonChange,
                onAxis: this.onAxisChange,
                onConnected: (event) => {
                    if (this.debug) console.log('gamepad connected', event);
                },
                onDisconnected: (event) => {
                    if (this.debug) console.log('gamepad disconnected', event);
                }
            },
            { debug: this.debug, ...this.gamepadOptions }
        );
        // a no-op where there is no Gamepad API; nothing was attached, so nothing to hold on to
        poller.start();
        if (poller.isRunning) this.gamepadPoller = poller;
    }

    private disconnectGamepad() {
        const poller = this.gamepadPoller;
        if (!poller) return;
        this.gamepadPoller = null;
        // stops the requestAnimationFrame poll loop and removes its window listeners
        poller.stop();
    }

    // Primary Listeners ==========================
    // Gamepad Axis Events ---
    onAxisChange = (event: GamepadInputEvent) => {
        const { axis, value } = event.detail;
        this.commands.forEach((command) => {
            if (axis !== undefined && command.axis.includes(axis)) {
                this.isDirty = true;
                command.handleDown(event, value);
            }
        });
        if (this.isDirty) this.emitChange();
    };
    // Gamepad Button Events ---
    // buttons act just like keys, just a little different when released
    onButtonChange = (event: GamepadInputEvent) => {
        const { button, value, pressed } = event.detail;
        // TODO: Check if this is still needed.
        /* On my xbox controller, the trigger button will send
        a value for less that 0.12 but not mark the trigger as pressed
        I initially thought it was deadzone, but that's not the case.
        the vanilla gamepad object shows the button as not pressed
        for now we will check if it's not pressed but has a value to pass it
        as a still down event */
        this.commands.forEach((command) => {
            if (button !== undefined && command.buttons.includes(button)) {
                this.isDirty = true;
                if (pressed || (!pressed && value !== 0)) command.handleDown(event, value);
                else command.handleUp(event);
            }
        });
        if (this.isDirty) this.emitChange();
    };
    // Keyboard Events ---
    keyEventListener = (event: KeyboardEvent) => {
        this.commands.forEach((command) => {
            if (command.keys.includes(event.key)) {
                this.isDirty = true;
                if (event.type === 'keydown') command.handleDown(event);
                else command.handleUp(event);
            }
        });
        if (this.isDirty) this.emitChange();
    };
    // Mouse Events ---
    mouseEventListener = (event: MouseEvent) => {
        const key = `Mouse${event.button}`;
        this.commands.forEach((command) => {
            if (command.keys.includes(key)) {
                this.isDirty = true;
                if (event.type === 'mousedown') command.handleDown(event);
                else command.handleUp(event);
            }
        });
        if (this.isDirty) this.emitChange();
    };

    // Commands ========================================

    addCommand = (commandString: string, options?: CommandOptions) => {
        let { keys, buttons } = options || {};
        const command = options?.asVector
            ? new VectorCommand(commandString, this, options)
            : new Command(commandString);
        // check if the command is in our common list and pull the keys/buttons
        const common = commonCommandsByName[commandString];
        if (common) {
            keys = keys || common.keys;
            buttons = buttons || common.buttons;
        }
        // if no keys or buttons are passed, default to the commandString
        command.keys = keys || [commandString];
        command.buttons = buttons || [];
        if (this.debug) console.log('Adding command', commandString, command.keys, command.buttons);
        this.commands.set(commandString, command);
        return command;
    };

    getCommand = (commandString: string) => {
        return this.commands.get(commandString);
    };

    /** Drop every command and its listeners. */
    clearCommands = () => {
        this.commands.clear();
        this.state = {};
        this.isDirty = false;
    };

    // Listeners ========================================

    // add listeners to a command
    addListener = (commandString: string, callback: CommandCallback, asUp?: boolean) => {
        const command = this.getCommand(commandString);
        if (command) {
            if (!asUp) command.downListeners.push(callback);
            else command.upListeners.push(callback);
        }
    };
    // TODO: move this to a patern where the add returns the remove
    // remove listener
    removeListener = (commandString: string, callback: CommandCallback) => {
        const command = this.getCommand(commandString);
        if (command) {
            command.downListeners = command.downListeners.filter(
                (listener) => listener !== callback
            );
            command.upListeners = command.upListeners.filter((listener) => listener !== callback);
        }
    };

    // we have a lot of options here. active, starteDate, running, etc
    // for now just update all active commands
    updateState() {
        // bail if paused
        if (this.paused) return;
        this.commands.forEach((command) => {
            if (command.active) {
                this.state[command.label] = command.value;
            } else if (command.label in this.state) {
                // a command that went inactive used to keep its last value in the state forever,
                // so consumers of `useCommandState` kept acting on an input nobody is giving
                delete this.state[command.label];
            }
        });
    }

    // return the state as a snapshot
    getSnapshot = (): CommandState => {
        // if this isn't dirty, return the state directly
        if (this.isDirty) {
            //update the state values
            this.updateState();
            // clone the state to create an imutable object.
            const clone = Object.assign({}, this.state);
            //set the state to the new object so it passes matching tests
            this.state = clone;
            this.isDirty = false;
        }
        return this.state;
    };

    /** @deprecated misspelled; use {@link Commander.getSnapshot} */
    getSnapsot = (): CommandState => this.getSnapshot();

    // add a stateListener
    subscribe = (callback: CommandStateListener) => {
        if (this.debug) console.log('adding state listener');
        this.stateListeners.push(callback);
        return () => this.unsubscribe(callback);
    };
    // remove a stateListener
    unsubscribe = (callback: CommandStateListener) => {
        if (this.debug) console.log('removing state listener');
        this.stateListeners = this.stateListeners.filter((listener) => listener !== callback);
    };
    // fire the subscription listener
    emitChange() {
        // dont emit if paused
        if (this.paused) return;

        this.stateListeners.slice().forEach((listener) => {
            listener(this.state);
        });
    }
}
