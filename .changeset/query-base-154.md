---
'@react-three/jolt': patch
---

Extract a shared `QueryBase`/`CastQueryBase`/`HitBase` (new `systems/queries/query-base.ts`) out
of `Raycaster`, `AdvancedRaycaster`, `Multicaster`, `Shapecaster` and `ShapeCollider` (issue #154).
`Shapecaster` duplicated ~90% of `Raycaster`, most visibly a byte-identical ~230-line
debug-drawing block, so a fix applied to one (e.g. #141/#173/#192) had to be hand-ported to the
other and was easy to miss.

- `QueryBase` owns the `joltPhysicsSystem`/`joltInterface`/`bodyInterface` wiring, the four
  filters (`bpFilter`/`objectFilter`/`bodyFilter`/`shapeFilter`) with their creation/destroy, and
  an idempotent `destroy()` template (`releaseResources()` hook) - `Raycaster`, `Shapecaster` and
  `ShapeCollider` no longer duplicate this, and `Multicaster`'s `destroy()` is now idempotent too
  (it previously had no guard against being called twice, which would have double-freed its owned
  `Raycaster`'s allocations).
- `CastQueryBase` (extends `QueryBase`) adds what only the ray-like casters share: the collector
  lifecycle (`setCollector()`), the `cast()`/`castFrom()`/`castTo()`/`castBetween()` family, and
  the debug-drawing resource pool (`isDebugging`, `debugObject`, `drawDebuggingLine/Points/
  Markers`, `drawMarker`, `clearDebugging`). `Raycaster` and `Shapecaster` extend it directly;
  `AdvancedRaycaster` extends `Raycaster`.
- `HitBase` is shared by `RaycastHit` and `ShapecastHit`: the `distance`/`normal`/`direction`
  getters and the `impactNormal` reader (BodyID/SubShapeID allocation + destroy, and the
  never-destroy-the-static-normal rule for `GetWorldSpaceSurfaceNormal`'s by-value return) were
  byte-identical between the two and are now written once.

No public property, method or constructor signature changed. `net -346` lines across
`raycasters.ts`/`shapecasters.ts`/`collider.ts`/`index.ts` even after adding the new shared
`query-base.ts` file (1735 -> 1389 total). All existing raycaster/shapecaster/collider/hook tests
pass unchanged; added `test/query-base.test.ts` asserting every concrete class' `destroy()`
returns the jolt allocation tracker to baseline (and is idempotent) and that toggling
`isDebugging` on `Raycaster`/`Shapecaster` creates and disposes exactly the pooled three.js debug
resources.
