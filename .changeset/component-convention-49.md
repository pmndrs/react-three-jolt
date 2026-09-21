---
'@react-three/jolt': patch
'@react-three/jolt-controllers': patch
---

React 19 component convention (issue #49): every exported component is now a plain function
component with `ref` as an ordinary, typed prop - no `forwardRef`, no `React.FC`/`FC<Props>`
annotation. Runtime behavior, every prop and every existing `ref` usage are unchanged; this is a
structural cleanup, not a new feature.

- `RigidBody`, `Shape` (and the collider components built on it - `CuboidCollider`,
  `BallCollider`, `CapsuleCollider`, `CylinderCollider`, `ConeCollider`, `ConvexHullCollider`,
  `TrimeshCollider`, `HeightfieldCollider`) drop the `forwardRef` wrapper their `ref` prop no
  longer needed.
- `CharacterController` and `CameraRig` (`@react-three/jolt-controllers`) do the same; `ref` is
  now documented on `CControllerProps`/`CameraRigProps` instead of only working at runtime.
- `Physics`, `Debug`, `Attractor`, `InstancedRigidBodyMesh` drop their `React.FC`/`FC<Props>`
  type annotations in favor of a typed props parameter.
- See the new "Component convention" section in `DEVELOPMENT.md` for the convention itself.
