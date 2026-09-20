---
'@react-three/jolt': minor
---

Closes #48 and #47.

**#48 - debug markers now orient along the hit surface normal.** `Raycaster.drawMarker()`
previously always drew a world-axis-aligned cross regardless of what it hit
(`// TODO: Apply the normal`). It now draws a small ring/disc plus a normal-indicator line,
oriented with `Quaternion.setFromUnitVectors((0, 1, 0), hit.impactNormal)`.

Along the way, fixed the three.js side of the leak issue #173 reported:
`drawDebuggingLine`/`drawDebuggingPoints`/`drawDebuggingMarkers` allocated a brand new
`THREE.BufferGeometry`/`Material`/`Object3D` on **every single call**, and `cast()` calls them on
every cast while `isDebugging` is on - so a raycaster that draws its debug view every physics step
grew `debugObject.children` (and leaked geometries/materials) without bound. All three are now
pooled per raycaster: one shared material per debug-drawing type, geometry reused via
`setFromPoints`/`setAttribute`, and markers pooled one-per-hit-index so repeated `drawMarker()`
calls (the common case) update an existing group's transform instead of allocating anything.
`destroy()` and `clearDebugging()` dispose the pools.

**#47 - `useMouseRaycaster(options)`.** New hook in `hooks/use-raycasters.tsx`: builds a
world-space ray from the pointer and camera (via `useThree`) every frame (default) or on real
`pointermove` events (`mode: 'pointermove'`), runs a `Raycaster` (`'closest'` by default) against
it, and returns `{ raycaster, hit }` where `hit` is a mutable ref updated in place - no React
state churn on every frame/pointer move. Supports an `onHit` callback, a `type` collector
override, a `length` override (defaults to `camera.far`), and a `filter` option to swap in custom
`bpFilter`/`objectFilter`/`bodyFilter`/`shapeFilter` instances. Destroys its raycaster on unmount
and whenever `type`/`filter` change (not just at unmount, unlike the sibling `useRaycaster`/
`useAdvancedRaycaster`/`useMulticaster` hooks, which still only free their raycaster at unmount).

Adds regression coverage to `test/raycasters.test.ts` (marker orientation against a tilted box,
and that repeated `drawMarker`/`cast()` calls don't grow `debugObject.children` or reallocate
geometry) and a new `test/use-mouse-raycaster.test.tsx` that mounts `<Physics>` for real via
`@react-three/test-renderer` and asserts a hit against a body centered under the pointer.
