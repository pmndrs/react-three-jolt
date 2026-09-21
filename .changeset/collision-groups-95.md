---
'@react-three/jolt': minor
---

Per-body collision groups, changeable at runtime (issue #95).

`BodySystem.standardCollisionGroup` was a single shared `Jolt.CollisionGroup` handed to every
body that asked for one, and the `BodyState` group setters were stubbed out on the belief that
`SetCollisionGroup` wasn't exposed to JS. jolt-physics 1.1.0 has
`BodyInterface.SetCollisionGroup(BodyID, CollisionGroup)`, so:

- Every grouped body now owns its own `CollisionGroup`, created in `createBody` (or lazily by
  the setters for a body that didn't ask for a group up front) and destroyed in `removeBody`.
- `BodyState.group` / `BodyState.subGroup` (and the new `collisionGroup` / `collisionSubGroup`
  aliases) are live: the setters push the group through `BodyInterface.SetCollisionGroup` and
  wake the body, so they take effect on the next step instead of only at body creation.
- `<RigidBody group subGroup>` are reactive, and `group={0}` / `subGroup={0}` are no longer
  swallowed by a truthy check.
- The hand-rolled `GroupFilterJS` is replaced by a `GroupFilterTable`, exposed through
  `bodySystem.setGroupCollision(a, b, enabled)` / `disableCollision(a, b)` /
  `enableCollision(a, b)` / `isCollisionEnabled(a, b)`. Sub group ids are range checked against
  `bodySystem.subGroupCount` (default 256); the old filter indexed a fixed 3-element array with
  arbitrary user ids, and Jolt itself only bounds checks the table with an assert that is
  compiled out of the release wasm.
- New `BodySystem.destroy()` frees the collision groups and releases the filter table.

Collision groups are the "this specific pair of objects shouldn't collide" filter; object
layers remain the broad category filter and are unchanged. **Breaking:** the previous
hard-coded sub group 0/1/2 semantics are gone — a group's sub groups all collide until you call
`disableCollision`. See the rewritten Group Filtering section of the README.
