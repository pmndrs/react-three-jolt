---
'@react-three/jolt': patch
---

Fix `ShapeCollider` leaking every Jolt object it creates (issue #142).

`ShapeCollider.destroy()` was a no-op, leaking its collector, `CollideShapeSettings`, body/shape/
broad-phase/object-layer filters, base offset `RVec3` and transform `RMat44` for the lifetime of
the app. Worse, `setJoltMatrix()` replaced the transform every time `position`/`rotation`/`matrix`
was set without freeing the previous one - `CameraBoom.checkCollision` does this every frame, so a
long camera-collision session leaked one `RMat44` per frame.

- `destroy()` now frees every Jolt object the collider owns, is idempotent (safe to call more than
  once), and nulls out its references afterwards.
- `setJoltMatrix()` mutates one `RMat44` (and two scratch `RVec3`/`Quat` objects) in place for the
  collider's whole lifetime instead of allocating a new transform per call - zero WASM allocations
  per frame.
- `activeShape` is now correctly reference counted: the `shape` setter and constructor `AddRef()`
  whatever shape they're holding and `Release()` the previous one, and `destroy()` releases the
  current shape instead of hard-destroying it, so a caller that also holds (and later frees) a
  reference to the same shape doesn't end up with a dangling pointer.
