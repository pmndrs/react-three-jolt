---
'@react-three/jolt': patch
---

Wire up `<RigidBody friction>` and friends (#198).

`friction` was declared in `RigidBodyProps` and read by nothing. It, `restitution` and
`gravityFactor` (both new props) now go through the same reactive effect as `mass` and the
damping props, with JSDoc for each default.

Two related fixes in the same effect: it is keyed on the body instance rather than on a
non-reactive ref, so these properties also reach a body that is created later because it has
`<Shape>` children; and it tests `!== undefined` instead of truthiness, so `friction={0}` and
`gravityFactor={0}` are no longer read as "unset".
