# @react-three/jolt-addons

## 0.1.0

### Minor Changes

- 45d13d6: Drop `@react-three/drei` as a peer dependency, and widen the `react`/`react-dom` peer range.
  
  drei was required by both `@react-three/jolt` and `@react-three/jolt-addons`, for two things:
  
  - `<Heightfield>` used drei's `useTexture` to load the display texture. `useTexture` is part of
    `@react-three/fiber` as of v10, so it now comes from there. Same behaviour, one fewer install.
  - `useGamepadForCameraControls` imported drei's `CameraControls` purely as a type, for a
    parameter it only ever calls `.rotate()` on. That parameter is now typed as the structural
    `CameraControlsLike`, which drei's `CameraControls` satisfies unchanged — and so does any
    other controls implementation exposing the same method.
  
  Nothing needs to change in your code. If you installed drei only because `@react-three/jolt`
  asked for it, you can drop it.
  
  The `react`/`react-dom` peer range goes from `>=19.0 <19.3` to `>=19.0.0`. The upper bound was
  mirroring the range r3f 10 accepts, but pinning it here means a React minor breaks installs
  against this package rather than against the one that actually cares.
- e3a1606: First release since April 2024, and a breaking one.
  
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
- 795c954: Drop the `gamepad.js` dependency and give `useLookCommand` touch and gamepad support
  (closes #12, closes #87).
  
  **`gamepad.js` is gone (#12).** `Commander` now polls gamepads through a small in-house
  `GamepadPoller` (`useCommand/gamepad.ts`):
  
  - `navigator.getGamepads()` is diffed inside a `requestAnimationFrame` loop that only runs
    while at least one consumer retains the commander (the existing `retain`/`release`
    refcount), and is cancelled when the last one lets go.
  - Button and axis events keep the payload `gamepad.js` used to emit
    (`{ type: 'gamepad:button' | 'gamepad:axis', detail: { index, button | axis, value, pressed } }`),
    so `GamepadInputEvent` and anything written against it is unchanged. The button detail
    gained an additive optional `name` field (the W3C standard-mapping name, e.g. `A` or
    `DPadUp`, which is the mapping `commonCommands` binds its indices against); the new
    `standardGamepadButtons` / `gamepadButtonName` / `standardGamepadSticks` helpers are
    exported.
  - `gamepadconnected` / `gamepaddisconnected` window events are handled, several gamepads are
    tracked by index, and a disconnect releases whatever that pad was holding so a yanked
    controller can't leave a command stuck down.
  - Configurable `deadzone` (default `0.15`) and per-axis / per-button change thresholds, via
    `new Commander({ gamepad: { deadzone, axisThreshold } })`.
  - Environments without the Gamepad API (node, SSR) are a silent no-op instead of a throw,
    and the poller removes every listener it adds — `gamepad.js` used to leave a `window`
    `error` listener behind permanently.
  - `gamepad.js` is removed from `@react-three/jolt-addons`' dependencies, and from
    `@react-three/jolt`'s, where it was declared but never imported. The unused
    `packages/react-three-jolt/types/gamepad.js.d.ts` declaration file is deleted.
  
  **`useLookCommand` takes touch and gamepad input (#87).** In addition to the existing
  mouse/pointer-lock path it now supports a one-finger touch drag (pointer events filtered on
  `pointerType === 'touch'`, multi-touch pinches ignored, `touch-action: none` set on the
  target element while mounted and restored on cleanup) and a gamepad stick sampled per frame
  and scaled by the frame delta. New options:
  
  ```ts
  useLookCommand(onLook, onZoom, {
      mouse: true,
      touch: true,
      gamepad: { stick: 'right', deadzone: 0.15 }, // or true / false
      sensitivity: { mouse: 1, touch: 1, gamepad: 200 },
      invertY: false
  });
  ```
  
  All three sources are on by default, each is registered in its own effect with a full
  cleanup, and the wheel/zoom listener is now independent of the mouse-look option.
  
  **Two fixes to the input rewrite that landed in #177:**
  
  - `vectorPresets.look` names its vertical directions `up`/`down`, but `VectorCommand` only
    mapped `forward`/`backward` onto `y`, so the whole `look` preset drove yaw with its pitch
    bindings.
  - `Commander.updateState` never removed a command that went inactive from the state, so
    `useCommandState` consumers kept acting on an input nobody was giving any more.
- 0cc74f7: `useCommand` tears itself down again, and its callbacks are typed.
  
  The `Commander` behind `useCommand` was a module level singleton that attached four
  `window` listeners and started a `requestAnimationFrame` gamepad poll the first time any
  hook used it. `Commander.destroy()` existed but nothing ever called it, so every listener
  and the poll loop outlived every consumer for the lifetime of the page. Commands were also
  registered **during render**, which is not something a hook is allowed to do.
  
  - The commander is now reference counted. The first hook to mount connects it, the last one
    to unmount disconnects it: all four window listeners are removed, the gamepad poll is
    stopped, and gamepad.js' own (never removed) `window` `error` listener goes with it.
  - `useCommand` registers its command and its listeners in an effect, never in render, so
    Strict Mode's double render cannot double register and changing `commandString`
    re-subscribes without leaking the old listener. The callbacks are read through refs, so
    passing inline arrow functions no longer re-subscribes on every render.
  - `Commander` no longer throws when the environment has no gamepad API (SSR, tests,
    browsers without one); gamepad input is simply skipped.
  - New `<CommanderProvider>` / `CommanderContext` scope a commander to a subtree — a
    `<Canvas>`, a `<Physics>` world — instead of sharing one per document. Hooks with no
    provider above them keep working against a shared commander that is created lazily and
    holds nothing while no hook is mounted.
  
  Fixed along the way:
  
  - **#78** — `useCommand`'s callbacks were declared as `(info: CommandCallback) => void`, so
    `info` was typed as the callback itself and every `info.isInitial` needed a `@ts-ignore`.
    The payload is now its own exported type, `CommandInfo` (which also carries `startTime`,
    as it always did at runtime).
  - `Command.setOptions` indexed by *value* (`this[options[key]] = options[key]`), so
    `setOptions({ sensitivity: 2 })` wrote `command[2]` and never set `sensitivity`.
  - `useLookCommand` never removed the `mouseout` listener it adds on mouse down, and closed
    over `isMouseDown` / `origin` from the render that created the effect rather than refs.
  - `VectorCommand` merged `options.bindings` into the shared entry of `vectorPresets`,
    mutating the preset for every other command in the process.
  - `any` and `Function` are gone from the module: `CommandInfo`, `CommandValue`,
    `CommandOptions`, `CommandEvent`, `CommandState` and `VectorBinding` are exported.
  
  **Breaking:** `useCommand` returns `undefined` on the first render and the `Command` from
  the first effect onwards, because the command is no longer created during render. Use the
  returned command in an effect or guard it. `Commander.getSnapsot` is deprecated in favour
  of the correctly spelled `getSnapshot`.
- a31dac4: Update to the current React, three.js and Jolt stack.
  
  **Peer dependencies changed.** All three packages now require:
  
  - `@react-three/fiber` `>=10.0.0-0`
  - `react` / `react-dom` `>=19.0 <19.3`
  - `three` `>=0.185` (new peer — it was always required, it just was not declared)
  
  **jolt-physics 0.22 → 1.1.0** (Jolt C++ v5.6). The parts of the public surface that
  moved with it:
  
  - `BodyState.getPosition(true)` returns a `Jolt.RVec3` rather than a `Jolt.Vec3`,
    matching the world space vector type Jolt now uses for every position. In the
    single precision builds these are interchangeable at runtime.
  - `vec3.rjolt()` is new: the `RVec3` counterpart of `vec3.jolt()`, for feeding a
    position back into the Jolt API.
  - `generateJoltMatrix()` returns an `RMat44`, which is what `CollideShape` and
    `RShapeCast` take.
  - `Shapecaster.shapecast` is a `Jolt.RShapeCast`.
  - Internally: `Raycaster.cullBackFaces` goes through `RayCastSettings.SetBackFaceMode`
    (the single `mBackFaceMode` field was split in two), `CharacterControllerSystem`
    implements the contact listener callbacks Jolt 0.32 added, and `VehicleManager`
    unwraps the `PhysicsStepListenerContext` that replaced the delta time and physics
    system arguments of the vehicle callbacks in 0.26.
  
  **Also updated:** three 0.186, @react-three/drei 11 alpha, and, for development,
  vite 8, vitest 5, rollup 4.63, TypeScript 5.9 and Biome 2.5 in place of ESLint and
  Prettier. Node 22 is now the minimum.

### Patch Changes

- 21b56db: Rework the build pipeline to fix the `arethetypeswrong` "masquerading as CJS" finding
  (`node16 (from ESM)`) left open by `chore/package-manifests-150` (#150/#178), and to
  decouple declaration generation from rollup's TypeScript plugin (#164):
  
  - JS bundling now uses `rollup-plugin-esbuild` instead of `@rollup/plugin-typescript`.
    esbuild only transpiles - it doesn't type-check - so `dist/index.mjs`/`dist/index.cjs`
    no longer depend on the TypeScript compiler API.
  - Type declarations are emitted separately with `tsc -p tsconfig.build.json
    --emitDeclarationOnly --declarationMap` (a new `tsconfig.build.json` per package,
    `include: ["src"]`) into `dist/types/`, then bundled into single
    `dist/index.d.ts` + `dist/index.d.mts` + `dist/index.d.cts` files with
    `rollup-plugin-dts`. A single bundled declaration file per module condition is what
    stops per-file extensionless relative imports (`export * from './components'`,
    valid under `moduleResolution: "Bundler"`) from tripping up `node16 (from ESM)`
    resolution - there's only one file left to resolve, not a graph of them.
  - `package.json` `exports` nests `types` inside `import`/`require` instead of listing
    it as a sibling key, so ESM and CJS consumers each get their own declaration file:
    `{ import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" }, require:
    { types: "./dist/index.d.cts", default: "./dist/index.cjs" } }`. The top-level
    `types`/`main`/`module` fields are unchanged, for resolvers that ignore `exports`.
  - `tsconfig.json`'s typecheck config (`tsc --noEmit`, still run as the first step of
    `yarn build` in every package) now uses `include: ["src"]` instead of
    `files: ["./src/index.ts"]`, so it covers every file under `src/`, not just what's
    reachable from the entrypoint (partially addresses #145's "six files never
    type-checked", specifically for the build's typecheck gate). No new errors surfaced
    when broadening scope in any of the three packages.
  - `typescript` is bumped to `^7.0.2` (the tsgo native compiler) in all three packages'
    `devDependencies`. Both `tsc --noEmit` and `tsc --emitDeclarationOnly
    --declarationMap` work unmodified against the existing `tsconfig.json` options and
    measured faster than 5.9.x locally. TypeScript 7 ships no classic Compiler API, so
    `@typescript/typescript6` (a compatibility shim) is added alongside it -
    `rollup-plugin-dts` needs that API and loads the shim automatically once it detects
    `typescript@7`.
  - `publint` and `@arethetypeswrong/cli --pack` are both clean (all four resolution
    modes: `node10`, `node16 (from CJS)`, `node16 (from ESM)`, `bundler`) on all three
    packages; see `DEVELOPMENT.md`'s new "Package build pipeline" section for the full
    write-up and how to re-verify.
- 5ffecf3: Fix package manifests: peer dependencies, `sideEffects`, and `exports` maps (#150).
  
  **Peer dependencies:**
  
  - `@react-three/drei` is now a declared `peerDependency` (`>=11.0.0-0`) of
    `@react-three/jolt` (used by `Heightfield`'s `useTexture`) and
    `@react-three/jolt-addons` (used as a type in `useGamepadForCameraControls`). It was
    previously imported by both without being declared anywhere, so consumers could end up
    with an unresolvable import or a duplicate/mismatched copy.
  - `jolt-physics` moves from a regular `dependency` to a `peerDependency` (`>=1.1.0`) of
    `@react-three/jolt`, and is now also a declared `peerDependency` of
    `@react-three/jolt-controllers` (previously undeclared, despite being imported for
    types throughout its character-controller and vehicle systems). Making it a peer
    avoids two copies of the Jolt WASM module ending up in a consumer's bundle, and lets
    apps pick their own `jolt-physics` build variant (e.g. `/wasm`, `/wasm-multithread`)
    instead of being locked to whatever core resolves internally.
  - `@react-three/jolt-addons` does not import `jolt-physics` anywhere, so it was left
    alone there.
  - `camera-controls` is dropped from `@react-three/jolt-controllers`'s `dependencies` —
    its only importer, `camera-rig-system-camera-controls.ts`, is dead code unreferenced
    by any export (removed outright in a separate cleanup pass).
  
  **Tree-shaking / packaging:**
  
  - All three packages now declare `"sideEffects": false`. Audited for import-time
    mutations first — the only real one found (`CameraControls.install()` in the same
    dead `camera-rig-system-camera-controls.ts` file above) is unreachable from any
    package export, so it doesn't affect this.
  - `exports` maps gained a `"./package.json"` entry and a `"default"` fallback, and keep
    `main`/`module`/`types` for resolvers that don't understand `exports`.
  - Each `rollup.config.mjs` now derives its `external` list from that package's own
    `dependencies` + `peerDependencies` keys (plus `three/*` and `jolt-physics/*` subpath
    regexes) instead of a hand-maintained array, so a newly-imported dependency can no
    longer get silently inlined into `dist`. This also fixes `gamepad.js` (a real
    dependency of core and addons) previously being bundled into `dist/index.mjs`/`.cjs`
    instead of left external.
  - `files` now includes `CHANGELOG.md` alongside `dist`, `README.md`, and `LICENSE`.
  - Auditing every `dist` bundle against the new external list turned up two more
    genuinely undeclared runtime imports that were being silently inlined instead of
    externalized: `suspend-react` (used by `Physics.tsx`, added as a regular
    `dependency` of `@react-three/jolt`) and `@react-three/jolt-addons` (its
    `useCommand`/`useLookCommand` are used by `CameraRig`, `VehicleFourWheel`, and
    `CharacterController`, added as a regular `dependency` of
    `@react-three/jolt-controllers`).
  
  **Also:** added `"type": "commonjs"` and `"engines": { "node": ">=22" }` to each
  package's own manifest (`publint` suggestions — these matter once a package is
  installed standalone rather than through the monorepo root, which already had
  `engines.node`).
  
  No runtime behavior changes; `yarn build`, `yarn test`, and `yarn lint` stay green.
- e9832db: Remove dead code and unguarded console output from the library packages (no public API changes):
  
  - Deleted unreferenced source files: `heightField/generators-save.ts`, `heightField/heightfieldManager.ts` + its worker scaffold, `utils/heightmap.ts`, `utils/psrddnoise3.ts` (core); the older `camera-controls`-based camera rig (`camera-rig-system-camera-controls.ts`), the empty `use-character-controller.ts`, and the unused `tmp.ts` (controllers). Dropped the now-unused `camera-controls` runtime dependency from `@react-three/jolt-controllers`.
  - Added `setDebug(flag)` (exported from the core package) to gate the library's internal `console.*` output, which is off by default. Removed ~17 unconditional debug `console.log` calls, and routed the few `console.warn` calls that flag real misuse/limitations through a new `devWarn()` helper so they only print once a consumer opts in with `setDebug(true)`.
  
  Examples app: removed `apps/examples/src/jolt/` (vendored jolt-physics build artifacts, ~1 GB, no longer referenced by any example).
- 41ea7bd: Types only: typed embind helpers, no `@ts-ignore` left, far less `any` (#144, #145, #11).
  
  Nothing changes at runtime for existing code; the declaration output does change, so this is a
  patch across all three packages.
  
  - **New, exported from `@react-three/jolt`:** `wrapPointer(ptr, Class)`, `castObject(obj, Class)`
    and `getPointer(obj)` over the emscripten binder, plus the `JoltClass<T>` constructor type.
    Every jolt-physics JS callback receives raw pointers, and these are the documented way to turn
    one back into a wrapper - with the "this is a view Jolt owns, never free it, never retain it"
    rule stated once instead of at sixty call sites (#144).
  - **New query types:** `HitCollector` / `JoltHitArray` describe the hit-reading surface every
    Jolt collision collector shares, and `CastSuccessHandler` / `CastFailHandler` replace the
    `any` on `cast()`, `castFrom()`, `castTo()`, `castBetween()` (`Raycaster`, `Shapecaster`,
    `ShapeCollider`, `Multicaster`). The handler types are method-style, so a narrower
    `(hit: RaycastHit) => void` still compiles.
  - **Real signatures** for the deprecated `Function` typed listener APIs, for
    `VehicleManager`'s `onPreStep` / `onPostCollide` / `onPostStep` (which now use the exported
    `VehicleStepListener`, #210), for `CharacterControllerSystem.on(action, cb)` (the new
    `CharacterActionName` union, #209), and for `BodySystem`'s deferred actions
    (`PendingActionMap`).
  - **`@react-three/jolt-addons`** gains `isCommandVector(value)`, the guard for reading `.x`/`.y`
    off a command value.
  - `<RigidBody ref>` is `React.Ref<BodyState | undefined>`, `<Physics module>` is a
    jolt-physics factory, and `<Physics defaultBodySettings>` is the new `DefaultBodySettings`.
    `children` is optional on both, so `createElement(Physics, props, ...children)` typechecks
    the way JSX does.
  - Zero `@ts-ignore` remain in `packages/*/src`, `packages/*/test` or `apps/examples/src`;
    `suspicious/noTsIgnore` is now an error, alongside `noDoubleEquals`, `noImplicitAnyLet`,
    `useIterableCallbackReturn` and `noBannedTypes`.
  - Each package now type checks its **tests** as well as its sources
    (`tsconfig.test.json`, run by `yarn test` before vitest), so a test cannot drift.
  
  Two latent bugs surfaced and were fixed on the way: a teleporter's `motionAngularVector` was
  handed to a quaternion setter as a `Vector3` (producing a `NaN` rotation), and
  `<CharacterController>` never assigned its forwarded `ref` nor spread its rest props.
- Updated dependencies [d4eb34a]
- Updated dependencies [3ed5d30]
- Updated dependencies [b701bb2]
- Updated dependencies [9627aaa]
- Updated dependencies [674d8db]
- Updated dependencies [21b56db]
- Updated dependencies [3af73e3]
- Updated dependencies [83ad330]
- Updated dependencies [0704316]
- Updated dependencies [0704316]
- Updated dependencies [53f9bdb]
- Updated dependencies [7d5a576]
- Updated dependencies [75e858a]
- Updated dependencies [45d13d6]
- Updated dependencies [53f9bdb]
- Updated dependencies [4b82a93]
- Updated dependencies [577228c]
- Updated dependencies [f0d751d]
- Updated dependencies [dd435cb]
- Updated dependencies [1796f57]
- Updated dependencies [d4c9e8d]
- Updated dependencies [e3a1606]
- Updated dependencies [c3e11a7]
- Updated dependencies [e64dfa0]
- Updated dependencies [e64dfa0]
- Updated dependencies [ea82dee]
- Updated dependencies [795c954]
- Updated dependencies [1786080]
- Updated dependencies [35ace65]
- Updated dependencies [a3ac577]
- Updated dependencies [674d8db]
- Updated dependencies [674d8db]
- Updated dependencies [5de180b]
- Updated dependencies [5ffecf3]
- Updated dependencies [243eeb1]
- Updated dependencies [e2f8619]
- Updated dependencies [5770bd2]
- Updated dependencies [37de18b]
- Updated dependencies [05f67c2]
- Updated dependencies [3ed5d30]
- Updated dependencies [4754cc7]
- Updated dependencies [0704316]
- Updated dependencies [c94f6ef]
- Updated dependencies [53f9bdb]
- Updated dependencies [42fdc45]
- Updated dependencies [7872049]
- Updated dependencies [d35a497]
- Updated dependencies [8351ed4]
- Updated dependencies [81e0d86]
- Updated dependencies [3b3b96a]
- Updated dependencies [071509a]
- Updated dependencies [d380abe]
- Updated dependencies [e9832db]
- Updated dependencies [a31dac4]
- Updated dependencies [41ea7bd]
  - @react-three/jolt@0.1.0
