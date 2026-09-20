---
'@react-three/jolt-controllers': minor
---

Vehicle secondary physics (#41): the presentational layer on top of the vehicle constraint.
None of it touches the simulation, all of it runs in `postPhysicsUpdate` after jolt has solved
the step, and none of it allocates per frame.

- **Body roll.** `bodyRoll: { maxAngle, maxPitchAngle, referenceAcceleration, stiffness,
  damping }` leans and pitches the *chassis object* (whatever is being synced as the chassis:
  the injected `bodyObject` or the generated box) with a spring damped tilt driven by the
  chassis body's own acceleration rotated into its local frame. The physics body is never
  rotated, so a steady corner leans the model outwards while the constraint keeps solving
  exactly what it solved before. `bodyRoll: false` turns it off and hands the object's rotation
  back; `VehicleManager.setBodyRoll()` re-tunes it live. New readouts: `bodyRollAngle`,
  `bodyPitchAngle`.
- **Wheel smoothing.** `wheelSmoothing: { suspension, steering }` (time constants in seconds)
  eases the rendered suspension travel and steering angle. Jolt builds a wheel's transform as
  `steer(angle) * everything-else` about the vehicle's local up axis, so the eased steering
  angle is applied as a single pre-multiplied delta rather than a rebuild of the transform -
  with smoothing off the rendered transform is jolt's to the bit. `setWheelSmoothing()` is live.
- **Slip and skid.** `WheelState` now publishes `slipRatio` (jolt's `WheelWV::mLongitudinalSlip`),
  `lateralSlip` (`mLateralSlip`, a slip angle in radians), `isSkidding`, `hasContact`,
  `suspensionLength`, `spinVelocity` and `spinAngle` - the last accumulated rather than wrapped
  into `[0, 2pi)`, so it can drive a shader or an odometer directly. `skid: { longitudinalSlip,
  lateralSlip, minLateralSpeed, release, releaseTime, requireContact }` decides when a wheel
  counts as skidding, with hysteresis so a wheel at the edge of grip does not machine-gun
  events, and the manager emits `skidStart`/`skidEnd` (`onSkidStart`/`onSkidEnd`, or the
  `<Vehicle>` props) with the wheel, its slip and the world space contact patch. `setSkid()` is
  live, and `setSkid(false)` ends the skids that are running so a listener always gets its
  `skidEnd`.
- **Engine / audio hooks.** `rpm`, `gear`, `shifting`, `clutch`, `throttle`, `brakeInput`,
  `speed` (signed m/s), `speedKmh` and `skidding` getters on the manager, plus `onEngine(fn)`
  which dispatches all of it once per physics step. Both event payloads are **pooled**: the same
  object every dispatch, so nothing is allocated at 60 Hz - read what you need inside the
  handler and copy anything you keep.
- `<Vehicle>` gained `bodyRoll`, `wheelSmoothing`, `skid`, `onSkidStart`, `onSkidEnd` and
  `onEngine` props, all live; `useVehicle` gained the three option objects. The
  `FourWheelsWithHeightmap` example drives every knob from a leva panel and shows the readout.

Anti roll bars are not part of this: `VehicleConstraintSettings::mAntiRollBars` was already
wired up through `antiRollbar` / `frontRollBarStiffness` / `rearRollBarStiffness`. Jolt exposes
no downforce setting, so none is faked here.

Jolt notes: `WheeledVehicleController::GetEngine()`/`GetTransmission()` and
`castObject(wheel, WheelWV)` all re-wrap pointers emscripten caches per class, so they are the
same JavaScript object every call and none of them may ever be destroyed. Jolt's lateral slip is
`atan2(lateral velocity, |longitudinal velocity|)`, which is noise divided by noise once a
vehicle has stopped - hence `minLateralSpeed`, without which a parked car skids forever.
