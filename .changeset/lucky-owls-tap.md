---
'@react-three/jolt-addons': minor
'@react-three/jolt-controllers': patch
---

`useCommand` tears itself down again, and its callbacks are typed.

The `Commander` behind `useCommand` was a module level singleton that attached four
`window` listeners and started a `requestAnimationFrame` gamepad poll the first time any
hook used it. `Commander.destroy()` existed but nothing ever called it, so every listener
and the poll loop outlived every consumer for the lifetime of the page. Commands were also
registered **during render**, which is not something a hook is allowed to do.

- The commander is now reference counted. The first hook to mount connects it, the last one
  to unmount disconnects it: all four window listeners are removed, the gamepad poll is
  stopped, and gamepad.js' own (never removed) `window` `error` listener goes with it.
- `useCommand` registers its command and its listeners in an effect, never in render, so
  Strict Mode's double render cannot double register and changing `commandString`
  re-subscribes without leaking the old listener. The callbacks are read through refs, so
  passing inline arrow functions no longer re-subscribes on every render.
- `Commander` no longer throws when the environment has no gamepad API (SSR, tests,
  browsers without one); gamepad input is simply skipped.
- New `<CommanderProvider>` / `CommanderContext` scope a commander to a subtree — a
  `<Canvas>`, a `<Physics>` world — instead of sharing one per document. Hooks with no
  provider above them keep working against a shared commander that is created lazily and
  holds nothing while no hook is mounted.

Fixed along the way:

- **#78** — `useCommand`'s callbacks were declared as `(info: CommandCallback) => void`, so
  `info` was typed as the callback itself and every `info.isInitial` needed a `@ts-ignore`.
  The payload is now its own exported type, `CommandInfo` (which also carries `startTime`,
  as it always did at runtime).
- `Command.setOptions` indexed by *value* (`this[options[key]] = options[key]`), so
  `setOptions({ sensitivity: 2 })` wrote `command[2]` and never set `sensitivity`.
- `useLookCommand` never removed the `mouseout` listener it adds on mouse down, and closed
  over `isMouseDown` / `origin` from the render that created the effect rather than refs.
- `VectorCommand` merged `options.bindings` into the shared entry of `vectorPresets`,
  mutating the preset for every other command in the process.
- `any` and `Function` are gone from the module: `CommandInfo`, `CommandValue`,
  `CommandOptions`, `CommandEvent`, `CommandState` and `VectorBinding` are exported.

**Breaking:** `useCommand` returns `undefined` on the first render and the `Command` from
the first effect onwards, because the command is no longer created during render. Use the
returned command in an effect or guard it. `Commander.getSnapsot` is deprecated in favour
of the correctly spelled `getSnapshot`.
