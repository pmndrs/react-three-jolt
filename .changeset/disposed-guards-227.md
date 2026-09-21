---
'@react-three/jolt': patch
'@react-three/jolt-controllers': patch
---

Fixed #227: a `BodyState`, query object or controller kept alive past its `<Physics>` world's
teardown (an uncancelled `setTimeout`, an event handler, a closure captured before unmount) could
reach a Jolt handle that had already been freed. Because jolt-physics' WASM module is a page-wide
singleton with immediate pointer reuse, that landed on *some other* live world's memory instead of
failing cleanly - `RuntimeError: memory access out of bounds` at best, silent corruption of an
unrelated demo at worst.

- `BodyState.dispose()` now nulls its Jolt handles, and every public method/getter/setter checks
  a new `disposed` guard first: in debug mode (`setDebug(true)`) it throws a descriptive `Error`;
  otherwise it is a silent no-op, matching how a shipped build already behaved elsewhere. Fixed a
  real bug this surfaced: `BodySystem.removeBody` read `bodyState.body.GetID()` *after* calling
  `dispose()`, which the new guard would have broken - the id is now captured first.
  `dispose()` also stops tracking any standing `setKinematicTarget`.
- The same guard now covers every public method on `QueryBase`/`CastQueryBase` (`cast`,
  `castFrom`/`castTo`/`castBetween`, `setCollector`, `set`, `initDebugging`) and on
  `ShapeCollider` and `Shapecaster`'s setters - a couple of which (`Shapecaster.setOrigin`/`set
  shape`) would otherwise have double-freed their `RShapeCast` after `destroy()`.
- `CameraRigManager.createRigPoint` and `VehicleSystem.addVehicle` now refuse to create a new
  Jolt body/vehicle once the owner has been destroyed, instead of leaking one nothing will ever
  tear down again.

Also investigated the low-priority `EPhysicsUpdateError` note in #227 (the `debug-wasm-compat`
build logging an error under CubeHeap's 200-body load): `JoltSettings`' defaults
(`mMaxBodies=10240`, `mMaxBodyPairs=65536`, `mMaxContactConstraints=10240`) are already far above
what 200 bodies need, so raising them did not look like the right fix and was left alone - see the
PR description for the full note.
