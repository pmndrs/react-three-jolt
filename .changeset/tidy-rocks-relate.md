---
'@react-three/jolt': minor
'@react-three/jolt-addons': minor
'@react-three/jolt-controllers': minor
---

Update to the current React, three.js and Jolt stack.

**Peer dependencies changed.** All three packages now require:

- `@react-three/fiber` `>=10.0.0-0`
- `react` / `react-dom` `>=19.0 <19.3`
- `three` `>=0.185` (new peer — it was always required, it just was not declared)

**jolt-physics 0.22 → 1.1.0** (Jolt C++ v5.6). The parts of the public surface that
moved with it:

- `BodyState.getPosition(true)` returns a `Jolt.RVec3` rather than a `Jolt.Vec3`,
  matching the world space vector type Jolt now uses for every position. In the
  single precision builds these are interchangeable at runtime.
- `vec3.rjolt()` is new: the `RVec3` counterpart of `vec3.jolt()`, for feeding a
  position back into the Jolt API.
- `generateJoltMatrix()` returns an `RMat44`, which is what `CollideShape` and
  `RShapeCast` take.
- `Shapecaster.shapecast` is a `Jolt.RShapeCast`.
- Internally: `Raycaster.cullBackFaces` goes through `RayCastSettings.SetBackFaceMode`
  (the single `mBackFaceMode` field was split in two), `CharacterControllerSystem`
  implements the contact listener callbacks Jolt 0.32 added, and `VehicleManager`
  unwraps the `PhysicsStepListenerContext` that replaced the delta time and physics
  system arguments of the vehicle callbacks in 0.26.

**Also updated:** three 0.186, @react-three/drei 11 alpha, and, for development,
vite 8, vitest 5, rollup 4.63, TypeScript 5.9 and Biome 2.5 in place of ESLint and
Prettier. Node 22 is now the minimum.
