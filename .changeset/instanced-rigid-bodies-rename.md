---
'@react-three/jolt': minor
---

`<InstancedRigidBodyMesh>` is now `<InstancedRigidBodies>`, matching the component of the same
name in `@react-three/rapier` (issue #37, sibling-library parity). Same props, same behaviour —
only the name changed, so moving between the two libraries is one less thing to relearn.

The old name is still exported as a deprecated alias, along with
`InstancedRigidBodyMeshProps` → `InstancedRigidBodiesProps`. Both will be removed before 1.0.
