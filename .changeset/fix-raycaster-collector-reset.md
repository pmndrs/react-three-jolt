---
'@react-three/jolt': patch
---

Fix `Raycaster`/`AdvancedRaycaster` collector lifecycle and memory bugs in
`systems/queries/raycasters.ts`:

- A `Raycaster` in the default `"closest"` mode never reset its collector between
  casts, so after the first hit `HadHit()`/`mHit` and the collector's early-out
  fraction stayed put and every later `cast()` silently returned the stale first
  hit instead of re-querying. This was the root cause of the "Raycaster Many" demo
  (issue #60) showing rays offset/stuck relative to the geometry they were meant
  to be hitting; `Shapecaster` already reset unconditionally and is now matched.
- `AdvancedRaycaster` built a raw `CastRayCollectorJS()` without installing
  `Reset`/`OnBody`/`AddHit` as the instance's own properties, so jolt-physics threw
  `"a JSImplementation must implement all functions"` the first time it was cast
  (or reset) before `onBody()`/`addHit()`/`onReset()` had been called. It also
  leaked the base class's native collector when swapping it out, and its
  `cast()` reset the collector *after* the raw cast instead of before, wiping out
  the very hits it had just collected.
- `RaycastHit.impactNormal` leaked a `BodyID`, `SubShapeID` and `RVec3` on every
  single call (the `destroy()` calls were commented out) - now fixed. It also
  no longer calls `destroy()` on the `Vec3` returned by
  `GetWorldSpaceSurfaceNormal()`, since jolt-physics' WebIDL binder returns that
  by value as a pointer to a shared static temporary, not a fresh allocation -
  freeing it would corrupt state shared by every other caller of that binding.
  The same reasoning applies to `RaycastHit`'s existing (pre-existing, unchanged
  in behavior) handling of `GetPointOnRay()`'s return value, which is now also
  left un-freed with an explanatory comment instead of being incorrectly
  destroyed.
- `Multicaster` had no `destroy()` at all, leaking the `Raycaster` (and its ray,
  settings, filters and collector) it owns; it also appended to `results`
  forever without ever clearing it. Both are fixed.
