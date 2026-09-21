---
'@react-three/jolt': minor
---

Unify shape generation behind one typed descriptor pipeline (issues #107, #151).

`systems/shape-system.ts` had three overlapping entry points -
`getShapeSettingsFromGeometry`, `getShapeSettingsFromObject` and `generateShapeSettings` -
each with their own idea of how a three.js geometry maps onto a Jolt shape. They are now thin
wrappers over a single pipeline:

- `describeShape(object | geometry, options)` -> `ShapeDescriptor`, a plain serialisable
  description (type, size parameters, local position/rotation, children for compounds). It
  allocates nothing on the WASM heap and survives `JSON.stringify`.
- `generateShape(descriptor)` -> `Jolt.Shape`, owned by the caller with a reference count of 1
  and released with `releaseShape`. `createShapeSettings(descriptor)` is available for callers
  that need the settings (compound children, body creation).
- `descriptorKey(descriptor)` / `stableKey(value)` give a descriptor a stable string identity
  (long vertex arrays are hashed), which is what `<Shape>`'s effects now depend on.
- `scaleShape(shape, scale)` wraps a shape in a `ScaledShape` (it AddRef()s the inner shape) and
  hands back one reference, the building block for issue #40.

New: explicit descriptors for tapered capsules, cylinders and **tapered cylinders**
(`TaperedCylinderShapeSettings`, new in jolt-physics 1.1), plus `scaled` and `staticCompound`.
`mutableCompound` (#108) and `offsetCenterOfMass` are reserved in the descriptor union and throw
a clear "not implemented yet" error naming the issue.

Fixes along the way:

- a `ConeGeometry` (three keeps its own `{ radius }` parameters) used to become a NaN sized
  cylinder; it is now inferred as a tapered cylinder.
- cylinders no longer fail to build when they are thinner than the default 0.5 convex radius
  (it is clamped to what Jolt accepts).
- `generateShapeSettings('box')` with no options no longer throws, and a numeric `size` means a
  cube rather than `(size, NaN, NaN)`.
- `<Shape>` rebuilt its shape only when `type` changed (#151) and never released anything:
  changing `size`/`radius`/`height`/`scale`/children now replaces the shape exactly once,
  releases the superseded one, and unmounting releases everything it owns. `updateScaleShape`
  is no longer a `console.warn` stub - it wraps the shape in a `ScaledShape`.
- `BodyState`'s `scale` setter builds its `ScaledShape` through `scaleShape` and releases its own
  reference once the body has taken one.

The old exported names keep working unchanged.
