---
'@react-three/jolt': minor
'@react-three/jolt-controllers': patch
---

Real `PhysicsSystem.destroy()` teardown, unlimited concurrent worlds, and a deliberate shape for
the module singleton (issues #162, #176, #35).

**`PhysicsSystem.destroy()` now walks the world** instead of freeing the `JoltInterface` and
stopping. In order: registered disposables → constraints → bodies → event subscriptions →
the `JoltInterface` → the Jolt listener objects (`bodySystem.destroy()`) → the shared
`joltScratch` vectors, but only when the last world on the module is going. It is idempotent and
every wasm-facing method checks `destroyed` first, so a second `destroy()`, a late frame callback
or a `gravity` effect that fires after unmount are all no-ops rather than wasm traps.

**`<Physics>` defers that teardown past the React commit.** React runs a parent's effect cleanup
*before* its children's, so `<Physics>` used to free the world out from under every
`<RigidBody>`, `useConstraint` and controller below it - each of those then cleaned up against a
dead world and simply skipped its `destroy()`, leaking everything it owned. The unmount cleanup
now schedules the real teardown on a microtask, guarded against a remount (StrictMode) putting a
world back in the meantime, so children tear themselves down first against a live world.

**The three-world cap is gone.** Every `PhysicsSystem` owns exactly one `JoltInterface` and frees
its registry slot in `destroy()`. Mounting a fourth `<Physics>` used to silently hand it the
*first* world's interface, so two components shared bodies without either knowing, and the
loser's filter tables were orphaned. Worlds are still not free - each costs about 20MB of the
jolt-physics build's fixed 128MB heap, so roughly six fit at once - so the constructor now checks
the remaining heap and throws an actionable error instead of letting emscripten `abort(OOM)` kill
the module for the rest of the page.

**New API**

- `PhysicsSystem.registerDisposable(fn | { destroy() })` ties an object's lifetime to the world
  and returns an unregister. `CharacterControllerSystem`, `CameraRigManager` and `VehicleSystem`
  register themselves, so a world that goes away takes them with it even when nothing unmounted
  the component that made them.
- `PhysicsSystem.interfaceId` / `destroyed` / `disposableCount`.
- `JoltModule` (the old `Raw`, renamed per #35 - `Raw` is still exported as an alias of the same
  object, so `Raw.module` keeps working), plus `getJoltModule()` and `free()` exported from the
  index.
- `JoltModule.registerInterface` / `getInterface(id)` / `releaseInterface(id)` / `interfaceCount`
  replace `Raw.joltInterfaces`, which was keyed by the owning component's React `useId()` and so
  grew a new entry on every remount. Ids come from a counter that only goes up and are never
  reused.
- `BodySystem.removeAllBodies()`.
- `deferWorldDestroy` / `flushDeferredWorldDestroys` for anything driving worlds outside React.

**Breaking:** `Raw.joltInterfaces` and `PhysicsSystem.maxInterfaces` are gone; nothing in the
library read them from outside `physics-system.ts`. `PhysicsSystem`'s constructor argument is now
a debug label only (it used to be the interface cache key) and `destroy()`'s argument is ignored,
so `new PhysicsSystem(pid)` / `destroy(pid)` still compile and do the right thing.

**Also fixed**

- `NUM_OBJECT_LAYERS` was 3 while `Layer` had four members, so
  `MapObjectToBroadPhaseLayer(Layer.RIG, ...)` wrote past the end of a three element array and the
  pair filter's bit indices aliased unrelated layer pairs. It is now derived from `Layer` itself,
  and `Layer.KINEMATIC` is explicitly mapped (issue #95).
- `Shapecaster` never freed its default `SphereShape`: `RShapeCast` stores a raw pointer to the
  shape rather than a `RefConst`, so nothing else was ever going to. It now takes a reference in
  the constructor and releases it in `destroy()`, the same way `ShapeCollider` does.
