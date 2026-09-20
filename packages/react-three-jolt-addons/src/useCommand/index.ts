/* use command is a hook to handle user inputs and map them
to commands rather than specifically to keystrokes or gamepad inputs */

import type { CameraControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Command, CommandOptions } from './Command';
import type { CommandCallback, Commander, CommandState } from './Commander';
import { CommanderContext, getFallbackCommander } from './CommanderContext';
import type { VectorCommand } from './VectorCommand';

// export from the helpers
export * from './Command';
export * from './Commander';
export type { CommanderProviderProps } from './CommanderContext';
export { CommanderContext, CommanderProvider } from './CommanderContext';
export * from './commonCommands';
export * from './gamepad';
export * from './lookCommand';
export * from './VectorCommand';

/**
 * Resolve the commander for this subtree and keep it alive for as long as this component is
 * mounted. The first hook to retain it attaches the window/gamepad listeners; when the last one
 * unmounts they are removed again.
 */
export const useCommander = (): Commander => {
    const provided = useContext(CommanderContext);
    // Creating a commander has no side effects (it attaches nothing until retained), so it is
    // safe to build one lazily in a state initializer.
    const [fallback] = useState(() => provided ?? getFallbackCommander());
    const commander = provided ?? fallback;

    useEffect(() => commander.retain(), [commander]);

    return commander;
};

// returns a state of the commander's commands
export function useCommandState(): CommandState {
    const commander = useCommander();
    return useSyncExternalStore(commander.subscribe, commander.getSnapshot, commander.getSnapshot);
}

/**
 * Bind a callback to a command.
 *
 * Registration happens in an effect, never during render, so a Strict Mode double render can't
 * register the same listener twice and every listener is removed on unmount. The callbacks are
 * read through refs, so passing inline arrow functions does not re-subscribe on every render.
 *
 * The command itself is only available after the first effect has run, hence the `undefined`.
 */
export function useCommand(
    commandString: string,
    onStart?: CommandCallback,
    onEnd?: CommandCallback,
    options?: CommandOptions
): Command | VectorCommand | undefined {
    const commander = useCommander();
    const [command, setCommand] = useState<Command | VectorCommand | undefined>(undefined);

    const onStartRef = useRef(onStart);
    const onEndRef = useRef(onEnd);
    const optionsRef = useRef(options);
    useEffect(() => {
        onStartRef.current = onStart;
        onEndRef.current = onEnd;
        optionsRef.current = options;
    });

    // attach the listeners in a useEffect and the return will remove them
    useEffect(() => {
        const target =
            commander.getCommand(commandString) ??
            commander.addCommand(commandString, optionsRef.current);
        setCommand(target);

        const down: CommandCallback = (info) => onStartRef.current?.(info);
        const up: CommandCallback = (info) => onEndRef.current?.(info);
        commander.addListener(commandString, down);
        commander.addListener(commandString, up, true);

        // remove the listeners when destroyed
        return () => {
            commander.removeListener(commandString, down);
            commander.removeListener(commandString, up);
            setCommand(undefined);
        };
    }, [commander, commandString]);

    return command;
}

export function useGamepadForCameraControls(
    commandString: string,
    controls: CameraControls,
    options?: CommandOptions
) {
    // lets be 100% the command exists
    const command = useCommand(commandString, undefined, undefined, options);

    // assign the options to the root command
    useEffect(() => {
        command?.setOptions(options);
    }, [command, options]);

    // bind the state
    const commandState = useCommandState();
    // we do this verbose version incase you dont want 'look'
    const targetCommand = commandState[commandString];
    // sensitivity (scalar)
    const sensitivity = typeof options?.sensitivity === 'number' ? options.sensitivity : 0.03;

    // loop
    useFrame(() => {
        if (!controls || typeof targetCommand !== 'object') return;
        controls.rotate(targetCommand.x * sensitivity, targetCommand.y * sensitivity);
    });
}
