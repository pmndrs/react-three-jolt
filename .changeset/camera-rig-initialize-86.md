---
'@react-three/jolt-controllers': minor
---

`CameraBoom` and `CameraRigManager` take options up front (#86).

The rig used to be constructed with the boom's hard coded defaults, attached to the physics loop,
and only then mutated into shape by whoever created it - so the first frame (or, through
`useCameraRig`'s effects, several) ran against a half configured boom. `new CameraRigManager(scene,
physicsSystem, options)`, `CameraBoom.initialize(options)` and `useCameraRig(options)` now set the
boom's length, pitch, pitch limits, collision radius, smoothing, target and follow body *before*
the pre-step listener is registered.

`<CameraRig>` accepts the same options as props. Changing one updates the live rig through
`setOptions()` - the manager is memoised and is never rebuilt for a prop change - and a new
`distance` is eased into rather than snapped to.

Also new: a `cameraPosition` option. A camera placed anywhere other than the origin defines the
boom's length, pitch and yaw, so `<CameraRig cameraPosition={[4, 4, 4]} />` opens already framed
instead of snapping to `(0, 0, 5)` on the first frame. The hard coded `-1.5`/`0.5` pitch clamp in
`handleLookUpdate` is now the `minPitch`/`maxPitch` options.
