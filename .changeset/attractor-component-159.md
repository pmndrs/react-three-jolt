---
'@react-three/jolt': minor
---

Add `<Attractor>` and `useAttractor()` (#159): a point that pulls - or, with a negative
`strength`, pushes - every dynamic body within `range` of it, with rapier's three falloff
curves (`static`, `linear`, `newtonian`) and its `gravitationalConstant`, so a
`@react-three/rapier` scene ports across unchanged.

- Runs from `useBeforePhysicsStep` (#157), so the force is applied once per physics **substep**
  rather than once per rendered frame. A frame may run zero, one or five substeps, and per
  substep is the only place a force means a fixed amount of momentum.
- Renders a `<group>`, so it can be nested, animated or parented to a moving object: its
  **world** position is what is used, re-read every substep.
- Extra props over rapier's: `enabled`, `mode` (`'force'` - the default and frame rate
  independent - or `'impulse'`, which is what rapier does), `group` / `filter` to restrict which
  bodies are attracted, and `activate` (default on), which wakes sleeping bodies in range. That
  last one matters: Jolt never clears the force accumulated on a sleeping body, so without it an
  attractor's pull would go off all at once whenever something else happened to wake it.
- Zero allocations per step - the body map is walked with a hoisted callback, the parameters
  live in a mutable block rather than in the callback's closure, and the force goes through the
  shared `joltScratch` vector.
