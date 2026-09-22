---
'@react-three/jolt-controllers': minor
---

`<CharacterController>` can now be collided with, via a new `innerBody` prop (issue #73).

A `CharacterVirtual` collides against the world but the world does not collide against it, so
anything pushed into a character passed straight through it. Issue #73 asked for Jolt's standard
`Character` class to solve this. That class isn't exposed by `jolt-physics` and its author
considers it inferior to `CharacterVirtual`, but the property it was wanted for is reachable
from `CharacterVirtual` itself: `mInnerBodyShape` creates a real kinematic body that the
character keeps glued to its capsule, and the rest of the world collides with that.

```tsx
<CharacterController innerBody radius={0.5} height={2} />
```

- `innerBody` (default `false`) and `innerBodyLayer` (default `Layer.MOVING`) on the component,
  or `{ innerBody, innerBodyLayer }` as a second argument to `new CharacterControllerSystem()`.
- `CharacterControllerSystem.hasInnerBody` and `.innerBodyId` read it back. The body is owned by
  the `CharacterVirtual` and destroyed with it — do not remove it through `BodySystem`.
- Both options are read once at construction, because Jolt builds the inner body in the
  `CharacterVirtual` constructor and cannot add one later. `setCapsule` does keep the inner
  body's shape in sync, so resizing a character works as usual.

Fixed along the way: the capsule shapes are now built *before* `CharacterVirtual` is
constructed. They used to arrive with the `setCapsule` call that follows it, which meant every
character was constructed with a null `mShape` and — once there was one to ask for — could never
be given an inner body.

Also corrects the `<CharacterController>` prop table in the docs, which still described
`radius`, `height` and `position` as accepted-but-inert and said the component takes no `ref`.
All four were fixed in #212.
