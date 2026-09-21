---
'@react-three/jolt': patch
---

`useMount`/`useUnmount` (issue #57): `RigidBody`, `Physics` and `InstancedRigidBodyMesh` now use
plain `useEffect`s (with `[]` deps, exactly as the two hooks did internally) instead of the
FluentUI-style `useMount`/`useUnmount` wrappers. `useMount`/`useUnmount` are still exported for
one release but are now `@deprecated` - prefer `useEffect(() => { ... }, [])` and
`useEffect(() => () => { ... }, [])` respectively.

While auditing `RigidBody`'s remaining effects for correct dependency arrays as part of the same
pass, three real bugs surfaced and are fixed:

- The DOF effect (`dof`/`lockRotations`/`lockTranslations`) was missing `activeShape` in its
  dependency array, unlike the otherwise-identical Groups effect. A `<RigidBody>` whose shape
  comes from `<Shape>` children (so the body is created a render after this effect's first,
  early-returning run) never had its DOF settings applied at all.
- `obstructionTimelimit={0}` was silently dropped (a truthiness check instead of `!== undefined`).
- Two effects checked `!bodyLoaded` - a ref *object*, always truthy - instead of
  `!bodyLoaded.current`, so the check never actually gated anything (harmless in practice, since
  the two only ever become true/false together, but misleading).
