---
'@react-three/jolt': patch
---

API polish from issue #210:

- `Raycaster.cullBackFaces`'s setter wrote `RayCastSettings.mBackFaceMode*` but never
  updated the `doCullBackFaces` backing field, so the getter always echoed back the
  constructor's initial value (`true`) no matter what was assigned afterwards. The
  setter now updates the field too.
- `Layer.KINEMATIC` existed but kinematic bodies (`bodyType: 'kinematic'` or
  `motionType: 'kinematic'`) were created on `Layer.MOVING`, so the reserved layer id
  was pure documentation. `generateBodySettings` (`body-system.ts`) now assigns
  `Layer.KINEMATIC`, and the object layer pair filter built in `PhysicsSystem`'s
  constructor enables it against `NON_MOVING`, `MOVING` and itself, matching what
  `MOVING` already had. A kinematic body also now gets
  `BodyCreationSettings.mCollideKinematicVsNonDynamic = true` by default: Jolt only
  runs narrowphase on a pair when at least one side is Dynamic, so without this flag
  a kinematic platform would silently pass straight through static geometry or
  another kinematic body no matter how the pair filter is configured - the pair
  filter change alone is necessary but not sufficient. A dynamic body resting on (or
  falling onto) a kinematic platform is unaffected by any of this and keeps working
  exactly as before.
