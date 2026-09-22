import {
    Command,
    type CommandEvent,
    type CommandOptions,
    type CommandValue,
    type CommandVector,
    isGamepadInputEvent
} from './Command';
import type { Commander, CommandInfo } from './Commander';
import { type VectorBinding, type VectorPreset, vectorPresets } from './commonCommands';

export type VectorOptions = Pick<CommandOptions, 'preset' | 'bindings' | 'axis' | 'inverted'>;

const presets: Record<string, VectorPreset | undefined> = vectorPresets;

/** presets key their directions alongside `axis`, which is a plain number list. */
function asBinding(entry: VectorBinding | number[] | undefined): VectorBinding | undefined {
    return entry && !Array.isArray(entry) ? entry : undefined;
}

/** every input we read reports a numeric magnitude; anything else counts as "not pressed". */
function toMagnitude(value: CommandValue | undefined): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return 0;
}

// an vector command is like move or look
// the value set is a {x, y} object and accepts up to 4 inputs
export class VectorCommand extends Command {
    // hold a handle to the parent commander
    commander: Commander;
    // for a mouse, the min and max wont match by axis
    mouseRange = { x: { min: -1, max: 1 }, y: { min: -1, max: 1 } };
    // key and button bindings. default is move
    bindings: VectorPreset = { ...vectorPresets.move };

    // for now, bind all 4 axis
    axis: number[] = [0, 1, 2, 3];
    inverted = { x: false, y: false };
    value: CommandVector = { x: 0, y: 0 };

    // how many keys are down
    // theres a bug when you lift it fires the end command even if other move keys are down
    activeKeys = new Map<string, number>();

    constructor(label: string, commander: Commander, options?: VectorOptions) {
        super(label);
        this.commander = commander;

        // TODO: Do we need options in the constructor?
        // binding options
        // set the bindings based on this label
        // NOTE: copy the preset, otherwise `options.bindings` below mutates the shared preset
        // for every other command in the process.
        this.bindings = { ...(presets[this.label] ?? vectorPresets.move) };
        if (options) {
            const preset = options.preset ? presets[options.preset] : undefined;
            if (preset) this.bindings = { ...preset };
            if (options.bindings) Object.assign(this.bindings, options.bindings);
            if (options.axis) this.axis = options.axis;
            if (options.inverted) Object.assign(this.inverted, options.inverted);
        }

        // create our own bindings for the four directions
        this.setupEventBindings();
    }
    // Setup bindings
    setupEventBindings() {
        // loop over key bindings
        Object.keys(this.bindings).forEach((direction) => {
            // if it's axis just add the value to this axis
            if (direction === 'axis') {
                const axis = this.bindings.axis;
                if (axis) this.axis = axis;
                return;
            }
            const commandArgs = asBinding(this.bindings[direction]);
            if (!commandArgs) return;
            this.commander.addCommand(this.label + direction, {
                keys: commandArgs.keys,
                buttons: commandArgs.buttons
            });
            this.commander.addListener(
                this.label + direction,
                this.handleInputStart
                // This might be better
                // this.handleDown.bind(this),
            );
            this.commander.addListener(this.label + direction, this.handleInputEnd, true);
        });
    }

    private orientationOf(direction: string) {
        return asBinding(this.bindings[direction])?.orientation ?? 1;
    }

    // TODO: Should I merge this and inputStart? this is mostly for axis
    // we have to catch the handleDown event to be able to map it to vector
    handleDown(event?: CommandEvent, value?: CommandValue) {
        // Right now only the axis is calling this as our own listeners moved to input
        const axis = isGamepadInputEvent(event) ? event.detail.axis : undefined;
        // in a gamepad only axis 1 & 3 are for forward/backwards
        const direction = axis === 1 || axis === 3 ? 'forward' : 'right';
        this.setVectorFromDirection(direction, 1, toMagnitude(value));
        return super.handleDown(event, this.value);
    }

    // these are registered as command listeners, so they must be stable references
    handleInputStart = (info: CommandInfo) => {
        // remove this label from the label property of the string
        const direction = info.label.replace(this.label, '');
        // get the orientation from the binding
        const orientation = this.orientationOf(direction);
        const magnitude = toMagnitude(info.value);
        // set the value of the vector
        this.setVectorFromDirection(direction, orientation, magnitude);
        this.activeKeys.set(direction, magnitude);
        this.processActiveKeys();
        super.handleDown(info.event, this.value);
    };
    handleInputEnd = (info: CommandInfo) => {
        // TODO: Should this be a single function so its not replicated in start?
        // remove this label from the label property of the string
        const direction = info.label.replace(this.label, '');
        // get the orientation from the binding
        const orientation = this.orientationOf(direction);
        // set the value of the vector
        this.setVectorFromDirection(direction, orientation, toMagnitude(info.value));
        //remove the key from the active keys
        this.activeKeys.delete(direction);
        this.processActiveKeys();

        //when we lift the key we need to tell the system of the new value
        // which if there are keys down is different than what we expect
        if (!this.activeKeys.size) super.handleUp(info.event, this.value);
        //otherwise fire the down event again
        else super.handleDown(info.event, this.value);
    };
    //loop over the active keys and set the value
    processActiveKeys() {
        // set everything to 0
        this.value = { x: 0, y: 0 };
        this.activeKeys.forEach((value, direction) => {
            this.setVectorFromDirection(direction, this.orientationOf(direction), value, true);
        });
        return this.value;
    }

    /**
     * Which component of the vector a named direction contributes to. `move` names its vertical
     * directions forward/backward, `look` names them up/down -- the latter used to fall through
     * to `x`, so the whole `look` preset drove yaw with its pitch bindings.
     */
    private static verticalDirections = ['forward', 'backward', 'up', 'down'];

    // set the value of the vector based on the string direction
    setVectorFromDirection(
        direction: string,
        orientation: number,
        value: number,
        addative: boolean = false
    ) {
        const targetProp = VectorCommand.verticalDirections.includes(direction) ? 'y' : 'x';
        // drop the value to 0 if its below/above the deadzone
        if (Math.abs(value) <= this.deadzone) value = 0;
        // handle orientation and if it's inverted
        const current = addative ? this.value[targetProp] || 0 : 0;
        this.value[targetProp] =
            current + value * orientation * (this.inverted[targetProp] ? -1 : 1);
        return this.value;
    }
    // this is me thinking about mapping look to commands
    setMouseRange() {}
}
