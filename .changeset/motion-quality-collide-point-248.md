---
'@react-three/jolt': minor
---

Issue #248: two small additions.

- `<RigidBody motionQuality>` (`'discrete' | 'linearCast'`) and the matching
  `BodyState.motionQuality` getter/setter. `'discrete'` (Jolt's default) only tests for
  collisions at the start and end of a step; `'linearCast'` sweeps the body for the step
  instead, so a small, fast body doesn't tunnel through thin geometry. Reactive, like
  `gravityFactor`.
- A `CollidePoint` narrow-phase query: `PointCollider` (`physicsSystem.getPointCollider()`),
  mirroring `ShapeCollider`, plus a `useCollidePoint(point?, type?)` hook - the first hook
  wrapper for one of the `QueryBase`-direct query types. Answers "which bodies contain this
  point right now".
