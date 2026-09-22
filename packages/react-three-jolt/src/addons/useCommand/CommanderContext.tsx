// `React` is used as a value by the classic JSX transform this package compiles with
// React stays a *value* import: this package compiles JSX with the classic runtime, so the
// emitted `React.createElement` calls need it at runtime (biome's useImportType will offer to
// make it `import type` - don't).
import React, { createContext, useEffect, useState } from 'react';
import { Commander } from './Commander';

/**
 * The commander every `useCommand` in the tree below will use. `null` means "no provider", in
 * which case the hooks fall back to a lazily created, reference counted shared commander.
 */
export const CommanderContext = createContext<Commander | null>(null);

// The commander shared by the hooks that have no provider above them. It is created on first
// use, and it holds nothing (no window listeners, no gamepad poll loop) while no hook is
// retaining it -- see `Commander.retain`. When a fresh set of consumers picks it up again its
// stale commands are dropped, so one screen's bindings never leak into the next.
let fallbackCommander: Commander | null = null;

/** @internal */
export function getFallbackCommander(): Commander {
    if (!fallbackCommander) fallbackCommander = new Commander();
    else if (fallbackCommander.consumerCount === 0) fallbackCommander.clearCommands();
    return fallbackCommander;
}

export type CommanderProviderProps = {
    children?: React.ReactNode;
    /** bring your own commander; otherwise one is created for this provider */
    commander?: Commander;
};

/**
 * Scopes a `Commander` to a subtree (a `<Canvas>`, a `<Physics>` world, a single scene) instead
 * of sharing one for the whole document. The commander is created lazily and destroyed when the
 * provider unmounts.
 */
export function CommanderProvider({ children, commander }: CommanderProviderProps) {
    const [instance] = useState(() => commander ?? new Commander());
    useEffect(() => {
        // the provider itself doesn't retain: the hooks below reference count the connection.
        return () => instance.destroy();
    }, [instance]);
    return <CommanderContext.Provider value={instance}>{children}</CommanderContext.Provider>;
}
