---
'@react-three/jolt': patch
---

Public API surface cleanup (issue #148):

- `Vector4Tuple` is now a strict `[number, number, number, number]` tuple. It used to be
  `[number, number, number, number] | number[]`, which defeated the tuple entirely - any
  `number[]`, including one of the wrong length, satisfied it.
- `RigidBodyProps.key?: number` is removed - it shadowed React's own reserved `key` and was never
  read by the component.
- `RigidBodyProps` now extends `ThreeElements['object3D']` (minus the props it gives its own
  meaning to: `position`/`rotation`/`scale`/`quaternion`, applied to the physics body rather than
  passed through, plus `ref`/`children`), so ordinary object3D props (`visible`, `castShadow`,
  `userData`, event handlers, ...) - already spread onto the rendered `<object3D>` at runtime -
  now typecheck too.
- `RigidBodyContext`/`ShapeContext` no longer name both a type and a value. The types keep their
  names; the context values are `rigidBodyContext` and `shapeContext` (lowercase). `Shape.tsx`'s
  `ShapeContextValue` alias - a workaround for the old collision - is deprecated in favor of the
  now-unambiguous `ShapeContext` type, and kept for one release.
- `MeshFloor` has a real `MeshFloorProps` interface (it was an untyped `{ size, position, ...rest
  }` destructure) and its mount effect now has an unmount cleanup that removes the Jolt body it
  creates - it used to outlive the component for the life of the physics world.
- `FrameStepper` (an internal implementation detail of `<Physics>`, never documented) is marked
  `@internal`.
