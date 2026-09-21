---
'@react-three/jolt': minor
---

Fix kinematic motion and instanced spawners starting empty (#194).

- `moveKinematic(position, rotation?, deltaTime?)`: `deltaTime` now defaults to the world's step
  length (`physicsSystem.timeStep`, or the new `physicsSystem.lastDelta` when the world steps with
  `timeStep="vary"`) instead of `0`. Jolt derives the body's velocity from
  `(target - current) / deltaTime`, so the old default produced no motion at all. `rotation` is
  optional and defaults to the body's current rotation, rather than straightening it out.
- New `setKinematicTarget(position, rotation?)` / `clearKinematicTarget()`: the target is sticky
  and re-applied at the top of every substep with that substep's real dt, so a platform converges
  on its target however many steps a frame runs, and riders see a steady velocity instead of one
  lurch per frame. Nothing is iterated when no body uses it.
- Riders on a driven platform wake up and are carried with stock body settings (covered by a
  test); raising `friction` above Jolt's slippery default of `0.2` is still worth doing, and is
  now documented on the RigidBody page.
- `<InstancedRigidBodyMesh count={0}>` mounts and grows to N.
