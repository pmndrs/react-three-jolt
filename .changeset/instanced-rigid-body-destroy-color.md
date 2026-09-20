---
'@react-three/jolt': patch
---

Fix `<InstancedRigidBodyMesh>` never destroying its bodies/InstancedMesh (#24), and
`BodyState`'s `color` setter throwing/writing the wrong path on a non-instanced body (#143).

`InstancedRigidBodyMesh` now, on unmount, destroys every body it created via
`bodySystem.removeBody` (unregistering them from the dynamic/kinematic maps), releases the
`InstancedMesh` (its own `instanceMatrix`/`instanceColor` GPU buffers via `.dispose()`, and
drops the `instanceColor` reference), and disposes the default geometry/material it built
itself when no `<boxGeometry>`/material children were passed - geometry/material sourced
from children stay owned by three-fiber's own JSX tree and are left alone. Changing `count`
still adds/removes bodies incrementally instead of leaking, and a StrictMode remount can no
longer leave orphaned bodies or lose track of the mesh's original parent (the mount effect
is now idempotent). Fixed a related bug where shrinking `count` (e.g. 20 → 10) copied the
*old*, larger count's worth of instance data into the new, smaller buffer, overrunning it.

`BodyState.set color` fell through its non-instanced branch (no `return`) into
`setColorAt`, a method that only exists on `THREE.InstancedMesh`. It now returns after the
instanced branch (also setting `instanceColor.needsUpdate`, which was missing entirely), and
the non-instanced branch clones the mesh's material exactly once - marking it as owned so
`destroy()` disposes it - instead of mutating a material that might be shared with other
meshes. `color` is now typed as `THREE.ColorRepresentation` on both the getter and setter.

Removed the remaining `@ts-ignore`s in `InstancedRigidBody.tsx` by properly typing the
forwarded ref (`ref` is now a plain prop, per React 19) and the geometry/material/body-state
locals instead of suppressing the checker.
