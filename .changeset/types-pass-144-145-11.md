---
'@react-three/jolt': patch
'@react-three/jolt-addons': patch
'@react-three/jolt-controllers': patch
---

Types only: typed embind helpers, no `@ts-ignore` left, far less `any` (#144, #145, #11).

Nothing changes at runtime for existing code; the declaration output does change, so this is a
patch across all three packages.

- **New, exported from `@react-three/jolt`:** `wrapPointer(ptr, Class)`, `castObject(obj, Class)`
  and `getPointer(obj)` over the emscripten binder, plus the `JoltClass<T>` constructor type.
  Every jolt-physics JS callback receives raw pointers, and these are the documented way to turn
  one back into a wrapper - with the "this is a view Jolt owns, never free it, never retain it"
  rule stated once instead of at sixty call sites (#144).
- **New query types:** `HitCollector` / `JoltHitArray` describe the hit-reading surface every
  Jolt collision collector shares, and `CastSuccessHandler` / `CastFailHandler` replace the
  `any` on `cast()`, `castFrom()`, `castTo()`, `castBetween()` (`Raycaster`, `Shapecaster`,
  `ShapeCollider`, `Multicaster`). The handler types are method-style, so a narrower
  `(hit: RaycastHit) => void` still compiles.
- **Real signatures** for the deprecated `Function` typed listener APIs, for
  `VehicleManager`'s `onPreStep` / `onPostCollide` / `onPostStep` (which now use the exported
  `VehicleStepListener`, #210), for `CharacterControllerSystem.on(action, cb)` (the new
  `CharacterActionName` union, #209), and for `BodySystem`'s deferred actions
  (`PendingActionMap`).
- **`@react-three/jolt-addons`** gains `isCommandVector(value)`, the guard for reading `.x`/`.y`
  off a command value.
- `<RigidBody ref>` is `React.Ref<BodyState | undefined>`, `<Physics module>` is a
  jolt-physics factory, and `<Physics defaultBodySettings>` is the new `DefaultBodySettings`.
  `children` is optional on both, so `createElement(Physics, props, ...children)` typechecks
  the way JSX does.
- Zero `@ts-ignore` remain in `packages/*/src`, `packages/*/test` or `apps/examples/src`;
  `suspicious/noTsIgnore` is now an error, alongside `noDoubleEquals`, `noImplicitAnyLet`,
  `useIterableCallbackReturn` and `noBannedTypes`.
- Each package now type checks its **tests** as well as its sources
  (`tsconfig.test.json`, run by `yarn test` before vitest), so a test cannot drift.

Two latent bugs surfaced and were fixed on the way: a teleporter's `motionAngularVector` was
handed to a quaternion setter as a `Vector3` (producing a `NaN` rotation), and
`<CharacterController>` never assigned its forwarded `ref` nor spread its rest props.
