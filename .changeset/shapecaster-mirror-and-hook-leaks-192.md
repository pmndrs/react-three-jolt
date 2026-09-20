---
'@react-three/jolt': patch
---

Closes #192.

**`shapecasters.ts` now mirrors the raycaster fixes from #173/#191/#174.**
`Shapecaster.drawDebuggingLine`/`drawDebuggingPoints`/`drawDebuggingMarkers` allocated a brand new
`THREE.BufferGeometry`/`Material`/`Object3D` on every single call, and `cast()` calls them on every
cast while `isDebugging` is on - so a shapecaster that draws its debug view every physics step grew
`debugObject.children` (and leaked geometries/materials) without bound, same as issue #173 for
raycasters. `drawMarker` also always drew a world-axis-aligned cross regardless of the hit surface,
same as issue #48. Both are fixed the same way: a shared/pooled line, points object and
one-marker-per-hit-index pool (shared ring/normal geometry and materials, updated in place), with
`destroy()`/`clearDebugging()` disposing the pools.

`Shapecaster.destroy()` never `Release()`d its default `activeShape` (one `SphereShape` allocated
per shapecaster), unlike `ShapeCollider.destroy()` after #174. `activeShape` is now correctly
reference counted: the constructor `AddRef()`s the default shape, the `shape` setter `AddRef()`s
whatever it's given and `Release()`s the previous shape, and `destroy()` `Release()`s the current
one instead of leaking it. Along the way, the `shape` setter's `RShapeCast.set_mShape()` call was
found to be dead code - that method doesn't exist on the runtime binding (only a read-only
`mShape` getter does, despite the type declarations) - so setting `shape` after construction never
actually took effect. It now rebuilds the live `RShapeCast` from `activeShape` (preserving the
current cast direction across the rebuild), the same way `setOrigin()` already does for
position/rotation/scale.

**`hooks/use-raycasters.tsx`: `useRaycaster`/`useAdvancedRaycaster`/`useMulticaster` now destroy
the previous instance on every dep change, not just at unmount.** All three build their
raycaster/multicaster inside a bare `useMemo`, so whenever `origin`/`direction`/`type` changed the
memo tore down nothing and built a fresh instance, leaking every raycaster it replaced - only the
very last one was ever freed, by the `useUnmount` at the bottom. Each hook now tracks its previous
instance in a ref and destroys it before building the next one, mirroring `useMouseRaycaster`
(#191). `useAdvancedRaycaster` was additionally missing an unmount cleanup entirely; it now has
one too.

Adds regression coverage: `test/shapecasters.test.ts` gets the marker-orientation and
scene-graph-growth tests ported from `raycasters.test.ts`, plus `destroy()`/shape-refcount tests
(using `test/jolt-alloc.ts`'s `installAllocTracker` and `GetRefCount()`) mirroring
`collider.test.ts`'s coverage of `ShapeCollider`. A new `test/use-raycasters.test.tsx` mounts
`<Physics>` for real via `@react-three/test-renderer`, changes each hook's collector `type` twice,
and asserts the allocation tracker's live count stays exactly at "one instance's worth" measured
up front - not merely "doesn't grow" - across both type changes and after unmount.
