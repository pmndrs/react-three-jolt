import { useContext, useRef, useEffect } from 'react';
import { joltContext } from '../context';

// External Hooks ====================================
// The core "useJolt" hook is just a wrapper around the joltContext
export const useJolt = () => {
    const jolt = useContext(joltContext);
    if (!jolt) {
        throw new Error('useJolt must be used within a JoltProvider');
    }
    return jolt;
};

// helper function for a cleaner useMemo
// this is the r3/rapier version but you can find it here:
//https://github.com/microsoft/fluentui/blob/master/packages/react-hooks/src/useConst.ts
export function useConst<T>(initialValue: T | (() => T)): T {
    const ref = useRef<{ value: T }>();
    if (ref.current === undefined) {
        ref.current = {
            value: typeof initialValue === 'function' ? (initialValue as Function)() : initialValue
        };
    }
    return ref.current.value;
}

// also from fluentui
export const useMount = (callback: () => void) => {
    const mountRef = useRef(callback);
    mountRef.current = callback;
    useEffect(() => {
        mountRef.current?.();
    }, []);
};
/**
 * Hook which synchronously executes a callback when the component is about to unmount.
 *
 * @param callback - Function to call during unmount.
 */
export const useUnmount = (callback: () => void) => {
    const unmountRef = useRef(callback);
    unmountRef.current = callback;
    useEffect(
        () => () => {
            unmountRef.current?.();
        },
        []
    );
};

export type UseSetTimeoutReturnType = {
    setTimeout: (callback: () => void, duration: number) => number;
    clearTimeout: (id: number) => void;
};

/**
 *  Returns a wrapper function for `setTimeout` which automatically handles disposal.
 */
export const useSetTimeout = (): UseSetTimeoutReturnType => {
    const timeoutIds = useConst<Record<number, number>>({});

    // Cleanup function.
    useEffect(
        () => () => {
            for (const id of Object.keys(timeoutIds)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                clearTimeout(id as any);
            }
        },
        // useConst ensures this will never change, but react-hooks/exhaustive-deps doesn't know that
        [timeoutIds]
    );

    // Return wrapper which will auto cleanup.
    return useConst({
        setTimeout: (func: () => void, duration: number): number => {
            const id = setTimeout(func, duration) as unknown as number;

            timeoutIds[id] = 1;

            return id;
        },

        clearTimeout: (id: number): void => {
            delete timeoutIds[id];
            clearTimeout(id);
        }
    });
};

// another fluentui Gem

export type UseSetIntervalReturnType = {
    setInterval: (callback: () => void, duration: number) => number;
    clearInterval: (id: number) => void;
};

/**
 *  Returns a wrapper function for `setInterval` which automatically handles disposal.
 */
export const useSetInterval = (): UseSetIntervalReturnType => {
    const intervalIds = useConst<Record<number, number>>({});

    useEffect(
        () => () => {
            for (const id of Object.keys(intervalIds)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                clearInterval(id as any);
            }
        },
        // useConst ensures this will never change, but react-hooks/exhaustive-deps doesn't know that
        [intervalIds]
    );

    return useConst({
        setInterval: (func: () => void, duration: number): number => {
            const id = setInterval(func, duration) as unknown as number;

            intervalIds[id] = 1;

            return id;
        },

        clearInterval: (id: number): void => {
            delete intervalIds[id];
            clearInterval(id);
        }
    });
};
