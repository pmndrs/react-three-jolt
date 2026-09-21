---
'@react-three/jolt-controllers': patch
---

Give the controllers a real teardown story (#138, #139, #140).

`CharacterControllerSystem`, `CameraRigManager`/`CameraBoom`, `VehicleSystem`/`VehicleManager` and
`WheelState` now have idempotent `destroy()` methods that free every jolt object they own - the
`CharacterVirtual` and its contact listener, the capsule shapes, the boom's raycaster/shapecaster/
shape collider, the vehicle constraint (released, not destroyed, like every other constraint), its
step listener and callbacks - plus the bodies they created and their three geometries and
materials. Each system now registers its pre-step listener as a stored function reference, so
`removeStepListener`'s identity match actually finds it and a destroyed system stops being stepped.
`<CharacterController>`, `<CameraRig>` (through `useCameraRig`) and `<VehicleFourWheel>` release
everything on unmount, so mounting and unmounting them no longer leaks.

Also fixes several allocation bugs on the way: `setCapsule` and the vehicle body/constraint setup
freed none of their temporaries, the wheel material and texture were rebuilt for every wheel, and
the per-frame wheel and chassis sync allocated three.js objects it did not need.
