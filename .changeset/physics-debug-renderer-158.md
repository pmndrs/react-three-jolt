---
'@react-three/jolt': minor
---

`<Physics debug>` now draws a wireframe of **every** collider in the world (#158), replacing the
per body `debug` boolean as the way to see what the simulation actually has in it.

- One wireframe per body, built from the body's real Jolt shape via `createMeshFromShape`, so it
  shows the convex hull a dynamic trimesh fell back to, the compound that was assembled and the
  scale that was really applied - not the three.js geometry that was handed in. Compounds, mesh,
  hull and heightfield shapes all work.
- Coloured by motion type: grey static, blue kinematic, green dynamic, yellow sleeping, magenta
  sensor. Constraints are drawn as lines between their anchor points, and `<Debug showContacts>`
  adds the last step's contact points and normals.
- Geometry is cached per Jolt shape pointer, so a thousand bodies sharing one shape are
  triangulated once; a `MutableCompoundShape` edited in place invalidates its entry through the
  new `shapeChanged` world event.
- Membership is event driven, off three new `physicsSystem.events` types - `bodyAdded`,
  `bodyRemoved` and `shapeChanged`. Bodies that already exist are backfilled when the overlay is
  created, so toggling `debug` on for a running scene works; toggling it off disposes every
  geometry and material and removes all of the per frame work.
- Render only: it reads body poses and shapes and writes three.js matrices, from `useFrame` and
  never from a step callback, and it draws the same interpolated pose the bodies' own meshes get
  (`physicsSystem.frameAlpha` / `frameInterpolating` are now public).
- Mount `<Debug>` directly for its own options (`colors`, `showConstraints`, `showContacts`,
  `contactNormalLength`, `maxContacts`, `depthTest`, `updatePriority`).

Jolt's own `DebugRenderer` is deliberately not used: it only exists in jolt-physics' debug
builds and 1.1.0 ships no JS binding for it. A `DebugRendererJS` path could be added later
without changing this component's surface.
