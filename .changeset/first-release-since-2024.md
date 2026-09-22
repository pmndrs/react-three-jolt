---
'@react-three/jolt': minor
'@react-three/jolt-addons': minor
'@react-three/jolt-controllers': minor
---

First release since April 2024, and a breaking one.

The version on npm (`0.0.1`) predates react 19, `@react-three/fiber` 10, `three` 0.185 and
jolt-physics 1.1.0, and nothing documented on the docs site describes it. Everything below is a
break from that release, not from a recent one — see
[Migration](https://pmndrs.github.io/react-three-jolt/advanced/migration) for the full list.

The headlines:

- **Peers moved wholesale.** react 19, `@react-three/fiber` >=10, `three` >=0.185, node >=22.
  `jolt-physics` is a peer now rather than a dependency, so you pick the build variant and can't
  end up with two copies of the WASM in one bundle.
- **`physicsSystem` is `joltPhysicsSystem`**, and non-component files are kebab-case.
- **React 19 component conventions**: `ref` is a plain prop, `useMount`/`useUnmount` are gone.
- **The public API surface was narrowed** — several accidental exports are no longer exported,
  and `BodyEvents`/`WorldEvents` are deleted in favour of `BodyEventMap`/`WorldEventMap`.
- **`vec3.jolt()`, `vec3.rjolt()` and `quat.jolt()` always return an object you own**, where
  before they sometimes handed back their argument.
- **Every system has a real `destroy()`**, and `Raw.joltInterfaces`/`PhysicsSystem.maxInterfaces`
  are gone along with the three-world cap.

This ships as **0.1.0**. The `0.x` line is the signal that the API is still in motion — `1.0`
is reserved for the feature-parity milestone tracked in #51, which is not where this is. Expect
breaking changes in minor bumps until then, and pin an exact version if you build on it.
