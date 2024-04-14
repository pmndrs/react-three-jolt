//@ts-ignore
import { GamepadListener } from 'gamepad.js';
import { commonCommands } from './commonCommands';
import { Command } from './Command';
import { VectorCommand } from './VectorCommand';

// im not sure yet if I'll include other libraries

export type CommandCallback = (info: {
  command: Command;
  label: string;
  method: string;
  value: string | number | boolean;

  isInitial: boolean;

  event?: KeyboardEvent | MouseEvent;
  duration?: number;
}) => void;

export class Commander {
  commands: Map<string, Command | VectorCommand> = new Map();
  // listeners for state changes
  stateListeners = [];
  // state object
  state = {};
  // state flags
  isDirty = false;
  paused = false;
  debug = false;

  gamepadListener: GamepadListener = new GamepadListener();

  constructor() {
    console.log('gamepad listeners attaching');
    // add gamepad listeners
    this.gamepadListener.on('gamepad:connected', (event: any) => {
      if (this.debug) console.log('gamepad connected', event);
    });
    //gamepad
    this.gamepadListener.on('gamepad:button', this.onButtonChange);
    this.gamepadListener.on('gamepad:axis', this.onAxisChange);
    this.gamepadListener.start();

    // keyboard
    window.addEventListener('keydown', this.keyEventListener);
    window.addEventListener('keyup', this.keyEventListener);

    // mouse
    window.addEventListener('mousedown', this.mouseEventListener);
    window.addEventListener('mouseup', this.mouseEventListener);
  }

  // Primary Listeners ==========================
  // Gamepad Axis Events ---
  onAxisChange = (event: any) => {
    const { axis, value } = event.detail;
    this.commands.forEach((command) => {
      if (command.axis.includes(axis)) {
        this.isDirty = true;
        command.handleDown(event, value);
      }
    });
    if (this.isDirty) this.emitChange();
  };
  // Gamepad Button Events ---
  // buttons act just like keys, just a little different when released
  onButtonChange = (event: any) => {
    const { button, value, pressed } = event.detail;
    // TODO: Check if this is still needed.
    /* On my xbox controller, the trigger button will send
        a value for less that 0.12 but not mark the trigger as pressed
        I initially thought it was deadzone, but that's not the case.
        the vanilla gamepad object shows the button as not pressed
        for now we will check if it's not pressed but has a value to pass it 
        as a still down event */
    this.commands.forEach((command) => {
      if (command.buttons.includes(button)) {
        this.isDirty = true;
        if (pressed || (!pressed && value !== 0))
          command.handleDown(event, value);
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
    const key = 'Mouse' + event.button;
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

  addCommand = (
    commandString: string,
    // TODO: move this to a type
    options?: { keys?: string[]; buttons?: string[]; asVector?: boolean }
  ) => {
    let { keys, buttons, asVector, ...rest } = options || {};
    const command = asVector
      ? new VectorCommand(commandString, this, rest)
      : new Command(commandString);
    // check if the command is in our common list and pull the keys/buttons
    //@ts-ignore
    if (commonCommands[commandString]) {
      //@ts-ignore
      keys = keys || commonCommands[commandString].keys;
      //@ts-ignore
      buttons = buttons || commonCommands[commandString].buttons;
    }
    // if no keys or buttons are passed, default to the commandString
    command.keys = keys || [commandString];
    //@ts-ignore
    command.buttons = buttons || [];
    if (this.debug)
      console.log(
        'Adding command',
        commandString,
        command.keys,
        command.buttons
      );
    this.commands.set(commandString, command);
    return this.getCommand(commandString);
  };

  getCommand = (commandString: string) => {
    return this.commands.get(commandString);
  };

  // Listeners ========================================

  // add listeners to a command
  addListener = (
    commandString: string,
    callback: CommandCallback,
    asUp?: boolean
  ) => {
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
      command.upListeners = command.upListeners.filter(
        (listener) => listener !== callback
      );
    }
  };

  // we have a lot of options here. active, starteDate, running, etc
  // for now just update all active commands
  updateState() {
    // bail if paused
    if (this.paused) return;
    this.commands.forEach((command) => {
      if (command.active) {
        //@ts-ignore
        this.state[command.label] = command.value;
      }
    });
  }

  // return the state as a snapshot
  getSnapsot = () => {
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

  // add a stateListener
  subscribe = (callback: any) => {
    if (this.debug) console.log('adding state listener');
    //@ts-ignore
    this.stateListeners.push(callback);
    return this.unsubscribe.bind(this, callback);
  };
  // remove a stateListener
  unsubscribe = (callback: any) => {
    if (this.debug) console.log('removing state listener');
    this.stateListeners = this.stateListeners.filter(
      (listener) => listener !== callback
    );
  };
  // fire the subscription listener
  emitChange() {
    // dont emit if paused
    if (this.paused) return;

    this.stateListeners.forEach((listener: any) => listener(this.state));
  }

  destroy = () => {
    window.removeEventListener('keydown', this.keyEventListener);
    window.removeEventListener('keyup', this.keyEventListener);
    window.removeEventListener('mousedown', this.mouseEventListener);
    window.removeEventListener('mouseup', this.mouseEventListener);
    this.gamepadListener.stop();
  };
}
