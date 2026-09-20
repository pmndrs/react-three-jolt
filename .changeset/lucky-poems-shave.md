---
'@react-three/jolt': patch
'@react-three/jolt-controllers': patch
---

Fix the `vec3` / `quat` conversion helpers handing back the caller's own Jolt object (issue #76).

`vec3.jolt()`, `vec3.rjolt()` and `quat.jolt()` returned their argument unchanged when it already
was a Jolt object, so the ~14 call sites that destroyed the result were freeing memory Jolt (or
the caller) still owned - a use after free that surfaced as unrelated out of bounds errors much
later. They now always return a new object the caller owns, and the ownership rules are documented
on each helper.

Also in this change:

- `vec3.jolt(0, 1, 2)` returns `(0, 1, 2)`; a zero first component no longer reads as "no
  argument" (the same bug was in `vec3.rjolt()` and `vec3.three()`).
- `quat.jolt(undefined)` returns the identity rotation instead of throwing.
- New `withJolt()` / `withRJolt()` / `withQuat()` scoped helpers that construct, call and destroy,
  and a `joltScratch` shared scratch object for per-frame code that passes a vector to a Jolt API
  which copies it.
- The `BodyState` setters (`position`, `rotation`, `velocity`, `angularVelocity`, `applyForce`,
  `applyTorque`, `addImpulse`, `moveKinematic`), the `CharacterControllerSystem` setters and
  `generateJoltMatrix()` no longer allocate on the WASM heap at all.
- `generateJoltMatrix()` returns a real `RMat44` copy. The WebIDL binder returns a pointer to a
  single static temporary from "by value" returns, so the matrix used to be silently rewritten by
  the next caller, and destroying it freed memory the binder owns.
- Leaks fixed at the call sites: `PhysicsSystem.setGravity()`, `ShapeCollider.setJoltMatrix()`
  (one transform per frame), `RaycastHit`/`ShapecastHit.impactNormal`, the hinge constraint axes,
  `SetMassAndInertiaOfSolidBox` for dynamic trimeshes, `VehicleManager.setPosition()` and the two
  wheel vehicle's wheel position.
