---
'@react-three/jolt': minor
---

Object scaling and `ScaledShape` (#40): a scaled mesh below a described object now produces a
`scaled` descriptor, so the collider matches what is on screen, and `describeShape` takes an
`applyObjectScale` option to bake the root object's scale in too. `BodyState.scale` accepts a
plain number again (`inScale instanceof Number` was always false, so `body.scale = 2` used to
apply a NaN scale), supports non-uniform scale wherever Jolt allows it, and falls back to a
uniform scale with a `devWarn` on shapes that cannot take one (sphere, capsule, tapered capsule).
`<RigidBody scale>` is applied while the body is created rather than a frame later. The
`offsetCenterOfMass` descriptor is implemented via `OffsetCenterOfMassShapeSettings`.
