---
'@react-three/jolt-controllers': minor
---

`followMode` on the camera rig: rotation driven by character movement (#75).

The PC-style rig only ever *translates* with its anchor, so running off sideways leaves you
looking at the character's ear until you drag the camera round yourself. `<CameraRig>` now takes a
`followMode`:

- `"free"` (default, and what the rig did before) - the boom only turns when the player turns it.
- `"movement"` - the boom eases round to trail the character's horizontal velocity, so heading off
  in a new direction swings the camera in behind you. The "Mario style" camera of the issue.
- `"lookAt"` - the boom eases round so `lookAtTarget` stays framed past the character.

```tsx
<CameraRig followMode="movement" rotationSpeed={3} movementThreshold={0.5} />
```

Neither automatic mode fights the player: `manualOverrideTimeout` (default 1000ms) parks them
after any look command - `CameraBoom.move()`/`rotate()` stamp `lastLookTime`, so the existing
`useLookCommand` hookup needs no changes - and `movement` only steers while the character is
actually moving faster than `movementThreshold` (default 0.5 m/s). The ease runs at
`rotationSpeed` (default 2/second) and always takes the short way round.

Inside a `<CharacterController>` the rig reads the character's own `linearVelocity`: the anchor it
follows is a kinematic stand-in for a `CharacterVirtual` and does not carry one. Standalone, it
falls back to the followed body's linear velocity.
