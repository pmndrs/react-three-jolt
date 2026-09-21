---
'@react-three/jolt': patch
---

Allow static bodies to be moved (#61).

`bodyState.position` / `bodyState.rotation` now work on a `type="static"` body: the setters
ask Jolt not to activate it (activating a static body asserts, and means nothing) and register
it with the new `BodySystem.movedStatics` set, which `PhysicsSystem.onUpdate` drains once per
frame so the three.js object picks up the new pose. Scenes whose statics never move pay
nothing - the set stays empty and the drain is skipped.

Moving a static body every frame remains an anti pattern: it teleports, so riders are not
carried and sleeping neighbours are not woken. Use a kinematic body for anything that moves
repeatedly.
