import { Commander } from './Commander';
import { Command } from './Command';
import { VectorPreset, vectorPresets } from './commonCommands';

type VectorOptions = {
  preset?: string;
  bindings?: VectorPreset;
  axis?: number[];
  inverted?: { x?: boolean; y?: boolean };
};

// an vector command is like move or look
// the value set is a {x, y} object and accepts up to 4 inputs
export class VectorCommand extends Command {
  // hold a handle to the parent commander
  commander: Commander;
  // for a mouse, the min and max wont match by axis
  mouseRange = { x: { min: -1, max: 1 }, y: { min: -1, max: 1 } };
  // key and button bindings. default is move
  bindings = Object.assign({}, vectorPresets.move);

  // for now, bind all 4 axis
  axis: number[] = [0, 1, 2, 3];
  inverted = { x: false, y: false };
  value = { x: 0, y: 0 };

  // how many keys are down
  // theres a bug when you lift it fires the end command even if other move keys are down
  keysDown = {};
  activeKeys = new Map<string, number>();

  constructor(label: string, commander: Commander, options?: VectorOptions) {
    super(label);
    this.commander = commander;

    // TODO: Do we need options in the constructor?
    // binding options
    // set the bindings based on this label
    //@ts-ignore
    this.bindings = vectorPresets[this.label];
    if (options) {
      //@ts-ignore
      if (options.preset && vectorPresets[options.preset])
        //@ts-ignore
        this.bindings = vectorPresets[options.preset];
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
      //@ts-ignore loop over the keys
      const commandArgs = this.bindings[direction];
      // if it's axis just add the value to this axis
      if (direction == 'axis') {
        this.axis = commandArgs;
      } else {
        this.commander.addCommand(this.label + direction, {
          keys: commandArgs.keys,
          buttons: commandArgs.buttons,
        });
        this.commander.addListener(
          this.label + direction,
          this.handleInputStart.bind(this)
          // This might be better
          // this.handleDown.bind(this),
        );
        this.commander.addListener(
          this.label + direction,
          this.handleInputEnd.bind(this),
          true
        );
      }
    });
  }
  // TODO: Should I merge this and inputStart? this is mostly for axis
  // we have to catch the handleDown event to be able to map it to vector
  //@ts-ignore
  handleDown(event: any, value?: any) {
    // Right now only the axis is calling this as our own listeners moved to input
    const { axis } = event.detail;
    // in a gamepad only axis 1 & 3 are for forward/backwards
    const direction = axis == 1 || axis == 3 ? 'forward' : 'right';
    //console.log('VectorCommand handleDown', event, value);
    this.setVectorFromDirection(direction, 1, value);
    //this.keysDown[event.event.key] = true;
    super.handleDown(event, this.value);
  }

  handleInputStart(event: any) {
    // remove this label from the label property of the string
    const direction = event.label.replace(this.label, '');
    // get the orientation from the binding
    //@ts-ignore
    const orientation = this.bindings[direction].orientation || 1;
    // set the value of the vector
    this.setVectorFromDirection(direction, orientation, event.value);
    //console.log('VectorCommand handleInputStart', this.value, event);
    this.activeKeys.set(direction, event.value);
    this.processActiveKeys();
    super.handleDown(event, this.value);
  }
  handleInputEnd(event: any) {
    // TODO: Should this be a single function so its not replicated in start?
    // remove this label from the label property of the string
    const direction = event.label.replace(this.label, '');
    //@ts-ignore get the orientation from the binding
    const orientation = this.bindings[direction].orientation || 1;
    // set the value of the vector
    this.setVectorFromDirection(direction, orientation, event.value);
    //console.log('VectorCommand handleInputEnd', this.value, event);
    //remove the key from the active keys
    this.activeKeys.delete(direction);
    this.processActiveKeys();

    //when we lift the key we need to tell the system of the new value
    // which if there are keys down is different than what we expect
    //@ts-ignore
    if (!this.activeKeys.size) super.handleUp(event, this.value);
    //otherwise fire the down event again
    else super.handleDown(event, this.value);
  }
  //loop over the active keys and set the value
  processActiveKeys() {
    // set everything to 0
    this.value = { x: 0, y: 0 };
    this.activeKeys.forEach((value, direction) => {
      //@ts-ignore
      const orientation = this.bindings[direction].orientation || 1;
      this.setVectorFromDirection(direction, orientation, value, true);
    });
    return this.value;
  }

  // set the value of the vector based on the string direction
  setVectorFromDirection(
    direction: string,
    orientation: number,
    value: number,
    addative: boolean = false
  ) {
    const targetProp =
      direction == 'forward' || direction == 'backward' ? 'y' : 'x';
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
