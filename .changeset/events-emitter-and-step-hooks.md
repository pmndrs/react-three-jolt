---
'@react-three/jolt': minor
'@react-three/jolt-controllers': minor
---

One event primitive, and the physics step hooks (issues #50, #157).

- New `Emitter<M>` in `systems/emitter.ts`: `on(type, fn)` / `once(type, fn)` return an
  unsubscribe closed over the subscription itself, so removal never compares function
  identity. Registering the same function twice now unsubscribes exactly once per `on`,
  which is what makes React StrictMode's mount → cleanup → mount safe. Subscribing or
  unsubscribing from inside a handler is safe, each handler runs in its own `try/catch`
  (an exception unwinding through emscripten's callback glue corrupts the step), and a
  `mask` bitfield backs the zero-cost dispatch path.
- `PhysicsSystem` gains `events`, `onBeforeStep(fn)` and `onAfterStep(fn)`, all returning
  the unsubscribe. `addPreStepListener` / `addPostStepListener` now return one too (was
  `void`, so source compatible) and are deprecated; `removeStepListener(fn)` is deprecated
  and now removes *every* subscription made for that function.
- New `useBeforePhysicsStep(fn)` / `useAfterPhysicsStep(fn)` hooks. The callback lives in
  a ref, so an inline arrow does not resubscribe on every render, and the effect cleanup is
  the unsubscribe handle.
- Step order is now defined as `beforeStep` → pending actions → `Step()` → `afterStep`, per
  substep rather than per frame.
- Controllers: `CharacterControllerSystem`, `CameraRigManager` and `VehicleSystem` keep the
  handle for their step subscription and drop it in `destroy()` / `detachFromLoop()`. All
  four were inline arrows that `removeStepListener` could never match, so a destroyed
  character kept being pre-stepped against a freed `CharacterVirtual` and
  `CameraRigManager.detachFromLoop()` silently did nothing. `CharacterController.on`,
  `CameraRigManager.onCamera` and `VehicleManager.onPreStep/onPostCollide/onPostStep/onAction`
  keep their signatures and are reimplemented on `Emitter`; `VehicleManager` now keeps a
  reference to its `VehicleConstraintStepListener`.
- `CharacterContactListenerJS`: measured against jolt-physics 1.1.0, Jolt invokes six of the
  eleven declared callbacks for a `CharacterVirtual` stepping against bodies
  (`OnAdjustBodyVelocity`, `OnContactValidate`, `OnContactAdded`, `OnContactPersisted`,
  `OnContactRemoved`, `OnContactSolve`). The five character-vs-character no-op assignments
  were dead code — they only fire once a `CharacterVsCharacterCollision` is installed — and
  are removed, with a test that fails if that ever changes.
