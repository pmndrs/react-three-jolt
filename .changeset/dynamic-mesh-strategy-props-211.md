---
'@react-three/jolt': minor
---

Fixed #211:

- `dynamicMeshStrategy` (#112) is now reachable from the component tree: `<RigidBody
  dynamicMeshStrategy>` sets it per body, `<Physics defaultDynamicMeshStrategy>` sets a world
  wide fallback (a per-body value always wins). Previously the only way to opt into `'error'` was
  to build the body yourself through `bodySystem.addBody`.
- `AutoShape` and `ShapeType` are unified into one `ShapeType` union - `AutoShape` is now a
  deprecated alias of it, so `<Shape type>`, `<RigidBody shape>` and `<Physics defaultShape>` all
  accept every tag (including `'mutableCompound'`, `'scaled'` and `'offsetCenterOfMass'`, which
  `AutoShape` used to reject at the type level even though the shape pipeline already understood
  them). `'compound'` remains a documented alias of `'staticCompound'`, normalised by the newly
  exported `normaliseShapeType`.
- `describeShapeFromOptions` gained the `'scaled'`/`'offsetCenterOfMass'` cases it was missing -
  both previously fell through to a unit box descriptor rather than building the decorator shape
  (or erroring). They take a new `child`/`decoratorScale`/`centerOfMass` on `ShapeOptions`.
