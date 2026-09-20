---
'@react-three/jolt': patch
---

Fix constraint cleanup so constraints are actually removed and freed (#82).

`ConstraintSystem.removeConstraint()` was an empty function with its body commented out, and
it is `useConstraint`'s entire cleanup path — so every constraint ever created stayed in the
physics system for the lifetime of the world. It is now implemented, along with the
lifetime rules that made the earlier attempts crash:

- constraints are reference counted. `RemoveConstraint` plus `Release()` frees one;
  `Raw.module.destroy()` on a constraint is a double free and traps in wasm.
- a constraint must be removed **before** either of its bodies. `BodySystem.removeBody()`
  now removes the constraints attached to a body first, so removing a constrained body no
  longer crashes the next step.
- `<Physics>` unmounting frees the JoltInterface before its children clean up (React tears
  a parent down first), so `PhysicsSystem` exposes a `destroyed` flag and the constraint
  cleanup skips jolt once the world is gone.

Also in this pass:

- `ConstraintSystem` keeps a registry of live constraints (`constraintSystem.constraints`),
  and gains `removeConstraintsForBody()` and `removeAllConstraints()`.
- every `*ConstraintSettings`, `SpringSettings`, `MotorSettings` and `Vec3`/`RVec3`
  temporary is now freed after the constraint is created (previously ~12 leaked wasm
  objects per constraint).
- `createMotorSettings()` referenced undeclared variables and threw a `ReferenceError` if
  called. It now takes typed options and sets the real jolt 1.1 fields
  (`mMinForceLimit`/`mMaxForceLimit`/`mMinTorqueLimit`/`mMaxTorqueLimit`/`mSpringSettings`).
- hinge motors called `SetTargetVelocity`/`SetTargetPosition`, which do not exist on
  `HingeConstraint`; they now use `SetTargetAngularVelocity`/`SetTargetAngle`.
- `swingTwist` without an explicit position no longer throws (`new body.GetPosition()`),
  and `getEaxis` no longer falls through returning `undefined`.
- `addConstraint`, `useConstraint` and the constraint options are now typed
  (`ConstraintType`, `ConstraintOptions`, `ConstraintTypeMap`) with no `@ts-ignore` left in
  either file, and `useConstraint` re-creates its constraint when the type, bodies or
  option values change.
