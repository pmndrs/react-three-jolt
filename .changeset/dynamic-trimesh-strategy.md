---
'@react-three/jolt': minor
---

Dynamic trimesh bodies (#112): Jolt cannot simulate a dynamic body with a `MeshShape` - mesh vs
mesh has no collision, so the body falls through the world and ends up with a `NaN` position. A
`trimesh` on a dynamic body is now converted to a convex hull of the same points, with a
`devWarn`. The new `dynamicMeshStrategy` body option picks the behaviour: `'convex'` (default),
`'error'` to throw, or `'decompose'` (reserved). The mass/inertia override for such a body is
taken from the converted shape's real `GetMassProperties()` instead of a fabricated solid box.
