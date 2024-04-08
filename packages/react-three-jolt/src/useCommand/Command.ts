import { CommandCallback } from './Commander';

export class Command {
  label: string;
  // TODO: move this type
  value: string | number | boolean | { x: number; y: number } = 0;
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
  handleDown(
    event: KeyboardEvent | MouseEvent,
    value?: number | string | boolean | { x: number; y: number }
  ) {
    const now = Date.now();
    let duration;
    // check if theres a duration and if its above the threshold (Throttling)
    if (
      !this.active ||
      (this.startTime &&
        now - (this.startTime + this.duration) <= this.threshold)
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
    // TODO: this looks dirty
    if (this.isVariable)
      this.value = value
        ? //@ts-ignore
          value >= this.min
          ? value
          : this.min
        : this.min;
    else this.value = value || this.rate;

    const info = {
      event,
      label: this.label,
      method: event.type,
      value: this.value,
      command: this,
      isInitial: this.isInitial,
      startTime: this.startTime,
      duration,
    };
    //@ts-ignore
    this.downListeners.forEach((listener) => listener(info));
    // TODO Fix typescript to allow early returns
    return false;
  }
  handleUp(event: MouseEvent | KeyboardEvent, value?: number | string) {
    // check if we already stopped due to throttling
    if (!this.running) return false;
    // reset the running value
    this.running = false;
    this.value = value || 0;
    const info = {
      event,
      method: event.type,
      label: this.label,
      value: this.value,
      command: this,
      isInitial: this.isInitial, // not needed?
      startTime: this.startTime,
      duration: this.updateDuration(),
    };
    this.upListeners.forEach((listener) => listener(info));
    return false;
  }
  // if the value needs to change because of a tick
  handleUpdate() {
    this.isInitial = false;

    if (typeof this.value == 'number') {
      const newVal = this.value + this.rate;
      this.value =
        newVal >= this.min
          ? newVal <= this.max
            ? newVal
            : this.max
          : this.min;
    }
    const info = {
      method: 'update',
      value: this.value,
      command: this,
      isInitial: this.isInitial,
      startTime: this.startTime,
      duration: this.updateDuration(),
    };
    //@ts-ignore
    this.downListeners.forEach((listener) => listener(info));
  }
  // takes in an options object and applies to this
  setOptions(options: any) {
    if (!options) return;
    // TODO: should this go into an options object and not direct on the class?
    Object.keys(options).forEach((key: string) => {
      //@ts-ignore

      this[options[key]] = options[key];
    });
  }
  private updateDuration() {
    this.duration = Date.now() - this.startTime;
    return this.duration;
  }
}
