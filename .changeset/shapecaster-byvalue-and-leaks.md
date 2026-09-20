---
'@react-three/jolt': patch
---

Fix the two memory bugs in `systems/queries/shapecasters.ts` that the matching
raycaster fixes never reached, because nothing in that change set touched this
sibling file:

- `ShapecastHit`'s constructor called `destroy()` on the value returned by
  `RShapeCast.GetPointOnRay()`. That is a BY VALUE return: jolt-physics' WebIDL
  binder hands back a pointer to one static temporary per bound function, shared
  across every shapecast and overwritten on the next call. Freeing it returns
  the binder's own memory to the allocator, which reuses it immediately, so the
  corruption surfaces later and somewhere else entirely. `vec3.three()` already
  copies the components out, so there is nothing to free.
- `ShapecastHit.impactNormal` allocated a `BodyID`, a `SubShapeID` and an
  `RVec3` on every read and freed none of them (the `destroy()` calls were
  commented out). It is read per hit, per frame, by the camera rig. The `Vec3`
  from `GetWorldSpaceSurfaceNormal()` is deliberately still not freed - it is
  the same kind of by-value static temporary.

Adds `test/shapecasters.test.ts`, which casts against the real WASM module and
asserts the net Jolt allocation count is flat across 100 casts. Its spy
discovers every embind constructor on the module at runtime, so it covers
`BodyID`/`SubShapeID` as well as the value types, and it catches the double free
(count drifts negative) as well as the leak (count grows).
