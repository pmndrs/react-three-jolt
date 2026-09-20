---
'@react-three/jolt': minor
---

Named collider components and `<RigidBody colliders>` (issue #155).

Eight thin, typed wrappers over `<Shape>` — `<CuboidCollider>`, `<BallCollider>`,
`<CapsuleCollider>`, `<CylinderCollider>`, `<ConeCollider>`, `<ConvexHullCollider>`,
`<TrimeshCollider>` and `<HeightfieldCollider>` — each with a rapier-compatible `args` tuple.
`args` are **half extents** (`<CuboidCollider args={[0.5, 0.5, 0.5]}>` is a 1×1×1 cube, the
capsule/cylinder/cone take a half height); `<Shape>`'s own props keep three.js semantics and the
conversion lives only in the wrappers. Jolt has no cone shape, so `<ConeCollider>` is a
`taperedCylinder` with a top radius of zero. `<HeightfieldCollider args={[samples, size, scale]}>`
needed a descriptor path from raw samples, so `ShapeOptions` gained
`heights`/`sampleCount`/`heightScale`/`materials`/`materialIndices`.

`<RigidBody colliders>` takes `false` (no automatic shape; the meshes are decoration and the
colliders are the body) or `'cuboid' | 'ball' | 'hull' | 'trimesh'` — rapier's spelling of this
library's `AutoShape` names — and defaults to today's autodetection. A body with both meshes and
colliders combines them into one compound, meshes first.

To make that work, `<RigidBody>` is now a compound *host*: when it has to combine several shapes
(sibling colliders, an offset collider, or a collider beside a mesh) its children register plain
`ShapeDescriptor`s with it and it composes and owns the compound, instead of every child calling
`setActiveShape` and the last one silently winning. When there is nothing to combine — one
`<Shape>`, or meshes only — nothing changes and the child still owns the body's shape, which is
what keeps a `<Shape dynamic>` directly under a body editable in place (#108). A lone collider
with a `position`/`rotation` now becomes a one-child compound, so its offset is honoured rather
than dropped as a root transform.

`sensor`, `friction` and `restitution` on a collider are body-level properties in Jolt and say so
out loud. Jolt's sensor flag is `Body::SetIsSensor`, with no per-sub-shape equivalent: a body
whose colliders *all* ask for `sensor` (and whose meshes contribute nothing solid) is made a
sensor with a warning, and a mix of sensor and solid colliders throws with a message naming the
counts. `friction`/`restitution` warn and are written to the body; `<RigidBody friction>` wins
when both are set.

New docs page `docs/api/colliders.mdx`, linked from the RigidBody page.
