---
'@react-three/jolt': patch
---

Stop the shape system leaking WASM memory.

Jolt's list containers copy the value passed to `push_back`, so the `Vec3`/`Float3`/
`IndexedTriangle` created for every point, vertex and triangle was leaked - along with the lists
themselves, the `PhysicsMaterial`, and the `ShapeSettings` that were never destroyed after
`Create()`. Building a mesh collider from a 2k-triangle sphere left 3078 live Jolt objects behind;
it now leaves none.

- `getShapeSettingsFromGeometry`, `generateShapeSettings` and `getShapeSettingsFromObject` reuse a
  single scratch object per loop and free every temporary, including the single-shape early return.
- New `createShapeFromSettings(settings)` / `releaseShape(shape)` helpers realise a shape, take a
  reference on it, free the settings and report `Create()` errors as a thrown error instead of
  handing back an invalid shape. `BodySystem.addHeightfield` and `generateBodySettings` use them,
  so a body now owns its shape and frees it when the body is destroyed.
- `createMeshForShape` and `createMeshFromShape` were byte-identical copies of each other; there is
  now one implementation and both names still work.
