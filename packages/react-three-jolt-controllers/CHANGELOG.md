# @react-three/jolt-controllers

## 0.1.0

### Minor Changes

- 9998b46: Camera boom whiskers (#92).
  
  The boom already shape-cast backwards and pulled the camera in when a wall got between it and the
  player, which reads as a snap. With `whiskers` on it now also fans short rays out either side of
  the boom every step and rotates the yaw away from whatever they touch, so the camera slides around
  a corner before the wall ever becomes a problem - the "ray base whiskers" trick from the issue.
  
  ```tsx
  <CameraRig whiskers whiskerLength={3} whiskerStrength={2} />
  ```
  
  Configurable through `whiskerCount` (default 5), `whiskerSpread` (default ±60°), `whiskerLength`,
  `whiskerStrength` and `whiskerDamping`; `isWhiskerSteering` says whether anything is currently in
  the way. The steering rate is spring damped, so it eases in and decays back to zero once the
  whiskers come clear.
  
  The whisker raycaster is built lazily the first time whiskers are switched on, is freed by
  `destroy()` along with the boom's other queries, and the per-step sweep is allocation free on both
  sides of the wasm boundary: the fan's sin/cos are precomputed, the vectors are reused, and each
  cast writes into the raycaster's own `RRayCast` and reads the hit fraction straight off its
  collector instead of building a `RaycastHit` per whisker per frame.
- 68c71a9: `followMode` on the camera rig: rotation driven by character movement (#75).
  
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
- d342776: `CameraBoom` and `CameraRigManager` take options up front (#86).
  
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
- 854c2f8: Character controller events, `isMoving` and `isSliding` (issues #79, #80, and the `onAction`
  half of #50).
  
  ```tsx
  <CharacterController
      onMove={(speed) => …} onStop={…}
      onSlide={(speed) => …} onSlideEnd={…}
      onJump={(count) => …} onLand={(airtime) => …}
      onGround={…} onAirborne={…} onCrouch={…} onStand={…}
      onContactAdded={(e) => …} onContactPersisted={…} onContactRemoved={…}
      onAction={(name, payload) => …}
      moveThreshold={0.5} slideThreshold={0.5}
  />
  ```
  
  - `isMoving` and `isSliding` were declared fields that **nothing ever assigned**. They are now
    cheap getters over booleans recomputed once per pre-step, alongside a new `isGrounded`.
  - Movement is measured against the *supporting body's* velocity — #79's open question. Jolt's
    `GetLinearVelocity()` on a moving platform already includes the platform's velocity, so
    `GetGroundVelocity()` is subtracted before the horizontal speed is taken: riding a lift is not
    walking. Sliding is the tangential part of that same relative velocity against the ground
    plane, and only counts while Jolt reports `OnSteepGround` (or `NotSupported`). Both use
    hysteresis — enter at the threshold, leave at half of it — so a character sitting on the
    threshold does not emit an event per step. `moveThreshold` / `slideThreshold` default to
    0.5 m/s.
  - `CharacterControllerSystem.events` is now public and typed (`CharacterEventMap`): `move`,
    `stop`, `slide`, `slideEnd`, `jump`, `land`, `ground`, `airborne`, `crouch`, `stand`,
    `contactAdded`, `contactPersisted`, `contactRemoved`, plus the existing `action`. Every one is
    *also* emitted as an `action` of the same name, so `controller.on('move', fn)` and
    `controller.events.on('move', fn)` agree about what happened.
  - The character contact callbacks Jolt actually invokes are forwarded rather than being no-ops.
    Their argument lists are not in the 1.1.0 typings, so they were settled at runtime:
    `OnContactPersisted` has the same six arguments as `OnContactAdded`, `OnContactRemoved` has
    three and no geometry. They fire from *inside* `ExtendedUpdate`, so they are queued there and
    dispatched once it returns — the same two-tier arrangement bodies use, which means a handler
    may freely add and remove bodies. `CharacterContactPayload` is pooled.
  - Zero cost when unused: the contact callbacks test `events.mask & CharacterEventBit.*` and
    return before wrapping anything, and 200 steps with every handler attached allocate nothing on
    the Jolt heap.
  - New export `useCharacterEvent(system, type, handler)`, the hook behind the props: the
    dependency is *whether* there is a handler rather than its identity, and the cleanup is the
    unsubscribe handle.
- 6ef2d5d: `<CharacterController>` can now be collided with, via a new `innerBody` prop (issue #73).
  
  A `CharacterVirtual` collides against the world but the world does not collide against it, so
  anything pushed into a character passed straight through it. Issue #73 asked for Jolt's standard
  `Character` class to solve this. That class isn't exposed by `jolt-physics` and its author
  considers it inferior to `CharacterVirtual`, but the property it was wanted for is reachable
  from `CharacterVirtual` itself: `mInnerBodyShape` creates a real kinematic body that the
  character keeps glued to its capsule, and the rest of the world collides with that.
  
  ```tsx
  <CharacterController innerBody radius={0.5} height={2} />
  ```
  
  - `innerBody` (default `false`) and `innerBodyLayer` (default `Layer.MOVING`) on the component,
    or `{ innerBody, innerBodyLayer }` as a second argument to `new CharacterControllerSystem()`.
  - `CharacterControllerSystem.hasInnerBody` and `.innerBodyId` read it back. The body is owned by
    the `CharacterVirtual` and destroyed with it — do not remove it through `BodySystem`.
  - Both options are read once at construction, because Jolt builds the inner body in the
    `CharacterVirtual` constructor and cannot add one later. `setCapsule` does keep the inner
    body's shape in sync, so resizing a character works as usual.
  
  Fixed along the way: the capsule shapes are now built *before* `CharacterVirtual` is
  constructed. They used to arrive with the `setCapsule` call that follows it, which meant every
  character was constructed with a null `mShape` and — once there was one to ask for — could never
  be given an inner body.
  
  Also corrects the `<CharacterController>` prop table in the docs, which still described
  `radius`, `height` and `position` as accepted-but-inert and said the component takes no `ref`.
  All four were fixed in #212.
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
- 1796f57: One event primitive, and the physics step hooks (issues #50, #157).
  
  - New `Emitter<M>` in `systems/emitter.ts`: `on(type, fn)` / `once(type, fn)` return an
    unsubscribe closed over the subscription itself, so removal never compares function
    identity. Registering the same function twice now unsubscribes exactly once per `on`,
    which is what makes React StrictMode's mount → cleanup → mount safe. Subscribing or
    unsubscribing from inside a handler is safe, each handler runs in its own `try/catch`
    (an exception unwinding through emscripten's callback glue corrupts the step), and a
    `mask` bitfield backs the zero-cost dispatch path.
  - `PhysicsSystem` gains `events`, `onBeforeStep(fn)` and `onAfterStep(fn)`, all returning
    the unsubscribe. `addPreStepListener` / `addPostStepListener` now return one too (was
    `void`, so source compatible) and are deprecated; `removeStepListener(fn)` is deprecated
    and now removes *every* subscription made for that function.
  - New `useBeforePhysicsStep(fn)` / `useAfterPhysicsStep(fn)` hooks. The callback lives in
    a ref, so an inline arrow does not resubscribe on every render, and the effect cleanup is
    the unsubscribe handle.
  - Step order is now defined as `beforeStep` → pending actions → `Step()` → `afterStep`, per
    substep rather than per frame.
  - Controllers: `CharacterControllerSystem`, `CameraRigManager` and `VehicleSystem` keep the
    handle for their step subscription and drop it in `destroy()` / `detachFromLoop()`. All
    four were inline arrows that `removeStepListener` could never match, so a destroyed
    character kept being pre-stepped against a freed `CharacterVirtual` and
    `CameraRigManager.detachFromLoop()` silently did nothing. `CharacterController.on`,
    `CameraRigManager.onCamera` and `VehicleManager.onPreStep/onPostCollide/onPostStep/onAction`
    keep their signatures and are reimplemented on `Emitter`; `VehicleManager` now keeps a
    reference to its `VehicleConstraintStepListener`.
  - `CharacterContactListenerJS`: measured against jolt-physics 1.1.0, Jolt invokes six of the
    eleven declared callbacks for a `CharacterVirtual` stepping against bodies
    (`OnAdjustBodyVelocity`, `OnContactValidate`, `OnContactAdded`, `OnContactPersisted`,
    `OnContactRemoved`, `OnContactSolve`). The five character-vs-character no-op assignments
    were dead code — they only fire once a `CharacterVsCharacterCollision` is installed — and
    are removed, with a test that fails if that ever changes.
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
- 572aa72: One standardized `<Vehicle>` component, with injectable chassis and wheel objects (#10, #26, #27).
  
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
- 07d9f72: Vehicle secondary physics (#41): the presentational layer on top of the vehicle constraint.
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

### Patch Changes

- d4eb34a: API polish from issues #210 and #212:
  
  - `CharacterControllerSystem` emitted both `'exhausted'` and a misspelt `'exausted'`
    as two distinct actions for the same event (becoming exhausted, then recovering).
    Only `'exhausted'` is emitted now; `'exausted'` remains a valid (deprecated)
    `CharacterActionName` for source compatibility but the system never emits it.
    The option that controls the timing, `exauhstionTimeLimit`, is renamed to
    `exhaustionTimeLimit`; the misspelt name is kept for one release as a deprecated
    getter/setter alias.
  - `CameraBoomOptions.collisionRadius` documented `@default 0.3` but `CameraBoom` had
    no initialiser backing it - the number only worked because `ShapeCollider`'s own
    default shape happens to be a `SphereShape(0.3)`. `CameraBoom` now owns the value
    explicitly, readable through the new `collisionRadius` getter/setter, and the
    collider's shape follows every change to it (at construction, through
    `CameraBoomOptions`, and through `setOptions`/`setCollisionRadius` on a live rig).
  - `<CharacterController radius height position>` were accepted but inert:
    `setCapsule` was never called (it was commented out, both at creation and on
    later changes), and `position` only ever offset the rendered child `<object3D>`
    relative to the character - since that object3D is parented under the
    character's own three object, it never moved the actual `CharacterVirtual`.
    `radius`/`height` now reach `setCapsule` at creation and on every change;
    `position` now sets (and, on later changes, teleports) the real character
    position, and is no longer also applied as a local offset on the child object3D.
    `anchor`/`rest` were speculative props from early development that were never
    wired to anything in the system (the system's own, unrelated internal `anchor`
    is the rig-follow sensor body created by `createAnchor()`) - they were already
    removed from `CControllerProps` in #228 and are not reintroduced.
  - `<CharacterController ref>` is now correctly typed as `CharacterControllerSystem`
    (previously the component's `React.FC<CControllerProps>` annotation erased the
    ref from its public type even though the runtime always supported it); the
    `CControllerProps` interface is now exported.
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
- fea4740: Cancel the character's upward velocity on head/ceiling contact instead of letting it push into the
  obstacle until gravity alone cancels it out (#88).
  
  `CharacterControllerSystem`'s `CharacterContactListenerJS` now recognises a contact whose normal
  falls within a configurable `headAngle` (default 30 degrees) of straight-down relative to the
  character's up axis - the underside of a ceiling or overhang, as opposed to walkable ground
  (normal ~= up) or a wall (normal roughly perpendicular to up). `OnContactSolve` cancels only the
  upward component of the character's velocity response every step such a contact stays active, and
  `OnContactAdded` fires the new `onHeadHit` callback exactly once per contact. Both `headAngle` and
  `onHeadHit` are configurable on `CharacterControllerSystem` and as props on `<CharacterController>`.
- 0704316: React 19 component convention (issue #49): every exported component is now a plain function
  component with `ref` as an ordinary, typed prop - no `forwardRef`, no `React.FC`/`FC<Props>`
  annotation. Runtime behavior, every prop and every existing `ref` usage are unchanged; this is a
  structural cleanup, not a new feature.
  
  - `RigidBody`, `Shape` (and the collider components built on it - `CuboidCollider`,
    `BallCollider`, `CapsuleCollider`, `CylinderCollider`, `ConeCollider`, `ConvexHullCollider`,
    `TrimeshCollider`, `HeightfieldCollider`) drop the `forwardRef` wrapper their `ref` prop no
    longer needed.
  - `CharacterController` and `CameraRig` (`@react-three/jolt-controllers`) do the same; `ref` is
    now documented on `CControllerProps`/`CameraRigProps` instead of only working at runtime.
  - `Physics`, `Debug`, `Attractor`, `InstancedRigidBodyMesh` drop their `React.FC`/`FC<Props>`
    type annotations in favor of a typed props parameter.
  - See the new "Component convention" section in `DEVELOPMENT.md` for the convention itself.
- a4700a1: Give the controllers a real teardown story (#138, #139, #140).
  
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
- 53f9bdb: Fixed #227: a `BodyState`, query object or controller kept alive past its `<Physics>` world's
  teardown (an uncancelled `setTimeout`, an event handler, a closure captured before unmount) could
  reach a Jolt handle that had already been freed. Because jolt-physics' WASM module is a page-wide
  singleton with immediate pointer reuse, that landed on *some other* live world's memory instead of
  failing cleanly - `RuntimeError: memory access out of bounds` at best, silent corruption of an
  unrelated demo at worst.
  
  - `BodyState.dispose()` now nulls its Jolt handles, and every public method/getter/setter checks
    a new `disposed` guard first: in debug mode (`setDebug(true)`) it throws a descriptive `Error`;
    otherwise it is a silent no-op, matching how a shipped build already behaved elsewhere. Fixed a
    real bug this surfaced: `BodySystem.removeBody` read `bodyState.body.GetID()` *after* calling
    `dispose()`, which the new guard would have broken - the id is now captured first.
    `dispose()` also stops tracking any standing `setKinematicTarget`.
  - The same guard now covers every public method on `QueryBase`/`CastQueryBase` (`cast`,
    `castFrom`/`castTo`/`castBetween`, `setCollector`, `set`, `initDebugging`) and on
    `ShapeCollider` and `Shapecaster`'s setters - a couple of which (`Shapecaster.setOrigin`/`set
    shape`) would otherwise have double-freed their `RShapeCast` after `destroy()`.
  - `CameraRigManager.createRigPoint` and `VehicleSystem.addVehicle` now refuse to create a new
    Jolt body/vehicle once the owner has been destroyed, instead of leaking one nothing will ever
    tear down again.
  
  Also investigated the low-priority `EPhysicsUpdateError` note in #227 (the `debug-wasm-compat`
  build logging an error under CubeHeap's 200-body load): `JoltSettings`' defaults
  (`mMaxBodies=10240`, `mMaxBodyPairs=65536`, `mMaxContactConstraints=10240`) are already far above
  what 200 bodies need, so raising them did not look like the right fix and was left alone - see the
  PR description for the full note.
- 674d8db: #28: `PhysicsSystem.physicsSystem` - the raw Jolt `Jolt.PhysicsSystem` handle - is renamed to
  `PhysicsSystem.joltPhysicsSystem`. The old name was ambiguous: every other class's `physicsSystem`
  field holds *this* wrapper (our `PhysicsSystem`, e.g. `ConstraintSystem.physicsSystem`,
  `DebugRenderer`'s field, `useJolt()`'s `physicsSystem`), so a field of the same name on
  `PhysicsSystem` itself that instead held the raw Jolt object was the one place the name lied.
  
  `PhysicsSystem.physicsSystem` still works for one release as a deprecated getter that forwards to
  `joltPhysicsSystem` and warns once via `devWarn` (visible with `setDebug(true)`, silent otherwise,
  matching this library's other deprecation warnings).
  
  `ShapeSystem`'s raw-Jolt field had the same ambiguity (it wasn't itself named `ShapeSystem`, but
  its type was the raw `Jolt.PhysicsSystem` under the wrapper's name) and is renamed the same way,
  with no deprecated alias since it isn't part of the documented public API surface. Every internal
  call site - `constraint-system.ts`, `@react-three/jolt-controllers`' `character-controller.ts` and
  `vehicle-manager.ts` (which reached the raw system through `this.physicsSystem.physicsSystem`) -
  now reads `joltPhysicsSystem` directly instead of chaining through the deprecated getter.
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
- e2f8619: Fix the `vec3` / `quat` conversion helpers handing back the caller's own Jolt object (issue #76).
  
  `vec3.jolt()`, `vec3.rjolt()` and `quat.jolt()` returned their argument unchanged when it already
  was a Jolt object, so the ~14 call sites that destroyed the result were freeing memory Jolt (or
  the caller) still owned - a use after free that surfaced as unrelated out of bounds errors much
  later. They now always return a new object the caller owns, and the ownership rules are documented
  on each helper.
  
  Also in this change:
  
  - `vec3.jolt(0, 1, 2)` returns `(0, 1, 2)`; a zero first component no longer reads as "no
    argument" (the same bug was in `vec3.rjolt()` and `vec3.three()`).
  - `quat.jolt(undefined)` returns the identity rotation instead of throwing.
  - New `withJolt()` / `withRJolt()` / `withQuat()` scoped helpers that construct, call and destroy,
    and a `joltScratch` shared scratch object for per-frame code that passes a vector to a Jolt API
    which copies it.
  - The `BodyState` setters (`position`, `rotation`, `velocity`, `angularVelocity`, `applyForce`,
    `applyTorque`, `addImpulse`, `moveKinematic`), the `CharacterControllerSystem` setters and
    `generateJoltMatrix()` no longer allocate on the WASM heap at all.
  - `generateJoltMatrix()` returns a real `RMat44` copy. The WebIDL binder returns a pointer to a
    single static temporary from "by value" returns, so the matrix used to be silently rewritten by
    the next caller, and destroying it freed memory the binder owns.
  - Leaks fixed at the call sites: `PhysicsSystem.setGravity()`, `ShapeCollider.setJoltMatrix()`
    (one transform per frame), `RaycastHit`/`ShapecastHit.impactNormal`, the hinge constraint axes,
    `SetMassAndInertiaOfSolidBox` for dynamic trimeshes, `VehicleManager.setPosition()` and the two
    wheel vehicle's wheel position.
- 4754cc7: Real `PhysicsSystem.destroy()` teardown, unlimited concurrent worlds, and a deliberate shape for
  the module singleton (issues #162, #176, #35).
  
  **`PhysicsSystem.destroy()` now walks the world** instead of freeing the `JoltInterface` and
  stopping. In order: registered disposables → constraints → bodies → event subscriptions →
  the `JoltInterface` → the Jolt listener objects (`bodySystem.destroy()`) → the shared
  `joltScratch` vectors, but only when the last world on the module is going. It is idempotent and
  every wasm-facing method checks `destroyed` first, so a second `destroy()`, a late frame callback
  or a `gravity` effect that fires after unmount are all no-ops rather than wasm traps.
  
  **`<Physics>` defers that teardown past the React commit.** React runs a parent's effect cleanup
  *before* its children's, so `<Physics>` used to free the world out from under every
  `<RigidBody>`, `useConstraint` and controller below it - each of those then cleaned up against a
  dead world and simply skipped its `destroy()`, leaking everything it owned. The unmount cleanup
  now schedules the real teardown on a microtask, guarded against a remount (StrictMode) putting a
  world back in the meantime, so children tear themselves down first against a live world.
  
  **The three-world cap is gone.** Every `PhysicsSystem` owns exactly one `JoltInterface` and frees
  its registry slot in `destroy()`. Mounting a fourth `<Physics>` used to silently hand it the
  *first* world's interface, so two components shared bodies without either knowing, and the
  loser's filter tables were orphaned. Worlds are still not free - each costs about 20MB of the
  jolt-physics build's fixed 128MB heap, so roughly six fit at once - so the constructor now checks
  the remaining heap and throws an actionable error instead of letting emscripten `abort(OOM)` kill
  the module for the rest of the page.
  
  **New API**
  
  - `PhysicsSystem.registerDisposable(fn | { destroy() })` ties an object's lifetime to the world
    and returns an unregister. `CharacterControllerSystem`, `CameraRigManager` and `VehicleSystem`
    register themselves, so a world that goes away takes them with it even when nothing unmounted
    the component that made them.
  - `PhysicsSystem.interfaceId` / `destroyed` / `disposableCount`.
  - `JoltModule` (the old `Raw`, renamed per #35 - `Raw` is still exported as an alias of the same
    object, so `Raw.module` keeps working), plus `getJoltModule()` and `free()` exported from the
    index.
  - `JoltModule.registerInterface` / `getInterface(id)` / `releaseInterface(id)` / `interfaceCount`
    replace `Raw.joltInterfaces`, which was keyed by the owning component's React `useId()` and so
    grew a new entry on every remount. Ids come from a counter that only goes up and are never
    reused.
  - `BodySystem.removeAllBodies()`.
  - `deferWorldDestroy` / `flushDeferredWorldDestroys` for anything driving worlds outside React.
  
  **Breaking:** `Raw.joltInterfaces` and `PhysicsSystem.maxInterfaces` are gone; nothing in the
  library read them from outside `physics-system.ts`. `PhysicsSystem`'s constructor argument is now
  a debug label only (it used to be the interface cache key) and `destroy()`'s argument is ignored,
  so `new PhysicsSystem(pid)` / `destroy(pid)` still compile and do the right thing.
  
  **Also fixed**
  
  - `NUM_OBJECT_LAYERS` was 3 while `Layer` had four members, so
    `MapObjectToBroadPhaseLayer(Layer.RIG, ...)` wrote past the end of a three element array and the
    pair filter's bit indices aliased unrelated layer pairs. It is now derived from `Layer` itself,
    and `Layer.KINEMATIC` is explicitly mapped (issue #95).
  - `Shapecaster` never freed its default `SphereShape`: `RShapeCast` stores a raw pointer to the
    shape rather than a `RefConst`, so nothing else was ever going to. It now takes a reference in
    the constructor and releases it in `destroy()`, the same way `ShapeCollider` does.
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
- Updated dependencies [0cc74f7]
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
  - @react-three/jolt-addons@0.1.0
