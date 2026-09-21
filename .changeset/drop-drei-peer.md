---
'@react-three/jolt': minor
'@react-three/jolt-addons': minor
'@react-three/jolt-controllers': minor
---

Drop `@react-three/drei` as a peer dependency, and widen the `react`/`react-dom` peer range.

drei was required by both `@react-three/jolt` and `@react-three/jolt-addons`, for two things:

- `<Heightfield>` used drei's `useTexture` to load the display texture. `useTexture` is part of
  `@react-three/fiber` as of v10, so it now comes from there. Same behaviour, one fewer install.
- `useGamepadForCameraControls` imported drei's `CameraControls` purely as a type, for a
  parameter it only ever calls `.rotate()` on. That parameter is now typed as the structural
  `CameraControlsLike`, which drei's `CameraControls` satisfies unchanged — and so does any
  other controls implementation exposing the same method.

Nothing needs to change in your code. If you installed drei only because `@react-three/jolt`
asked for it, you can drop it.

The `react`/`react-dom` peer range goes from `>=19.0 <19.3` to `>=19.0.0`. The upper bound was
mirroring the range r3f 10 accepts, but pinning it here means a React minor breaks installs
against this package rather than against the one that actually cares.
