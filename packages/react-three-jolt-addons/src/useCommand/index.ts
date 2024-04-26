/* use command is a hook to handle user inputs and map them
to commands rather than specifically to keystrokes or gamepad inputs */

import { useEffect, useSyncExternalStore } from 'react';
import { Commander, CommandCallback } from './Commander';
import { CameraControls } from '@react-three/drei';
import { Vec2 } from 'three';
import { useFrame } from '@react-three/fiber';

// Puts a singleton into global space
//TODO: Not sure this the right way to do a global singleton
let commander: Commander;

// export from the helpers
export * from './lookCommand';

// returns a state of the commander's commands
export function useCommandState() {
    const commander = useCommander();
    const commandState = useSyncExternalStore(commander.subscribe, commander.getSnapsot);
    return commandState;
}

// hook to load the commander class and also initialize the commander
export const useCommander = () => {
    if (!commander) commander = new Commander();
    return commander;
};
// actual primary hook
export function useCommand(
    commandString: string,
    onStart?: (info: CommandCallback) => void,
    onEnd?: (info: CommandCallback) => void,
    options?: any
) {
    const commander = useCommander();
    let command =
        commander.getCommand(commandString) || commander.addCommand(commandString, options);

    // attach the listeners in a useEffect and the return will remove them
    useEffect(() => {
        //@ts-ignore
        if (onStart) commander.addListener(commandString, onStart);
        //@ts-ignore
        if (onEnd) commander.addListener(commandString, onEnd, true);

        // remove the listeners when destroyed
        return () => {
            //@ts-ignore
            if (onStart) commander.removeListener(commandString, onStart);
            //@ts-ignore
            if (onEnd) commander.removeListener(commandString, onEnd);
        };
    }, [commandString, onStart, onEnd]);
    return command;
}

export function useGamepadForCameraControls(
    commandString: string,
    controls: CameraControls,
    options?: any
) {
    // lets be 100% the command exists
    const command = useCommand(commandString);

    // assign the options to the root command
    useEffect(() => command!.setOptions(options), [options]);

    // bind the state
    const commandState = useCommandState();
    //@ts-ignore we do this verbose version incase you dont want 'look'
    const targetCommand = commandState[commandString];
    // sensitivity (scalar)
    const sensitivity = options?.sensitivity || 0.03;
    // pass the other options to the command

    // do the rotation
    function rotate(rotation: Vec2) {
        controls.rotate(rotation.x * sensitivity, rotation.y * sensitivity);
    }

    // loop
    useFrame(() => {
        if (targetCommand) rotate(targetCommand);
    });
}
