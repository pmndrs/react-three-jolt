---
'@react-three/jolt': minor
---

Opt-in activation on `BodyState` setters (#167), and an opt-in `matrixAutoUpdate={false}` frame
sync optimisation (#168).

**#167** - `position`, `rotation`, `velocity`, `angularVelocity`, `scale`, `group` and `subGroup`
used to force a sleeping body awake unconditionally. A new `bodyState.activateOnChange` flag
(and `<RigidBody activateOnChange>`) controls that per body, defaulting to `true` - today's
always-wake behavior, so nothing changes for existing code. Turn it off to bulk-reposition
sleeping bodies (e.g. re-laying out sleeping scenery) without waking every one of them. Each
setter also gained a method form taking a one-call `{ activate }` override that wins over the
flag: `setPosition`, `setRotation`, `setVelocity`, `setAngularVelocity`, `setScale`, `setGroup`,
`setSubGroup` (the existing `position =`, `rotation =`, etc. property setters keep working, and
now forward to these with the default activation). A static body never activates regardless of
either flag - activating one asserts inside Jolt and means nothing, since it is never simulated.

- `bodySystem.setBodyCollisionGroup(handle, group?, subGroup?, activate = true)` gained the
  trailing `activate` parameter that `BodyState.group`/`subGroup` now go through.
- `Body.SetLinearVelocity`/`SetAngularVelocity` never woke a sleeping body to begin with (no
  `EActivation` parameter exists on that call); `BodyInterface.SetLinearVelocity`/
  `SetAngularVelocity` always does. Which one gets called is what implements the velocity/
  angularVelocity override.

**#168** - `bodyState.matrixAutoUpdate = false` (and `<RigidBody matrixAutoUpdate={false}>`)
makes the physics frame sync write the body's pose straight into `object.matrix` (and flag
`matrixWorldNeedsUpdate`) instead of `object.position`/`object.quaternion`, and turns off three's
own per-object `Object3D.matrixAutoUpdate` so nothing recomposes the matrix from those a moment
later. `PhysicsSystem.syncBodyToObject` also skips decomposing the already-composed local matrix
back into position/quaternion/scale for this path, since there is nothing left to decompose it
for. Default is unchanged (`true`, three's normal behavior). Only correct when the object's
parent transform is stable between physics steps - the scene root, or a group that never moves,
rotates or scales - the same constraint every synced pose already has via
`BodyState.invertedWorldMatrix`, captured once at body creation.

Measured with 1000 dynamic bodies stepped for 120 frames (`test/matrix-auto-update.test.ts`):
roughly a 4-6% reduction in sync-loop time with `matrixAutoUpdate=false`, dominated by skipping
three's `Object3D.updateMatrix()` and the extra `Matrix4.decompose()` per body. Numbers are
machine dependent; the benchmark logs them rather than asserting on them.
