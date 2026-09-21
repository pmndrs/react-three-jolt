---
'@react-three/jolt': minor
'@react-three/jolt-controllers': patch
---

#28: `PhysicsSystem.physicsSystem` - the raw Jolt `Jolt.PhysicsSystem` handle - is renamed to
`PhysicsSystem.joltPhysicsSystem`. The old name was ambiguous: every other class's `physicsSystem`
field holds *this* wrapper (our `PhysicsSystem`, e.g. `ConstraintSystem.physicsSystem`,
`DebugRenderer`'s field, `useJolt()`'s `physicsSystem`), so a field of the same name on
`PhysicsSystem` itself that instead held the raw Jolt object was the one place the name lied.

`PhysicsSystem.physicsSystem` still works for one release as a deprecated getter that forwards to
`joltPhysicsSystem` and warns once via `devWarn` (visible with `setDebug(true)`, silent otherwise,
matching this library's other deprecation warnings).

`ShapeSystem`'s raw-Jolt field had the same ambiguity (it wasn't itself named `ShapeSystem`, but
its type was the raw `Jolt.PhysicsSystem` under the wrapper's name) and is renamed the same way,
with no deprecated alias since it isn't part of the documented public API surface. Every internal
call site - `constraint-system.ts`, `@react-three/jolt-controllers`' `character-controller.ts` and
`vehicle-manager.ts` (which reached the raw system through `this.physicsSystem.physicsSystem`) -
now reads `joltPhysicsSystem` directly instead of chaining through the deprecated getter.
