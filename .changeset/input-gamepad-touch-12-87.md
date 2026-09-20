---
'@react-three/jolt-addons': minor
'@react-three/jolt': patch
---

Drop the `gamepad.js` dependency and give `useLookCommand` touch and gamepad support
(closes #12, closes #87).

**`gamepad.js` is gone (#12).** `Commander` now polls gamepads through a small in-house
`GamepadPoller` (`useCommand/gamepad.ts`):

- `navigator.getGamepads()` is diffed inside a `requestAnimationFrame` loop that only runs
  while at least one consumer retains the commander (the existing `retain`/`release`
  refcount), and is cancelled when the last one lets go.
- Button and axis events keep the payload `gamepad.js` used to emit
  (`{ type: 'gamepad:button' | 'gamepad:axis', detail: { index, button | axis, value, pressed } }`),
  so `GamepadInputEvent` and anything written against it is unchanged. The button detail
  gained an additive optional `name` field (the W3C standard-mapping name, e.g. `A` or
  `DPadUp`, which is the mapping `commonCommands` binds its indices against); the new
  `standardGamepadButtons` / `gamepadButtonName` / `standardGamepadSticks` helpers are
  exported.
- `gamepadconnected` / `gamepaddisconnected` window events are handled, several gamepads are
  tracked by index, and a disconnect releases whatever that pad was holding so a yanked
  controller can't leave a command stuck down.
- Configurable `deadzone` (default `0.15`) and per-axis / per-button change thresholds, via
  `new Commander({ gamepad: { deadzone, axisThreshold } })`.
- Environments without the Gamepad API (node, SSR) are a silent no-op instead of a throw,
  and the poller removes every listener it adds — `gamepad.js` used to leave a `window`
  `error` listener behind permanently.
- `gamepad.js` is removed from `@react-three/jolt-addons`' dependencies, and from
  `@react-three/jolt`'s, where it was declared but never imported. The unused
  `packages/react-three-jolt/types/gamepad.js.d.ts` declaration file is deleted.

**`useLookCommand` takes touch and gamepad input (#87).** In addition to the existing
mouse/pointer-lock path it now supports a one-finger touch drag (pointer events filtered on
`pointerType === 'touch'`, multi-touch pinches ignored, `touch-action: none` set on the
target element while mounted and restored on cleanup) and a gamepad stick sampled per frame
and scaled by the frame delta. New options:

```ts
useLookCommand(onLook, onZoom, {
    mouse: true,
    touch: true,
    gamepad: { stick: 'right', deadzone: 0.15 }, // or true / false
    sensitivity: { mouse: 1, touch: 1, gamepad: 200 },
    invertY: false
});
```

All three sources are on by default, each is registered in its own effect with a full
cleanup, and the wheel/zoom listener is now independent of the mouse-look option.

**Two fixes to the input rewrite that landed in #177:**

- `vectorPresets.look` names its vertical directions `up`/`down`, but `VectorCommand` only
  mapped `forward`/`backward` onto `y`, so the whole `look` preset drove yaw with its pitch
  bindings.
- `Commander.updateState` never removed a command that went inactive from the state, so
  `useCommandState` consumers kept acting on an input nobody was giving any more.
