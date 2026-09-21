---
'@react-three/jolt-controllers': patch
---

API polish from issues #210 and #212:

- `CharacterControllerSystem` emitted both `'exhausted'` and a misspelt `'exausted'`
  as two distinct actions for the same event (becoming exhausted, then recovering).
  Only `'exhausted'` is emitted now; `'exausted'` remains a valid (deprecated)
  `CharacterActionName` for source compatibility but the system never emits it.
  The option that controls the timing, `exauhstionTimeLimit`, is renamed to
  `exhaustionTimeLimit`; the misspelt name is kept for one release as a deprecated
  getter/setter alias.
- `CameraBoomOptions.collisionRadius` documented `@default 0.3` but `CameraBoom` had
  no initialiser backing it - the number only worked because `ShapeCollider`'s own
  default shape happens to be a `SphereShape(0.3)`. `CameraBoom` now owns the value
  explicitly, readable through the new `collisionRadius` getter/setter, and the
  collider's shape follows every change to it (at construction, through
  `CameraBoomOptions`, and through `setOptions`/`setCollisionRadius` on a live rig).
- `<CharacterController radius height position>` were accepted but inert:
  `setCapsule` was never called (it was commented out, both at creation and on
  later changes), and `position` only ever offset the rendered child `<object3D>`
  relative to the character - since that object3D is parented under the
  character's own three object, it never moved the actual `CharacterVirtual`.
  `radius`/`height` now reach `setCapsule` at creation and on every change;
  `position` now sets (and, on later changes, teleports) the real character
  position, and is no longer also applied as a local offset on the child object3D.
  `anchor`/`rest` were speculative props from early development that were never
  wired to anything in the system (the system's own, unrelated internal `anchor`
  is the rig-follow sensor body created by `createAnchor()`) - they were already
  removed from `CControllerProps` in #228 and are not reintroduced.
- `<CharacterController ref>` is now correctly typed as `CharacterControllerSystem`
  (previously the component's `React.FC<CControllerProps>` annotation erased the
  ref from its public type even though the runtime always supported it); the
  `CControllerProps` interface is now exported.
