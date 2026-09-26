---
'@react-three/jolt': minor
---

Vehicles: `TrackedVehicleController` (#246). A tank, driven the same way as a car or a
motorcycle:

- `TrackedVehicleManager` (`type: 'tracked'`) wraps jolt's `TrackedVehicleController`. Two
  tracks (`left`/`right`), each with `drivenWheel`, `inertia`, `angularDamping`,
  `maxBrakeTorque` and `differentialRatio`; wheels are `WheelSettingsTV` (no steering - only
  `longitudinalFriction`/`lateralFriction` on top of the shared `WheelSettings`), laid out
  `wheels.count` per side (default 4) and evenly spaced front to back.
- `move()`'s steering axis is mixed into jolt's `leftRatio`/`rightRatio` skid steer
  (`SetDriverInput(forward, leftRatio, rightRatio, brake)`) rather than forwarded as a wheel
  angle: driving straight always asks both tracks for exactly `forward`, turning speeds up the
  outside track and slows (or reverses) the inside one.
- `<TrackedVehicle>` (`<Vehicle type="tracked">` under its own name) follows the same
  conventions as every other vehicle component: children (or `bodyObject`) become the chassis,
  `wheels`/`wheelObjects` sync wheel objects in constraint order
  (`wheelOrderByType.tracked`, left track front-to-back then right track front-to-back), and
  every secondary-physics prop (`bodyRoll`, `wheelSmoothing`, `skid`, the engine/skid events)
  works exactly as it does for a car - though per-wheel skid detection reads 0 for a tracked
  wheel, since jolt does not track per-wheel slip the way it does for an independent `WheelWV`.
- New demo: `TrackedVehicle` on the heightfield the four-wheeler demo uses.

Jolt notes worth recording: `TrackedVehicleControllerSettings.get_mTracks(index)` returns a
live reference into the settings' own fixed `mTracks[2]` array (mutate it directly, no
`set_mTracks` call needed - same pattern as `mEngine`/`mTransmission`). `VehicleTrack.mDrivenWheel`
indexes into *that track's own* `mWheels`, not the constraint's global wheel list.
`TrackedVehicleController.GetTracks()` is typed as `ReadonlyArray<VehicleTrack>` but the glue
code actually returns a single wrapped `VehicleTrack` pointer (track 0), not an array - do not
index it. A `WheelTV` is a sibling of `WheelWV`, not a subclass of it: `castObject`ing a wheel
from a tracked vehicle to `WheelWV` throws, so `WheelState` now takes an explicit `'wv' | 'tv'`
kind instead of assuming every wheel is a `WheelWV`.
