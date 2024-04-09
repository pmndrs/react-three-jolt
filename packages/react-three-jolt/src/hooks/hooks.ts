import { useContext, useRef } from 'react';
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
            value:
                typeof initialValue === 'function'
                    ? (initialValue as Function)()
                    : initialValue,
        };
    }
    return ref.current.value;
}
