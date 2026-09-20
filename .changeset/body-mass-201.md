---
'@react-three/jolt': patch
---

`BodyState.mass` reports the mass the simulation actually uses (#201).

The getter read the *shape's* density-derived mass, so a body created with a `mass` option - or
scaled afterwards - reported a number unrelated to how it behaved. It now reads
`1 / MotionProperties.GetInverseMass()` for dynamic bodies, and `0` for static and kinematic
ones, which Jolt treats as having infinite mass (setting it on one is a documented no-op rather
than a crash).

The setter uses `MotionProperties.ScaleToMass`, which scales the inertia tensor with the mass and
leaves the body's allowed degrees of freedom alone - the old path pushed a fresh `MassProperties`
through `SetMassProperties(EAllowedDOFs_All, …)` and quietly unlocked every axis the caller had
locked. A mass of `0` or less is refused with a warning instead of producing an infinitely heavy
body.

Body creation applies a `mass` option to **any** dynamic body, by scaling the shape's own mass
properties; it previously only did so for a trimesh that had been converted to a convex hull. The
motion-properties accessors (`linearDamping`, `angularDamping`, `gravityFactor`) are now safe to
touch on a static body.
