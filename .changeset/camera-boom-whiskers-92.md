---
'@react-three/jolt-controllers': minor
---

Camera boom whiskers (#92).

The boom already shape-cast backwards and pulled the camera in when a wall got between it and the
player, which reads as a snap. With `whiskers` on it now also fans short rays out either side of
the boom every step and rotates the yaw away from whatever they touch, so the camera slides around
a corner before the wall ever becomes a problem - the "ray base whiskers" trick from the issue.

```tsx
<CameraRig whiskers whiskerLength={3} whiskerStrength={2} />
```

Configurable through `whiskerCount` (default 5), `whiskerSpread` (default ±60°), `whiskerLength`,
`whiskerStrength` and `whiskerDamping`; `isWhiskerSteering` says whether anything is currently in
the way. The steering rate is spring damped, so it eases in and decays back to zero once the
whiskers come clear.

The whisker raycaster is built lazily the first time whiskers are switched on, is freed by
`destroy()` along with the boom's other queries, and the per-step sweep is allocation free on both
sides of the wasm boundary: the fan's sin/cos are precomputed, the vectors are reused, and each
cast writes into the raycaster's own `RRayCast` and reads the hit fraction straight off its
collector instead of building a `RaycastHit` per whisker per frame.
