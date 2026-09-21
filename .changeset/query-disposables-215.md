---
'@react-three/jolt': patch
---

Fixed #215: `physicsSystem.getRaycaster()` / `getAdvancedRaycaster()` / `getMulticaster()` /
`getShapecaster()` / `getShapeCollider()` now register the query object they return with the
world (`registerDisposable`), and the query's own `destroy()` unregisters it again. A query a
caller forgets to `destroy()` is now freed when `<Physics>` unmounts instead of leaking; a query
that *is* explicitly destroyed no longer lingers in the world's disposable set until teardown.
`QueryBase.destroy()` was already idempotent (issue #154) - verified as part of this fix.
