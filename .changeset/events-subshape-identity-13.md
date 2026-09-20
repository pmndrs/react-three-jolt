---
'@react-three/jolt': minor
---

Sub-shape identity on contact payloads, and per-`<Shape>` event props (issue #13, remainder).

```tsx
<RigidBody onCollisionEnter={(e) => console.log(e.targetSubShape.descriptor?.name)}>
    <Shape>
        <Shape name="left"  size={[8, 1, 8]} position={[-6, 0, 0]} onCollisionEnter={…} />
        <Shape name="right" size={[8, 1, 8]} position={[ 6, 0, 0]} onCollisionEnter={…} />
    </Shape>
</RigidBody>
```

- `CollisionPayload` gains `targetSubShape` / `otherSubShape`:
  `{ id, index, userData, descriptor }`. They are **getters**, resolved on first read, so a
  handler that never asks costs no shape walk per contact; the `SubShapeRef` is pooled like the
  rest of the payload. `index` is which child of the body's top-level compound was hit,
  `userData` the tag stamped on the `<Shape>`/descriptor that produced it at any nesting depth,
  `descriptor` the description it was built from.
- `createShapeSettings` now stamps every descriptor's `userData` onto the **shape**, not just
  onto the compound's per-sub-shape record. `CompoundShape::GetSubShapeUserData` recurses into
  the child and returns the *child shape's* user data, so the shape is the only place a contact
  can read it back from; both are written now.
- New in `shape-system.ts`: `subShapeIndexFromId`, `subShapeUserData`, `descriptorForSubShape`,
  `hasSubShapes`, `EMPTY_SUB_SHAPE_ID`. `CompoundShape::GetSubShapeIndexFromID` is not in the
  jolt-physics binding, so `subShapeIndexFromId` redoes its arithmetic (pop
  `ceil(log2(numSubShapes))` bits off the low end) against the body's shape — which is also what
  distinguishes "child 1 of a two-child compound" from "no sub-shape at all", since Jolt pads a
  `SubShapeID`'s unused high bits with ones and both are `0xFFFFFFFF`.
- `<Shape>` takes `userData`, `name`, and `onCollisionEnter` / `onCollisionPersist` /
  `onCollisionExit` / `onSensorEnter` / `onSensorExit` scoped to that sub-shape. They subscribe
  on the parent body and filter by sub-shape, so they cost the body's handler plus one compare,
  and nothing at all when unused. A `<Shape>` with handlers and no explicit `userData` is
  assigned one automatically, from the top of the 32-bit range.
- `ShapeDescriptorBase` gains `name` (carried on the descriptor only; it never reaches Jolt).
- `BodyState.shapeDescriptor` keeps the description a body's shape was built from. `<Shape>` and
  the automatic `describeObject` path both set it; `addBody(object, { shape })` takes a new
  `shapeDescriptor` option for callers that build a shape themselves.
- New `OneWayPlatform` demo in `apps/examples`: `onContactValidate` rejecting contacts from
  below, and a three-panel compound floor where each `<Shape>` lights up only for its own hits.
