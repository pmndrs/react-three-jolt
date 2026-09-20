---
'@react-three/jolt-controllers': minor
---

One standardized `<Vehicle>` component, with injectable chassis and wheel objects (#10, #26, #27).

**Breaking-ish:** `<VehicleFourWheel>` is deprecated. It still works (and still renders a four
wheeled vehicle) for one release, but it now forwards to `<Vehicle>`; use
`<Vehicle type="fourWheel" | "twoWheel">` instead. The managers were renamed to
`FourWheelVehicleManager` / `TwoWheelVehicleManager` and their files to kebab-case
(`vehicle-manager.ts`, `four-wheel-vehicle-manager.ts`, `two-wheel-vehicle-manager.ts`,
`wheel-state.ts`); the old class names are exported as deprecated aliases. `VehicleManager`'s
`settings` is now a typed, fully resolved settings object rather than `any`, and the two wheeled
defaults are merged *under* your settings instead of over them - a motorcycle built with custom
mass or wheels used to silently get the defaults back.

- `<Vehicle>` takes a typed `vehicleSettings` prop (chassis, cast type, engine, suspension,
  differentials, anti roll bars) with sane defaults per vehicle type.
- `#26`: `<Vehicle bodyObject={ref | object3D}>`, children-as-chassis, or
  `vehicle.setBodyObject(object)` make the manager sync your own chassis (a GLTF scene, say)
  instead of generating a box.
- `#27`: `<Vehicle wheels={[{ radius, width, position, object }, ...]}>`,
  `<Vehicle wheelObjects={[...]}>` or `vehicle.setWheelObject(index | name, object)` do the same
  for the wheels, position and rotation (steering included). `WheelState` takes an object at
  construction or through `setObject()`.
- Ownership: the manager disposes only the meshes it generated itself; an injected object is
  detached on teardown and never disposed.
- New `useVehicle(options)` hook returning the manager for imperative use.
- `createWheelSettings` now understands an explicit wheel `position`, vector valued settings and
  `suspensionSpring`, and no longer assigns our own layout keys onto the jolt settings.
