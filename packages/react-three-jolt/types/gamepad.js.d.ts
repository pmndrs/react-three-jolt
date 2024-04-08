declare module "gamepad.js" {
    export interface Gamepad {
        axes: number[];
        buttons: GamepadButton[];
    }

    export interface GamepadButton {
        pressed: boolean;
        value: number;
    }

    export interface GamepadHandlerOptions {
        analog: boolean;
        deadZone: number;
        precision: number;
    }

    export interface GamepadHandlerEvent {
        gamepad: Gamepad;
        index: number;
        axis?: number;
        button?: number;
        pressed?: boolean;
        value: number;
    }

    export default class GamepadHandler {
        constructor(
            index: number,
            gamepad: Gamepad,
            config?: GamepadHandlerOptions
        );
        static resolveOptions(config: GamepadHandlerOptions): {
            axis: GamepadHandlerOptions;
            button: GamepadHandlerOptions;
        };
        update(gamepad: Gamepad): void;
        private initAxes(): void;
        private initButtons(): void;
        private updateAxis(): void;
        private updateButtons(): void;
        private setAxisValue(index: number, value: number): void;
        private setButtonValue(index: number, value: number): void;
        private resolveAxisValue(index: number): number;
        private resolveButtonValue(index: number): number;
        on(event: "axis", listener: (event: GamepadHandlerEvent) => void): void;
        on(
            event: "button",
            listener: (event: GamepadHandlerEvent) => void
        ): void;
        off(
            event: "axis",
            listener: (event: GamepadHandlerEvent) => void
        ): void;
        off(
            event: "button",
            listener: (event: GamepadHandlerEvent) => void
        ): void;
        start(): void;
        stop(): void;
    }
}
