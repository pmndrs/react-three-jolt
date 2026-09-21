import { useCallback, useContext, useEffect, useRef } from 'react';
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

/**
 * A callback with a stable identity that always calls the latest `fn`.
 *
 * Every event subscription in this library is made from an effect whose cleanup is the
 * unsubscribe. If the subscribed function changed identity on every render, that effect would
 * tear down and re-register 60 times a second for an inline arrow. The ref indirection keeps
 * the subscription alive across renders while still calling the freshest closure.
 *
 * `fn` may be undefined, in which case the returned callback is a no-op; callers gate on the
 * prop being present, not on the callback's identity.
 */
// biome-ignore lint/suspicious/noExplicitAny: passthrough wrapper for arbitrary handlers
export function useEventCallback<T extends (...args: any[]) => any>(
    fn: T | undefined
): (...args: Parameters<T>) => ReturnType<T> | undefined {
    const ref = useRef(fn);
    // Written in an effect rather than during render so a concurrent render that is thrown
    // away cannot publish its closure to a live subscription.
    useEffect(() => {
        ref.current = fn;
    }, [fn]);
    // The very first step can happen between render and effect, so seed it synchronously too.
    if (ref.current === undefined) ref.current = fn;
    return useCallback((...args: Parameters<T>) => ref.current?.(...args), []);
}

// helper function for a cleaner useMemo
// this is the r3/rapier version but you can find it here:
//https://github.com/microsoft/fluentui/blob/master/packages/react-hooks/src/useConst.ts
export function useConst<T>(initialValue: T | (() => T)): T {
    const ref = useRef<{ value: T } | undefined>(undefined);
    if (ref.current === undefined) {
        ref.current = {
            value: typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
        };
    }
    return ref.current.value;
}

// also from fluentui
/**
 * @deprecated Issue #57: every component in this library has been converted to a plain
 * `useEffect(() => { ... }, [])` (`RigidBody`, `Physics`, `InstancedRigidBodyMesh` - the
 * conversion the FluentUI-style split into `useMount`/`useUnmount` used to make easier is now
 * done). Kept, unexported from nowhere it wasn't already, for one release for anything external
 * that imported it directly; it will be removed in a future major version. Prefer a plain
 * `useEffect` with an empty dependency array - it is exactly this hook's body, without the extra
 * ref indirection.
 */
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
 * @deprecated Issue #57: prefer `useEffect(() => () => { ... }, [])` - a plain effect whose only
 * job is its cleanup. See {@link useMount}.
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
            // `Object.keys` stringifies the numeric handles it iterates
            for (const id of Object.keys(timeoutIds)) {
                clearTimeout(Number(id));
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
            // `Object.keys` stringifies the numeric handles it iterates
            for (const id of Object.keys(intervalIds)) {
                clearInterval(Number(id));
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
