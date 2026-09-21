---
'@react-three/jolt-controllers': patch
---

Cancel the character's upward velocity on head/ceiling contact instead of letting it push into the
obstacle until gravity alone cancels it out (#88).

`CharacterControllerSystem`'s `CharacterContactListenerJS` now recognises a contact whose normal
falls within a configurable `headAngle` (default 30 degrees) of straight-down relative to the
character's up axis - the underside of a ceiling or overhang, as opposed to walkable ground
(normal ~= up) or a wall (normal roughly perpendicular to up). `OnContactSolve` cancels only the
upward component of the character's velocity response every step such a contact stays active, and
`OnContactAdded` fires the new `onHeadHit` callback exactly once per contact. Both `headAngle` and
`onHeadHit` are configurable on `CharacterControllerSystem` and as props on `<CharacterController>`.
