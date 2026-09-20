---
'@react-three/jolt': minor
---

Mutable compound shapes (#108): a `{ type: 'mutableCompound' }` descriptor now builds a real
`MutableCompoundShape`, and `<Shape dynamic>` uses it. New `addSubShape` / `removeSubShape` /
`modifySubShape` helpers edit such a compound in place, and the matching `BodyState` methods also
run `AdjustCenterOfMass()` + `BodyInterface.NotifyShapeChanged`, so the body's mass properties and
broadphase bounds follow. A child `<Shape>` mounting, unmounting or moving inside a
`<Shape dynamic>` now goes through that runtime path instead of rebuilding the whole compound.
