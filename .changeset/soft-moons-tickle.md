---
'@react-three/jolt': minor
---

Make frame interpolation real and wire up the `<Physics>` prop surface.

**Interpolation actually interpolates now.** It used to write the previous pose to the
three.js object, lerp a throwaway vector the `BodyState.position` getter had just
allocated, discard the result, and then snap the object to the current pose — three
writes and two allocations per body per frame for the visual result of `interpolate:
false`. Each `BodyState` now carries a preallocated pose cache (`previousPosition` /
`currentPosition` / `previousRotation` / `currentRotation`, filled by `capturePose()`
after every step) and the render frame writes `lerp(previous, current, accumulator /
timeStep)`. The frame loop no longer allocates at all: no merged body array, no scratch
`Matrix4` per instanced body, and the `position` / `rotation` getters (which allocate)
are out of the hot path. Their public behaviour is unchanged.

**`<Physics>` props now reach the system, and stay reactive.** `interpolate` was declared
and then commented out of the destructure, so it never reached `PhysicsSystem`; `timeStep`
did not exist as a prop at all, which made the `"vary"` code path unreachable from React.
Now documented and wired, each with JSDoc:

| prop | default | |
| --- | --- | --- |
| `gravity` | `[0, -9.81, 0]` | number (downward magnitude), tuple or `Vector3` |
| `interpolate` | `true` | |
| `timeStep` | `1 / 60` | seconds, or `"vary"` |
| `maxSubSteps` | `5` | new |
| `paused` | `false` | stops stepping, keeps rendering |
| `updatePriority` | `0` | `useFrame` priority, typed `number` instead of `any` |
| `updateLoop` | `'follow'` | |
| `debug` | `false` | |
| `defaultBodySettings` | — | |
| `defaultShape` | — | new, the Jolt answer to rapier's `colliders` |

**The fixed step accumulator is bounded.** It grew without limit, so one long frame queued
an unbounded number of substeps and each slow frame made the next one slower — the spiral
of death. Time past `maxSubSteps * timeStep` is now dropped, with a warning under `debug`.
Negative and `NaN` frame deltas (r3f's scheduler emits a negative one after a clock reset)
are dropped too rather than poisoning the accumulator.

**`PhysicsSystem.setGravity` no longer leaks** a `Jolt.Vec3` per call, and it accepts
tuples as well as numbers and vectors. New: `PhysicsSystem.accumulator` (read only),
`PhysicsSystem.resetAccumulator()`, `PhysicsSystem.maxSubSteps`, and
`BodySystem.defaultShape`.

Closes #39.
