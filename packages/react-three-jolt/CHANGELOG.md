# @react-three/jolt

## 0.1.0

### Minor Changes

- 3ed5d30: Add `<Attractor>` and `useAttractor()` (#159): a point that pulls - or, with a negative
  `strength`, pushes - every dynamic body within `range` of it, with rapier's three falloff
  curves (`static`, `linear`, `newtonian`) and its `gravitationalConstant`, so a
  `@react-three/rapier` scene ports across unchanged.
  
  - Runs from `useBeforePhysicsStep` (#157), so the force is applied once per physics **substep**
    rather than once per rendered frame. A frame may run zero, one or five substeps, and per
    substep is the only place a force means a fixed amount of momentum.
  - Renders a `<group>`, so it can be nested, animated or parented to a moving object: its
    **world** position is what is used, re-read every substep.
  - Extra props over rapier's: `enabled`, `mode` (`'force'` - the default and frame rate
    independent - or `'impulse'`, which is what rapier does), `group` / `filter` to restrict which
    bodies are attracted, and `activate` (default on), which wakes sleeping bodies in range. That
    last one matters: Jolt never clears the force accumulated on a sleeping body, so without it an
    attractor's pull would go off all at once whenever something else happened to wake it.
  - Zero allocations per step - the body map is walked with a hoisted callback, the parameters
    live in a mutable block rather than in the callback's closure, and the force goes through the
    shared `joltScratch` vector.
- b701bb2: Opt-in activation on `BodyState` setters (#167), and an opt-in `matrixAutoUpdate={false}` frame
  sync optimisation (#168).
  
  **#167** - `position`, `rotation`, `velocity`, `angularVelocity`, `scale`, `group` and `subGroup`
  used to force a sleeping body awake unconditionally. A new `bodyState.activateOnChange` flag
  (and `<RigidBody activateOnChange>`) controls that per body, defaulting to `true` - today's
  always-wake behavior, so nothing changes for existing code. Turn it off to bulk-reposition
  sleeping bodies (e.g. re-laying out sleeping scenery) without waking every one of them. Each
  setter also gained a method form taking a one-call `{ activate }` override that wins over the
  flag: `setPosition`, `setRotation`, `setVelocity`, `setAngularVelocity`, `setScale`, `setGroup`,
  `setSubGroup` (the existing `position =`, `rotation =`, etc. property setters keep working, and
  now forward to these with the default activation). A static body never activates regardless of
  either flag - activating one asserts inside Jolt and means nothing, since it is never simulated.
  
  - `bodySystem.setBodyCollisionGroup(handle, group?, subGroup?, activate = true)` gained the
    trailing `activate` parameter that `BodyState.group`/`subGroup` now go through.
  - `Body.SetLinearVelocity`/`SetAngularVelocity` never woke a sleeping body to begin with (no
    `EActivation` parameter exists on that call); `BodyInterface.SetLinearVelocity`/
    `SetAngularVelocity` always does. Which one gets called is what implements the velocity/
    angularVelocity override.
  
  **#168** - `bodyState.matrixAutoUpdate = false` (and `<RigidBody matrixAutoUpdate={false}>`)
  makes the physics frame sync write the body's pose straight into `object.matrix` (and flag
  `matrixWorldNeedsUpdate`) instead of `object.position`/`object.quaternion`, and turns off three's
  own per-object `Object3D.matrixAutoUpdate` so nothing recomposes the matrix from those a moment
  later. `PhysicsSystem.syncBodyToObject` also skips decomposing the already-composed local matrix
  back into position/quaternion/scale for this path, since there is nothing left to decompose it
  for. Default is unchanged (`true`, three's normal behavior). Only correct when the object's
  parent transform is stable between physics steps - the scene root, or a group that never moves,
  rotates or scales - the same constraint every synced pose already has via
  `BodyState.invertedWorldMatrix`, captured once at body creation.
  
  Measured with 1000 dynamic bodies stepped for 120 frames (`test/matrix-auto-update.test.ts`):
  roughly a 4-6% reduction in sync-loop time with `matrixAutoUpdate=false`, dominated by skipping
  three's `Object3D.updateMatrix()` and the extra `Matrix4.decompose()` per body. Numbers are
  machine dependent; the benchmark logs them rather than asserting on them.
- 3af73e3: Named collider components and `<RigidBody colliders>` (issue #155).
  
  Eight thin, typed wrappers over `<Shape>` — `<CuboidCollider>`, `<BallCollider>`,
  `<CapsuleCollider>`, `<CylinderCollider>`, `<ConeCollider>`, `<ConvexHullCollider>`,
  `<TrimeshCollider>` and `<HeightfieldCollider>` — each with a rapier-compatible `args` tuple.
  `args` are **half extents** (`<CuboidCollider args={[0.5, 0.5, 0.5]}>` is a 1×1×1 cube, the
  capsule/cylinder/cone take a half height); `<Shape>`'s own props keep three.js semantics and the
  conversion lives only in the wrappers. Jolt has no cone shape, so `<ConeCollider>` is a
  `taperedCylinder` with a top radius of zero. `<HeightfieldCollider args={[samples, size, scale]}>`
  needed a descriptor path from raw samples, so `ShapeOptions` gained
  `heights`/`sampleCount`/`heightScale`/`materials`/`materialIndices`.
  
  `<RigidBody colliders>` takes `false` (no automatic shape; the meshes are decoration and the
  colliders are the body) or `'cuboid' | 'ball' | 'hull' | 'trimesh'` — rapier's spelling of this
  library's `AutoShape` names — and defaults to today's autodetection. A body with both meshes and
  colliders combines them into one compound, meshes first.
  
  To make that work, `<RigidBody>` is now a compound *host*: when it has to combine several shapes
  (sibling colliders, an offset collider, or a collider beside a mesh) its children register plain
  `ShapeDescriptor`s with it and it composes and owns the compound, instead of every child calling
  `setActiveShape` and the last one silently winning. When there is nothing to combine — one
  `<Shape>`, or meshes only — nothing changes and the child still owns the body's shape, which is
  what keeps a `<Shape dynamic>` directly under a body editable in place (#108). A lone collider
  with a `position`/`rotation` now becomes a one-child compound, so its offset is honoured rather
  than dropped as a root transform.
  
  `sensor`, `friction` and `restitution` on a collider are body-level properties in Jolt and say so
  out loud. Jolt's sensor flag is `Body::SetIsSensor`, with no per-sub-shape equivalent: a body
  whose colliders *all* ask for `sensor` (and whose meshes contribute nothing solid) is made a
  sensor with a warning, and a mix of sensor and solid colliders throws with a message naming the
  counts. `friction`/`restitution` warn and are written to the body; `<RigidBody friction>` wins
  when both are set.
  
  New docs page `docs/api/colliders.mdx`, linked from the RigidBody page.
- 83ad330: Per-body collision groups, changeable at runtime (issue #95).
  
  `BodySystem.standardCollisionGroup` was a single shared `Jolt.CollisionGroup` handed to every
  body that asked for one, and the `BodyState` group setters were stubbed out on the belief that
  `SetCollisionGroup` wasn't exposed to JS. jolt-physics 1.1.0 has
  `BodyInterface.SetCollisionGroup(BodyID, CollisionGroup)`, so:
  
  - Every grouped body now owns its own `CollisionGroup`, created in `createBody` (or lazily by
    the setters for a body that didn't ask for a group up front) and destroyed in `removeBody`.
  - `BodyState.group` / `BodyState.subGroup` (and the new `collisionGroup` / `collisionSubGroup`
    aliases) are live: the setters push the group through `BodyInterface.SetCollisionGroup` and
    wake the body, so they take effect on the next step instead of only at body creation.
  - `<RigidBody group subGroup>` are reactive, and `group={0}` / `subGroup={0}` are no longer
    swallowed by a truthy check.
  - The hand-rolled `GroupFilterJS` is replaced by a `GroupFilterTable`, exposed through
    `bodySystem.setGroupCollision(a, b, enabled)` / `disableCollision(a, b)` /
    `enableCollision(a, b)` / `isCollisionEnabled(a, b)`. Sub group ids are range checked against
    `bodySystem.subGroupCount` (default 256); the old filter indexed a fixed 3-element array with
    arbitrary user ids, and Jolt itself only bounds checks the table with an assert that is
    compiled out of the release wasm.
  - New `BodySystem.destroy()` frees the collision groups and releases the filter table.
  
  Collision groups are the "this specific pair of objects shouldn't collide" filter; object
  layers remain the broad category filter and are unchanged. **Breaking:** the previous
  hard-coded sub group 0/1/2 semantics are gone — a group's sub groups all collide until you call
  `disableCollision`. See the rewritten Group Filtering section of the README.
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
- 53f9bdb: Fixed #211:
  
  - `dynamicMeshStrategy` (#112) is now reachable from the component tree: `<RigidBody
    dynamicMeshStrategy>` sets it per body, `<Physics defaultDynamicMeshStrategy>` sets a world
    wide fallback (a per-body value always wins). Previously the only way to opt into `'error'` was
    to build the body yourself through `bodySystem.addBody`.
  - `AutoShape` and `ShapeType` are unified into one `ShapeType` union - `AutoShape` is now a
    deprecated alias of it, so `<Shape type>`, `<RigidBody shape>` and `<Physics defaultShape>` all
    accept every tag (including `'mutableCompound'`, `'scaled'` and `'offsetCenterOfMass'`, which
    `AutoShape` used to reject at the type level even though the shape pipeline already understood
    them). `'compound'` remains a documented alias of `'staticCompound'`, normalised by the newly
    exported `normaliseShapeType`.
  - `describeShapeFromOptions` gained the `'scaled'`/`'offsetCenterOfMass'` cases it was missing -
    both previously fell through to a unit box descriptor rather than building the decorator shape
    (or erroring). They take a new `child`/`decoratorScale`/`centerOfMass` on `ShapeOptions`.
- 4b82a93: Dynamic trimesh bodies (#112): Jolt cannot simulate a dynamic body with a `MeshShape` - mesh vs
  mesh has no collision, so the body falls through the world and ends up with a `NaN` position. A
  `trimesh` on a dynamic body is now converted to a convex hull of the same points, with a
  `devWarn`. The new `dynamicMeshStrategy` body option picks the behaviour: `'convex'` (default),
  `'error'` to throw, or `'decompose'` (reserved). The mass/inertia override for such a body is
  taken from the converted shape's real `GetMassProperties()` instead of a fabricated solid box.
- 577228c: Activation accounting and steady state detection (issue #52).
  
  ```tsx
  <Physics
      onSettled={() => console.log('everything is asleep')}
      onActivityChange={(active, total) => setLabel(`${active}/${total} awake`)}
  />
  ```
  
  `BodySystem` now maintains `activeBodyCount` from the activation listener — incremented on
  activate, decremented on deactivate — alongside `simulatedBodyCount` and `isSettled`.
  `activityChange` is emitted when the count changes and `settled` when it crosses to zero, both
  after that step's sleep/wake events, so a handler that counts them agrees with the totals. This
  is edge triggered off a single integer, so it costs one comparison per step rather than a
  per-frame scan of every body.
  
  A world that was never active does not announce itself settled, and removing the last awake body
  settles the world (`RemoveBody` deactivates synchronously, which is counted).
- f0d751d: Event props on `<RigidBody>`, `<InstancedRigidBody>` and `<Physics>` (issues #32, #21, #156),
  plus the `<Physics module>` hook-order fix (#137).
  
  ```tsx
  <RigidBody
      onCollisionEnter={(e) => console.log(e.other.object?.name, e.normal)}
      onCollisionPersist={…} onCollisionExit={…}
      onSensorEnter={…} onSensorExit={…}      // aliases: onIntersectionEnter/Exit
      onSleep={…} onWake={…}
      onContactValidate={(e) => false}         // synchronous, rejects the contact
  />
  <Physics onCollisionEnter={…} onCollisionExit={…} onSensorEnter={…} onSleep={…} onWake={…} />
  ```
  
  - `<RigidBody>`'s listener effect **never registered anything**: its dependency array read
    `rigidBodyRef.current`, a mutable ref, which is not reactive — on the render that created the
    body the effect had already run with `undefined`. The body is now React state, each handler is
    its own effect keyed on the body instance, and the cleanup is the unsubscribe handle rather
    than a removal by function identity (which could never match the inline arrows people
    actually pass). `useUnmount` is null-guarded, so a `<RigidBody>` whose shape children never
    resolved no longer throws on unmount.
  - Handler identity is deliberately not a dependency, so an inline arrow does not resubscribe on
    every render, and StrictMode's mount → cleanup → mount leaves exactly one subscription.
  - `<Physics>` world handlers fire **once per pair** with `target` set to the lower handle, so a
    world-wide counter is right without dividing by two. Jolt's contact listener is global, which
    makes this the cheap path and the per-body props the fan-out.
  - `<InstancedRigidBody>` takes the same props; the payload's `target.index` says which instance.
  - `JoltContext` gains `events`, the world emitter.
  - The old `onContactAdded` / `onContactRemoved` / `onContactPersisted` props are kept as
    deprecated aliases for `onCollisionEnter` / `onCollisionExit` / `onCollisionPersist`. They now
    receive the new payload; their declared type never matched what was dispatched, so nothing
    that worked before breaks.
  - `<Physics>` called `suspend()` inside an `if`/`else` on the `module` prop, so toggling that
    prop changed the number of hooks between renders. It is now one unconditional call keyed on
    `module ?? 'default'` (#137).
  - New exports: the payload types (`CollisionTarget`, `CollisionPayload`, `CollisionEnterPayload`,
    `CollisionExitPayload`, `SensorPayload`, `ActivationPayload`, `ValidatePayload`),
    `BodyEventMap`, `WorldEventMap`, `Unsubscribe`, `Emitter`, `useBodyEvent`, `useWorldEvent`.
    The dead `BodyEvents` / `WorldEvents` types in `types.ts` — unreachable, and describing
    signatures that were never dispatched — are deleted.
  - New `packages/react-three-jolt/docs/events.md` documents the whole surface, the payload
    reuse contract, the ordering guarantees, Jolt behaviours that surprise people (a body going
    to sleep closes its contacts), and the answers taken for the RFC's five open questions.
- dd435cb: Rewrite the contact pipeline: sub-shape pair refcounting and two-tier dispatch.
  
  Jolt fires its `ContactListener` from inside `joltInterface.Step()`, where adding, removing or
  mutating a body is illegal and where the `ContactManifold` / `ContactSettings` pointers are into
  memory that is reused the moment the step returns. The listener now does only what must be
  synchronous — the `ValidateResult` return, `ContactSettings` writes, and the pair refcount — and
  writes everything user facing into typed arrays. `BodySystem.flushEvents()` dispatches those
  between `Step()` and `afterStep`, so a handler may do whatever it likes.
  
  - **Enter/persist/exit come from sub-shape pairs** (`systems/contact-events.ts`), not body
    pairs. Jolt guarantees one `OnContactRemoved` per `OnContactAdded` for the same
    `SubShapeIDPair`; the first one opening a pair is the enter, the last one closing it is the
    exit, everything between is a persist. This **retires the 900 ms `contactThreshold`
    debounce**, which only existed because a body-level refcount flickered when a manifold split
    between sub-shapes and made a bouncing ball's legitimate re-collisions disappear.
    `BodyState.contactThreshold` and `contactTimestamps` are gone.
  - **Payloads** are `{ target, other, flipped, contactCount }` plus flattened manifold data
    (`normal`, `penetration`, `points`, `pointCount`) for enter and persist. No Jolt object ever
    reaches user code. Payloads are pooled and reused; under `<Physics debug>` they are poisoned
    after dispatch so retaining one fails loudly.
  - **Sensors** route to `sensorEnter` / `sensorExit` and are kept out of the collision channel.
  - **Unknown bodies** — the vehicle chassis and the character rig anchor are created straight
    through the body interface — resolve to `body: undefined` instead of being dropped, and no
    longer throw from inside the WASM callback (`body-system.ts` used to dereference
    `getBody(...)` unguarded).
  - `Body.SetUserData(handle)` is stamped at creation, so the activation listener resolves its
    body from `inBodyUserData` with no `wrapPointer` and no map lookup. A new `bodies` map makes
    `getBody` one lookup instead of three.
  - **Zero cost when unused**: each `BodyState` exposes an `eventMask`, the world emitter another;
    if nothing in the pair is listening, no manifold or settings wrapper is built at all. The pair
    refcount behind `isContacting()` is still maintained.
  - `BodyState` gains `events`, `on(type, fn)` and `onCollisionEnter/Persist/Exit`,
    `onSensorEnter/Exit`, `onSleep`, `onWake`, `onContactValidate` — all returning an unsubscribe
    — and `dispose()`, which closes every open pair (peers get their exit) and drops the
    listeners, so a recycled Jolt handle can no longer inherit the previous body's contacts.
    `addContactListener` / `addActivationListener` return an unsubscribe and are deprecated;
    `removeContactListener` now removes the listener from every channel it was added to, where
    its `else if` chain used to remove it from only the first.
  - **Lifecycle**: the `ContactListenerJS` and `BodyActivationListenerJS` objects are instance
    fields rather than locals, and `PhysicsSystem.destroy()` frees the `JoltInterface` first and
    the listeners second — the other order is a use after free, because Jolt's physics system
    holds raw pointers to them. `BP_LAYER_RIG` was being leaked and is now freed with its two
    siblings.
  - `activateMotionSource` keeps its signature but is split: the surface velocity half stays
    synchronous (it writes `ContactSettings`), while the impulse half now goes through
    `pendingActions` instead of calling `addImpulse` — which goes through the body interface —
    from inside the step.
  
  **Breaking:** contact handlers receive one payload object instead of
  `(handle1, handle2, manifold, settings, count, context)`; `BodyState.contactAddedListeners` /
  `contactRemovedListeners` / `contactPersistedListeners` / `activationListeners` are replaced by
  `BodyState.events`.
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
- d4c9e8d: Sub-shape identity on contact payloads, and per-`<Shape>` event props (issue #13, remainder).
  
  ```tsx
  <RigidBody onCollisionEnter={(e) => console.log(e.targetSubShape.descriptor?.name)}>
      <Shape>
          <Shape name="left"  size={[8, 1, 8]} position={[-6, 0, 0]} onCollisionEnter={…} />
          <Shape name="right" size={[8, 1, 8]} position={[ 6, 0, 0]} onCollisionEnter={…} />
      </Shape>
  </RigidBody>
  ```
  
  - `CollisionPayload` gains `targetSubShape` / `otherSubShape`:
    `{ id, index, userData, descriptor }`. They are **getters**, resolved on first read, so a
    handler that never asks costs no shape walk per contact; the `SubShapeRef` is pooled like the
    rest of the payload. `index` is which child of the body's top-level compound was hit,
    `userData` the tag stamped on the `<Shape>`/descriptor that produced it at any nesting depth,
    `descriptor` the description it was built from.
  - `createShapeSettings` now stamps every descriptor's `userData` onto the **shape**, not just
    onto the compound's per-sub-shape record. `CompoundShape::GetSubShapeUserData` recurses into
    the child and returns the *child shape's* user data, so the shape is the only place a contact
    can read it back from; both are written now.
  - New in `shape-system.ts`: `subShapeIndexFromId`, `subShapeUserData`, `descriptorForSubShape`,
    `hasSubShapes`, `EMPTY_SUB_SHAPE_ID`. `CompoundShape::GetSubShapeIndexFromID` is not in the
    jolt-physics binding, so `subShapeIndexFromId` redoes its arithmetic (pop
    `ceil(log2(numSubShapes))` bits off the low end) against the body's shape — which is also what
    distinguishes "child 1 of a two-child compound" from "no sub-shape at all", since Jolt pads a
    `SubShapeID`'s unused high bits with ones and both are `0xFFFFFFFF`.
  - `<Shape>` takes `userData`, `name`, and `onCollisionEnter` / `onCollisionPersist` /
    `onCollisionExit` / `onSensorEnter` / `onSensorExit` scoped to that sub-shape. They subscribe
    on the parent body and filter by sub-shape, so they cost the body's handler plus one compare,
    and nothing at all when unused. A `<Shape>` with handlers and no explicit `userData` is
    assigned one automatically, from the top of the 32-bit range.
  - `ShapeDescriptorBase` gains `name` (carried on the descriptor only; it never reaches Jolt).
  - `BodyState.shapeDescriptor` keeps the description a body's shape was built from. `<Shape>` and
    the automatic `describeObject` path both set it; `addBody(object, { shape })` takes a new
    `shapeDescriptor` option for callers that build a shape themselves.
  - New `OneWayPlatform` demo in `apps/examples`: `onContactValidate` rejecting contacts from
    below, and a three-panel compound floor where each `<Shape>` lights up only for its own hits.
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
- e64dfa0: Per-heightfield and per-quad friction (#46).
  
  `<Heightfield>` and `bodySystem.addHeightfield(mesh, options)` now take `friction` and
  `restitution` for the whole field, and a list of surfaces for individual quads:
  
  ```tsx
  <Heightfield
      samples={samples}
      size={128}
      materials={[
          { name: 'ice', friction: 0.02 },
          { name: 'grip', friction: 1.5 }
      ]}
      materialIndex={(x) => (x < 0 ? 0 : 1)}
  />
  ```
  
  `materials` is built into the shape's `PhysicsMaterialList` and `materialIndex` (a callback
  given each quad's centre, or a ready made `(size - 1)^2` array) into `mMaterialIndices`, so Jolt
  resolves the right material for any contact.
  
  Jolt's `PhysicsMaterial` carries no friction of its own - its JS binding is a constructor and
  the ref-count methods, and friction always comes from the two bodies - so the new
  `SurfaceMaterialTable` remembers which material stands for which `{ friction, restitution, name }`
  and the contact listener writes `ContactSettings.mCombinedFriction` synchronously, inside the
  step (a new internal `EventBit.surfaceMaterial`, alongside the existing motion-source hook).
  Bodies without materials are untouched and pay nothing.
  
  Ownership, verified at runtime: the `PhysicsMaterialList` is copied into the settings and again
  into the shape, so the list is destroyed after `Create()` while the materials themselves are
  ref-counted by the shape and must never be destroyed by hand. Adding and removing a heightfield
  with materials is allocation net-zero.
- e64dfa0: Heightfield generation without an image (#45).
  
  `<Heightfield>` now takes the terrain directly, synchronously, and with no loader involved:
  
  ```tsx
  <Heightfield samples={samples} size={64} scale={[2, 20, 2]} />
  <Heightfield generator={(x, z) => Math.sin(x * 0.1) * 4} size={64} />
  ```
  
  A new `heightfield` utilities module (exported from the package root) backs it:
  
  - `generateHeightfield({ size, noise, octaves, frequency, amplitude, lacunarity, gain, seed,
    spacing })` builds the samples from noise. Deterministic for a seed.
  - `psrdnoise2` / `simplex2` / `fbm2` - the psrddnoise GLSL that shipped next to the heightfield
    code is now also a CPU TypeScript port (the `.glsl` files stay for GPU use), plus classic 2D
    simplex noise. `noise` also accepts your own `(x, z) => value`.
  - `heightfieldToGeometry(samples, size, scale)` builds the matching `PlaneGeometry` - already
    laid flat, one vertex per sample - so what is drawn and what is simulated are the same
    numbers.
  - `samplesFromGenerator`, `heightfieldMaterialIndices`, `validateHeightfieldSize`.
  
  Every entry point enforces the sample-count rule from #152 (`getValidatedHeightfieldSampleCount`):
  a square grid, a multiple of the block size, at least two blocks per edge.
  
  Generation is synchronous - there is no worker. A 512x512 field is a few milliseconds; generate
  anything larger off the render path and hand it in through `samples`.
  
  Also fixed: the heightfield descriptor's sample spacing was `planeWidth / sampleCount` where
  `sampleCount` samples span `sampleCount - 1` segments, so the physics field was one sample wider
  than the mesh that was drawn. It is now `planeWidth / (sampleCount - 1)`, with
  `addHeightfield`'s centring offset derived from the same numbers, and the depth of a
  non-square plane is honoured on z.
- 1786080: `<InstancedRigidBodyMesh>` is now `<InstancedRigidBodies>`, matching the component of the same
  name in `@react-three/rapier` (issue #37, sibling-library parity). Same props, same behaviour —
  only the name changed, so moving between the two libraries is one less thing to relearn.
  
  The old name is still exported as a deprecated alias, along with
  `InstancedRigidBodyMeshProps` → `InstancedRigidBodiesProps`. Both will be removed before 1.0.
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
- 5de180b: Fix kinematic motion and instanced spawners starting empty (#194).
  
  - `moveKinematic(position, rotation?, deltaTime?)`: `deltaTime` now defaults to the world's step
    length (`physicsSystem.timeStep`, or the new `physicsSystem.lastDelta` when the world steps with
    `timeStep="vary"`) instead of `0`. Jolt derives the body's velocity from
    `(target - current) / deltaTime`, so the old default produced no motion at all. `rotation` is
    optional and defaults to the body's current rotation, rather than straightening it out.
  - New `setKinematicTarget(position, rotation?)` / `clearKinematicTarget()`: the target is sticky
    and re-applied at the top of every substep with that substep's real dt, so a platform converges
    on its target however many steps a frame runs, and riders see a steady velocity instead of one
    lurch per frame. Nothing is iterated when no body uses it.
  - Riders on a driven platform wake up and are carried with stock body settings (covered by a
    test); raising `friction` above Jolt's slippery default of `0.2` is still worth doing, and is
    now documented on the RigidBody page.
  - `<InstancedRigidBodyMesh count={0}>` mounts and grows to N.
- 5770bd2: Mutable compound shapes (#108): a `{ type: 'mutableCompound' }` descriptor now builds a real
  `MutableCompoundShape`, and `<Shape dynamic>` uses it. New `addSubShape` / `removeSubShape` /
  `modifySubShape` helpers edit such a compound in place, and the matching `BodyState` methods also
  run `AdjustCenterOfMass()` + `BodyInterface.NotifyShapeChanged`, so the body's mass properties and
  broadphase bounds follow. A child `<Shape>` mounting, unmounting or moving inside a
  `<Shape dynamic>` now goes through that runtime path instead of rebuilding the whole compound.
- 37de18b: Object scaling and `ScaledShape` (#40): a scaled mesh below a described object now produces a
  `scaled` descriptor, so the collider matches what is on screen, and `describeShape` takes an
  `applyObjectScale` option to bake the root object's scale in too. `BodyState.scale` accepts a
  plain number again (`inScale instanceof Number` was always false, so `body.scale = 2` used to
  apply a NaN scale), supports non-uniform scale wherever Jolt allows it, and falls back to a
  uniform scale with a `devWarn` on shapes that cannot take one (sphere, capsule, tapered capsule).
  `<RigidBody scale>` is applied while the body is created rather than a frame later. The
  `offsetCenterOfMass` descriptor is implemented via `OffsetCenterOfMassShapeSettings`.
- 3ed5d30: `<Physics debug>` now draws a wireframe of **every** collider in the world (#158), replacing the
  per body `debug` boolean as the way to see what the simulation actually has in it.
  
  - One wireframe per body, built from the body's real Jolt shape via `createMeshFromShape`, so it
    shows the convex hull a dynamic trimesh fell back to, the compound that was assembled and the
    scale that was really applied - not the three.js geometry that was handed in. Compounds, mesh,
    hull and heightfield shapes all work.
  - Coloured by motion type: grey static, blue kinematic, green dynamic, yellow sleeping, magenta
    sensor. Constraints are drawn as lines between their anchor points, and `<Debug showContacts>`
    adds the last step's contact points and normals.
  - Geometry is cached per Jolt shape pointer, so a thousand bodies sharing one shape are
    triangulated once; a `MutableCompoundShape` edited in place invalidates its entry through the
    new `shapeChanged` world event.
  - Membership is event driven, off three new `physicsSystem.events` types - `bodyAdded`,
    `bodyRemoved` and `shapeChanged`. Bodies that already exist are backfilled when the overlay is
    created, so toggling `debug` on for a running scene works; toggling it off disposes every
    geometry and material and removes all of the per frame work.
  - Render only: it reads body poses and shapes and writes three.js matrices, from `useFrame` and
    never from a step callback, and it draws the same interpolated pose the bodies' own meshes get
    (`physicsSystem.frameAlpha` / `frameInterpolating` are now public).
  - Mount `<Debug>` directly for its own options (`colors`, `showConstraints`, `showContacts`,
    `contactNormalLength`, `maxContacts`, `depthTest`, `updatePriority`).
  
  Jolt's own `DebugRenderer` is deliberately not used: it only exists in jolt-physics' debug
  builds and 1.1.0 ships no JS binding for it. A `DebugRendererJS` path could be added later
  without changing this component's surface.
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
- 42fdc45: Closes #48 and #47.
  
  **#48 - debug markers now orient along the hit surface normal.** `Raycaster.drawMarker()`
  previously always drew a world-axis-aligned cross regardless of what it hit
  (`// TODO: Apply the normal`). It now draws a small ring/disc plus a normal-indicator line,
  oriented with `Quaternion.setFromUnitVectors((0, 1, 0), hit.impactNormal)`.
  
  Along the way, fixed the three.js side of the leak issue #173 reported:
  `drawDebuggingLine`/`drawDebuggingPoints`/`drawDebuggingMarkers` allocated a brand new
  `THREE.BufferGeometry`/`Material`/`Object3D` on **every single call**, and `cast()` calls them on
  every cast while `isDebugging` is on - so a raycaster that draws its debug view every physics step
  grew `debugObject.children` (and leaked geometries/materials) without bound. All three are now
  pooled per raycaster: one shared material per debug-drawing type, geometry reused via
  `setFromPoints`/`setAttribute`, and markers pooled one-per-hit-index so repeated `drawMarker()`
  calls (the common case) update an existing group's transform instead of allocating anything.
  `destroy()` and `clearDebugging()` dispose the pools.
  
  **#47 - `useMouseRaycaster(options)`.** New hook in `hooks/use-raycasters.tsx`: builds a
  world-space ray from the pointer and camera (via `useThree`) every frame (default) or on real
  `pointermove` events (`mode: 'pointermove'`), runs a `Raycaster` (`'closest'` by default) against
  it, and returns `{ raycaster, hit }` where `hit` is a mutable ref updated in place - no React
  state churn on every frame/pointer move. Supports an `onHit` callback, a `type` collector
  override, a `length` override (defaults to `camera.far`), and a `filter` option to swap in custom
  `bpFilter`/`objectFilter`/`bodyFilter`/`shapeFilter` instances. Destroys its raycaster on unmount
  and whenever `type`/`filter` change (not just at unmount, unlike the sibling `useRaycaster`/
  `useAdvancedRaycaster`/`useMulticaster` hooks, which still only free their raycaster at unmount).
  
  Adds regression coverage to `test/raycasters.test.ts` (marker orientation against a tilted box,
  and that repeated `drawMarker`/`cast()` calls don't grow `debugObject.children` or reallocate
  geometry) and a new `test/use-mouse-raycaster.test.tsx` that mounts `<Physics>` for real via
  `@react-three/test-renderer` and asserts a hit against a body centered under the pointer.
- 8351ed4: Unify shape generation behind one typed descriptor pipeline (issues #107, #151).
  
  `systems/shape-system.ts` had three overlapping entry points -
  `getShapeSettingsFromGeometry`, `getShapeSettingsFromObject` and `generateShapeSettings` -
  each with their own idea of how a three.js geometry maps onto a Jolt shape. They are now thin
  wrappers over a single pipeline:
  
  - `describeShape(object | geometry, options)` -> `ShapeDescriptor`, a plain serialisable
    description (type, size parameters, local position/rotation, children for compounds). It
    allocates nothing on the WASM heap and survives `JSON.stringify`.
  - `generateShape(descriptor)` -> `Jolt.Shape`, owned by the caller with a reference count of 1
    and released with `releaseShape`. `createShapeSettings(descriptor)` is available for callers
    that need the settings (compound children, body creation).
  - `descriptorKey(descriptor)` / `stableKey(value)` give a descriptor a stable string identity
    (long vertex arrays are hashed), which is what `<Shape>`'s effects now depend on.
  - `scaleShape(shape, scale)` wraps a shape in a `ScaledShape` (it AddRef()s the inner shape) and
    hands back one reference, the building block for issue #40.
  
  New: explicit descriptors for tapered capsules, cylinders and **tapered cylinders**
  (`TaperedCylinderShapeSettings`, new in jolt-physics 1.1), plus `scaled` and `staticCompound`.
  `mutableCompound` (#108) and `offsetCenterOfMass` are reserved in the descriptor union and throw
  a clear "not implemented yet" error naming the issue.
  
  Fixes along the way:
  
  - a `ConeGeometry` (three keeps its own `{ radius }` parameters) used to become a NaN sized
    cylinder; it is now inferred as a tapered cylinder.
  - cylinders no longer fail to build when they are thinner than the default 0.5 convex radius
    (it is clamped to what Jolt accepts).
  - `generateShapeSettings('box')` with no options no longer throws, and a numeric `size` means a
    cube rather than `(size, NaN, NaN)`.
  - `<Shape>` rebuilt its shape only when `type` changed (#151) and never released anything:
    changing `size`/`radius`/`height`/`scale`/children now replaces the shape exactly once,
    releases the superseded one, and unmounting releases everything it owns. `updateScaleShape`
    is no longer a `console.warn` stub - it wraps the shape in a `ScaledShape`.
  - `BodyState`'s `scale` setter builds its `ScaledShape` through `scaleShape` and releases its own
    reference once the body has taken one.
  
  The old exported names keep working unchanged.
- 071509a: Make frame interpolation real and wire up the `<Physics>` prop surface.
  
  **Interpolation actually interpolates now.** It used to write the previous pose to the
  three.js object, lerp a throwaway vector the `BodyState.position` getter had just
  allocated, discard the result, and then snap the object to the current pose — three
  writes and two allocations per body per frame for the visual result of `interpolate:
  false`. Each `BodyState` now carries a preallocated pose cache (`previousPosition` /
  `currentPosition` / `previousRotation` / `currentRotation`, filled by `capturePose()`
  after every step) and the render frame writes `lerp(previous, current, accumulator /
  timeStep)`. The frame loop no longer allocates at all: no merged body array, no scratch
  `Matrix4` per instanced body, and the `position` / `rotation` getters (which allocate)
  are out of the hot path. Their public behaviour is unchanged.
  
  **`<Physics>` props now reach the system, and stay reactive.** `interpolate` was declared
  and then commented out of the destructure, so it never reached `PhysicsSystem`; `timeStep`
  did not exist as a prop at all, which made the `"vary"` code path unreachable from React.
  Now documented and wired, each with JSDoc:
  
  | prop | default | |
  | --- | --- | --- |
  | `gravity` | `[0, -9.81, 0]` | number (downward magnitude), tuple or `Vector3` |
  | `interpolate` | `true` | |
  | `timeStep` | `1 / 60` | seconds, or `"vary"` |
  | `maxSubSteps` | `5` | new |
  | `paused` | `false` | stops stepping, keeps rendering |
  | `updatePriority` | `0` | `useFrame` priority, typed `number` instead of `any` |
  | `updateLoop` | `'follow'` | |
  | `debug` | `false` | |
  | `defaultBodySettings` | — | |
  | `defaultShape` | — | new, the Jolt answer to rapier's `colliders` |
  
  **The fixed step accumulator is bounded.** It grew without limit, so one long frame queued
  an unbounded number of substeps and each slow frame made the next one slower — the spiral
  of death. Time past `maxSubSteps * timeStep` is now dropped, with a warning under `debug`.
  Negative and `NaN` frame deltas (r3f's scheduler emits a negative one after a clock reset)
  are dropped too rather than poisoning the accumulator.
  
  **`PhysicsSystem.setGravity` no longer leaks** a `Jolt.Vec3` per call, and it accepts
  tuples as well as numbers and vectors. New: `PhysicsSystem.accumulator` (read only),
  `PhysicsSystem.resetAccumulator()`, `PhysicsSystem.maxSubSteps`, and
  `BodySystem.defaultShape`.
  
  Closes #39.
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

- d4eb34a: API polish from issue #210:
  
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
- 9627aaa: `BodyState.mass` reports the mass the simulation actually uses (#201).
  
  The getter read the *shape's* density-derived mass, so a body created with a `mass` option - or
  scaled afterwards - reported a number unrelated to how it behaved. It now reads
  `1 / MotionProperties.GetInverseMass()` for dynamic bodies, and `0` for static and kinematic
  ones, which Jolt treats as having infinite mass (setting it on one is a documented no-op rather
  than a crash).
  
  The setter uses `MotionProperties.ScaleToMass`, which scales the inertia tensor with the mass and
  leaves the body's allowed degrees of freedom alone - the old path pushed a fresh `MassProperties`
  through `SetMassProperties(EAllowedDOFs_All, …)` and quietly unlocked every axis the caller had
  locked. A mass of `0` or less is refused with a warning instead of producing an infinitely heavy
  body.
  
  Body creation applies a `mass` option to **any** dynamic body, by scaling the shape's own mass
  properties; it previously only did so for a trimesh that had been converted to a convex hull. The
  motion-properties accessors (`linearDamping`, `angularDamping`, `gravityFactor`) are now safe to
  touch on a static body.
- 674d8db: #165: broke the `systems/body-state.ts` <-> `systems/body-system.ts` import cycle that rollup's
  build flagged on every build. `body-state.ts` imported `getThreeObjectForBody` (a value) from
  `body-system.ts` even though that function never touches `BodySystem`; `body-system.ts`
  separately has a genuine runtime dependency on the `BodyState` *class* (it constructs
  `new BodyState(...)`), so the two files formed a real cycle in the compiled output.
  
  `BodyType`, `GenerateBodyOptions` and `getThreeObjectForBody` now live in a new
  `systems/body-types.ts`, which neither file needs the other to use. `body-system.ts` re-exports
  all three by name so every existing `from './body-system'` / `from '../systems/body-system'`
  import keeps working unchanged. `body-state.ts`'s only remaining reference to `body-system.ts` is
  `import type { BodySystem } from './body-system'` - type-only, so it no longer appears in the
  compiled module graph at all.
  
  `yarn build`'s rollup step no longer prints a circular-dependency warning for these two files
  (one other, pre-existing and unrelated cycle - `raw.ts` <-> `utils/general.ts`, both a genuine
  mutual runtime dependency - remains and was left alone as out of scope for this fix).
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
- 0704316: `useMount`/`useUnmount` (issue #57): `RigidBody`, `Physics` and `InstancedRigidBodyMesh` now use
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
- 7d5a576: Trim the published README down to install, a short example and links into the new
  documentation site (#99, #29, #30).
  
  The README is listed in the package's `files`, so this changes what ships on npm: the long
  prose sections (the `<Physics>` prop walkthrough, RigidBody/BodyState, instancing, raycasting,
  heightfields, motion sources, `useJolt`) now live as proper pages under `docs/`, published to
  GitHub Pages by `.github/workflows/docs.yml` through the shared
  [pmndrs/docs](https://github.com/pmndrs/docs) generator. The collision "Group Filtering" section
  and the project outline are kept in the README.
  
  New documentation (no runtime changes): Introduction, Installation (peers, Vite, Next.js
  Turbopack/webpack, Jolt build variants), Physics, RigidBody, Shapes, Queries, Collision groups &
  layers, Controllers, Addons, Memory & lifecycle, SSR & Suspense, Migration, Contributing.
- 75e858a: Fix the one relative documentation link left in the published README.
  
  `README.md` is listed in the package's `files`, so it ships to npm on its own — a link to
  `../../docs/getting-started/installation.mdx` only resolves inside a repository checkout. It now
  points at the published page like every other doc link in the file
  (`https://pmndrs.github.io/react-three-jolt/getting-started/installation#choosing-a-jolt-build`).
  
  Documentation only, no runtime changes. The rest of this pass updated the `docs/` site to match
  the code that landed in wave 2 (events, the shape descriptor pipeline, collision groups,
  `<Vehicle>`, the camera rig options, `useMouseRaycaster`, the gamepad poller) and folded
  `packages/react-three-jolt/docs/events.md` into the RigidBody and Physics pages.
- c3e11a7: Fix `Raycaster`/`AdvancedRaycaster` collector lifecycle and memory bugs in
  `systems/queries/raycasters.ts`:
  
  - A `Raycaster` in the default `"closest"` mode never reset its collector between
    casts, so after the first hit `HadHit()`/`mHit` and the collector's early-out
    fraction stayed put and every later `cast()` silently returned the stale first
    hit instead of re-querying. This was the root cause of the "Raycaster Many" demo
    (issue #60) showing rays offset/stuck relative to the geometry they were meant
    to be hitting; `Shapecaster` already reset unconditionally and is now matched.
  - `AdvancedRaycaster` built a raw `CastRayCollectorJS()` without installing
    `Reset`/`OnBody`/`AddHit` as the instance's own properties, so jolt-physics threw
    `"a JSImplementation must implement all functions"` the first time it was cast
    (or reset) before `onBody()`/`addHit()`/`onReset()` had been called. It also
    leaked the base class's native collector when swapping it out, and its
    `cast()` reset the collector *after* the raw cast instead of before, wiping out
    the very hits it had just collected.
  - `RaycastHit.impactNormal` leaked a `BodyID`, `SubShapeID` and `RVec3` on every
    single call (the `destroy()` calls were commented out) - now fixed. It also
    no longer calls `destroy()` on the `Vec3` returned by
    `GetWorldSpaceSurfaceNormal()`, since jolt-physics' WebIDL binder returns that
    by value as a pointer to a shared static temporary, not a fresh allocation -
    freeing it would corrupt state shared by every other caller of that binding.
    The same reasoning applies to `RaycastHit`'s existing (pre-existing, unchanged
    in behavior) handling of `GetPointOnRay()`'s return value, which is now also
    left un-freed with an explanatory comment instead of being incorrectly
    destroyed.
  - `Multicaster` had no `destroy()` at all, leaking the `Raycaster` (and its ray,
    settings, filters and collector) it owns; it also appended to `results`
    forever without ever clearing it. Both are fixed.
- ea82dee: Fix `<Heightfield>` creating/leaking a stale body when `url` changes (or the component
  unmounts) while a previous heightmap image is still loading.
  
  The image-loading effect is now cancellation-aware: each load run tracks its own
  `cancelled` flag and `AbortController`, so a superseded or post-unmount load's `.then`
  never touches the mesh or calls `addHeightfield`. The body an effect run owns is removed
  in that run's own cleanup — which React runs before the next run's effect body — so at
  most one heightfield body exists at a time, matching whichever `url` is current. Failed
  loads (including genuine decode/network errors) are reported once via `console.warn`
  instead of silently doing nothing.
  
  `heightField/Generators.ts`: `imageUrlToImageData` now accepts an `AbortSignal` and drops
  its canvas/image-element references as soon as it settles (success, error, or abort)
  instead of holding them for the life of the promise. `applyHeightmapImgDataToPlane` now
  validates that the plane's position attribute is a `Float32Array` and that the vertex
  grid is a shape Jolt's `HeightFieldShapeSettings` can accept (square, edge length a
  multiple of the block size, at least two blocks wide), throwing a clear error otherwise
  via the new exported `getValidatedHeightfieldSampleCount`.
  
  `HeightfieldProps.position` is now typed as `Vector3Tuple` instead of `any`, and the
  remaining `@ts-ignore`s in the component have been replaced with a properly typed mesh
  ref and a placeholder-texture fallback so `useTexture` never needs an `any`-typed
  argument.
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
- 35ace65: Fix `<InstancedRigidBodyMesh>` never destroying its bodies/InstancedMesh (#24), and
  `BodyState`'s `color` setter throwing/writing the wrong path on a non-instanced body (#143).
  
  `InstancedRigidBodyMesh` now, on unmount, destroys every body it created via
  `bodySystem.removeBody` (unregistering them from the dynamic/kinematic maps), releases the
  `InstancedMesh` (its own `instanceMatrix`/`instanceColor` GPU buffers via `.dispose()`, and
  drops the `instanceColor` reference), and disposes the default geometry/material it built
  itself when no `<boxGeometry>`/material children were passed - geometry/material sourced
  from children stay owned by three-fiber's own JSX tree and are left alone. Changing `count`
  still adds/removes bodies incrementally instead of leaking, and a StrictMode remount can no
  longer leave orphaned bodies or lose track of the mesh's original parent (the mount effect
  is now idempotent). Fixed a related bug where shrinking `count` (e.g. 20 → 10) copied the
  *old*, larger count's worth of instance data into the new, smaller buffer, overrunning it.
  
  `BodyState.set color` fell through its non-instanced branch (no `return`) into
  `setColorAt`, a method that only exists on `THREE.InstancedMesh`. It now returns after the
  instanced branch (also setting `instanceColor.needsUpdate`, which was missing entirely), and
  the non-instanced branch clones the mesh's material exactly once - marking it as owned so
  `destroy()` disposes it - instead of mutating a material that might be shared with other
  meshes. `color` is now typed as `THREE.ColorRepresentation` on both the getter and setter.
  
  Removed the remaining `@ts-ignore`s in `InstancedRigidBody.tsx` by properly typing the
  forwarded ref (`ref` is now a plain prop, per React 19) and the geometry/material/body-state
  locals instead of suppressing the checker.
- a3ac577: Fix `initJolt`/`<Physics module>` silently reinitialising (and leaking) the jolt-physics WASM module.
  
  Previously, calling `initJolt(factory)` a second time with any factory - even the exact same
  reference `<Physics module={x}>` passes on every render - deleted the `Raw.module` reference and
  spun up a brand new WASM instance, with no way to free the old one and no protection against doing
  this while a Physics world was still using it (every live body/shape/constraint would have been
  left pointing at a heap nobody owned any more).
  
  `initJolt` now:
  
  - reuses the active module when called again with the same factory reference (no more
    reinitialising on every `<Physics module>` render), and
  - refuses to swap to a *different* factory while a Physics world exists (`Raw.joltInterfaces` is
    non-empty), logging a `devWarn` and keeping the module that's already active instead.
  
  Also documents the `module` prop against jolt-physics 1.1.0's full set of entrypoints
  (`wasm-compat`/default, `wasm`, `debug-wasm-compat`, `asm`, the multithread variants) in
  `packages/react-three-jolt/README.md`, including bundler recipes for `/wasm` on Vite and
  Next.js/webpack, and notes that `debug-wasm-compat`'s `JoltInterface.sGetTotalMemory()` /
  `sGetFreeMemory()` are usable for memory-leak profiling (issue #54).
  
  `apps/examples` gains a build-variant switcher (`?jolt=` query param + a leva control) covering
  `wasm-compat`, `wasm` and `debug-wasm-compat`, and a live WASM-heap readout shown when
  `debug-wasm-compat` is selected.
- 674d8db: #149: renamed the remaining camelCase/PascalCase source files to kebab-case, and `.tsx` files
  with no JSX to `.ts`:
  
  - `utils/meshTools.ts` -> `utils/mesh-tools.ts`
  - `heightField/` -> `heightfield/` (including `Generators.ts` -> `generators.ts`)
  - `hooks/use-constraint.tsx` -> `hooks/use-constraint.ts` (no JSX - the only `<...>` in the file
    is a generic type parameter)
  - `hooks/use-raycasters.tsx` -> `hooks/use-raycasters.ts` (same)
  
  Every import was updated in place (`git mv` + path fixes); every symbol is re-exported by the same
  name from the same package entry points, so this has no effect on consumers importing from
  `@react-three/jolt` or `@react-three/jolt/*`'s public exports.
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
- 243eeb1: Fix constraint cleanup so constraints are actually removed and freed (#82).
  
  `ConstraintSystem.removeConstraint()` was an empty function with its body commented out, and
  it is `useConstraint`'s entire cleanup path — so every constraint ever created stayed in the
  physics system for the lifetime of the world. It is now implemented, along with the
  lifetime rules that made the earlier attempts crash:
  
  - constraints are reference counted. `RemoveConstraint` plus `Release()` frees one;
    `Raw.module.destroy()` on a constraint is a double free and traps in wasm.
  - a constraint must be removed **before** either of its bodies. `BodySystem.removeBody()`
    now removes the constraints attached to a body first, so removing a constrained body no
    longer crashes the next step.
  - `<Physics>` unmounting frees the JoltInterface before its children clean up (React tears
    a parent down first), so `PhysicsSystem` exposes a `destroyed` flag and the constraint
    cleanup skips jolt once the world is gone.
  
  Also in this pass:
  
  - `ConstraintSystem` keeps a registry of live constraints (`constraintSystem.constraints`),
    and gains `removeConstraintsForBody()` and `removeAllConstraints()`.
  - every `*ConstraintSettings`, `SpringSettings`, `MotorSettings` and `Vec3`/`RVec3`
    temporary is now freed after the constraint is created (previously ~12 leaked wasm
    objects per constraint).
  - `createMotorSettings()` referenced undeclared variables and threw a `ReferenceError` if
    called. It now takes typed options and sets the real jolt 1.1 fields
    (`mMinForceLimit`/`mMaxForceLimit`/`mMinTorqueLimit`/`mMaxTorqueLimit`/`mSpringSettings`).
  - hinge motors called `SetTargetVelocity`/`SetTargetPosition`, which do not exist on
    `HingeConstraint`; they now use `SetTargetAngularVelocity`/`SetTargetAngle`.
  - `swingTwist` without an explicit position no longer throws (`new body.GetPosition()`),
    and `getEaxis` no longer falls through returning `undefined`.
  - `addConstraint`, `useConstraint` and the constraint options are now typed
    (`ConstraintType`, `ConstraintOptions`, `ConstraintTypeMap`) with no `@ts-ignore` left in
    either file, and `useConstraint` re-creates its constraint when the type, bodies or
    option values change.
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
- 05f67c2: Stop the shape system leaking WASM memory.
  
  Jolt's list containers copy the value passed to `push_back`, so the `Vec3`/`Float3`/
  `IndexedTriangle` created for every point, vertex and triangle was leaked - along with the lists
  themselves, the `PhysicsMaterial`, and the `ShapeSettings` that were never destroyed after
  `Create()`. Building a mesh collider from a 2k-triangle sphere left 3078 live Jolt objects behind;
  it now leaves none.
  
  - `getShapeSettingsFromGeometry`, `generateShapeSettings` and `getShapeSettingsFromObject` reuse a
    single scratch object per loop and free every temporary, including the single-shape early return.
  - New `createShapeFromSettings(settings)` / `releaseShape(shape)` helpers realise a shape, take a
    reference on it, free the settings and report `Create()` errors as a thrown error instead of
    handing back an invalid shape. `BodySystem.addHeightfield` and `generateBodySettings` use them,
    so a body now owns its shape and frees it when the body is destroyed.
  - `createMeshForShape` and `createMeshFromShape` were byte-identical copies of each other; there is
    now one implementation and both names still work.
- 0704316: Public API surface cleanup (issue #148):
  
  - `Vector4Tuple` is now a strict `[number, number, number, number]` tuple. It used to be
    `[number, number, number, number] | number[]`, which defeated the tuple entirely - any
    `number[]`, including one of the wrong length, satisfied it.
  - `RigidBodyProps.key?: number` is removed - it shadowed React's own reserved `key` and was never
    read by the component.
  - `RigidBodyProps` now extends `ThreeElements['object3D']` (minus the props it gives its own
    meaning to: `position`/`rotation`/`scale`/`quaternion`, applied to the physics body rather than
    passed through, plus `ref`/`children`), so ordinary object3D props (`visible`, `castShadow`,
    `userData`, event handlers, ...) - already spread onto the rendered `<object3D>` at runtime -
    now typecheck too.
  - `RigidBodyContext`/`ShapeContext` no longer name both a type and a value. The types keep their
    names; the context values are `rigidBodyContext` and `shapeContext` (lowercase). `Shape.tsx`'s
    `ShapeContextValue` alias - a workaround for the old collision - is deprecated in favor of the
    now-unambiguous `ShapeContext` type, and kept for one release.
  - `MeshFloor` has a real `MeshFloorProps` interface (it was an untyped `{ size, position, ...rest
    }` destructure) and its mount effect now has an unmount cleanup that removes the Jolt body it
    creates - it used to outlive the component for the life of the physics world.
  - `FrameStepper` (an internal implementation detail of `<Physics>`, never documented) is marked
    `@internal`.
- c94f6ef: Extract a shared `QueryBase`/`CastQueryBase`/`HitBase` (new `systems/queries/query-base.ts`) out
  of `Raycaster`, `AdvancedRaycaster`, `Multicaster`, `Shapecaster` and `ShapeCollider` (issue #154).
  `Shapecaster` duplicated ~90% of `Raycaster`, most visibly a byte-identical ~230-line
  debug-drawing block, so a fix applied to one (e.g. #141/#173/#192) had to be hand-ported to the
  other and was easy to miss.
  
  - `QueryBase` owns the `joltPhysicsSystem`/`joltInterface`/`bodyInterface` wiring, the four
    filters (`bpFilter`/`objectFilter`/`bodyFilter`/`shapeFilter`) with their creation/destroy, and
    an idempotent `destroy()` template (`releaseResources()` hook) - `Raycaster`, `Shapecaster` and
    `ShapeCollider` no longer duplicate this, and `Multicaster`'s `destroy()` is now idempotent too
    (it previously had no guard against being called twice, which would have double-freed its owned
    `Raycaster`'s allocations).
  - `CastQueryBase` (extends `QueryBase`) adds what only the ray-like casters share: the collector
    lifecycle (`setCollector()`), the `cast()`/`castFrom()`/`castTo()`/`castBetween()` family, and
    the debug-drawing resource pool (`isDebugging`, `debugObject`, `drawDebuggingLine/Points/
    Markers`, `drawMarker`, `clearDebugging`). `Raycaster` and `Shapecaster` extend it directly;
    `AdvancedRaycaster` extends `Raycaster`.
  - `HitBase` is shared by `RaycastHit` and `ShapecastHit`: the `distance`/`normal`/`direction`
    getters and the `impactNormal` reader (BodyID/SubShapeID allocation + destroy, and the
    never-destroy-the-static-normal rule for `GetWorldSpaceSurfaceNormal`'s by-value return) were
    byte-identical between the two and are now written once.
  
  No public property, method or constructor signature changed. `net -346` lines across
  `raycasters.ts`/`shapecasters.ts`/`collider.ts`/`index.ts` even after adding the new shared
  `query-base.ts` file (1735 -> 1389 total). All existing raycaster/shapecaster/collider/hook tests
  pass unchanged; added `test/query-base.test.ts` asserting every concrete class' `destroy()`
  returns the jolt allocation tracker to baseline (and is idempotent) and that toggling
  `isDebugging` on `Raycaster`/`Shapecaster` creates and disposes exactly the pooled three.js debug
  resources.
- 53f9bdb: Fixed #215: `physicsSystem.getRaycaster()` / `getAdvancedRaycaster()` / `getMulticaster()` /
  `getShapecaster()` / `getShapeCollider()` now register the query object they return with the
  world (`registerDisposable`), and the query's own `destroy()` unregisters it again. A query a
  caller forgets to `destroy()` is now freed when `<Physics>` unmounts instead of leaking; a query
  that *is* explicitly destroyed no longer lingers in the world's disposable set until teardown.
  `QueryBase.destroy()` was already idempotent (issue #154) - verified as part of this fix.
- 7872049: Wire up `<RigidBody friction>` and friends (#198).
  
  `friction` was declared in `RigidBodyProps` and read by nothing. It, `restitution` and
  `gravityFactor` (both new props) now go through the same reactive effect as `mass` and the
  damping props, with JSDoc for each default.
  
  Two related fixes in the same effect: it is keyed on the body instance rather than on a
  non-reactive ref, so these properties also reach a body that is created later because it has
  `<Shape>` children; and it tests `!== undefined` instead of truthiness, so `friction={0}` and
  `gravityFactor={0}` are no longer read as "unset".
- d35a497: Fix `ShapeCollider` leaking every Jolt object it creates (issue #142).
  
  `ShapeCollider.destroy()` was a no-op, leaking its collector, `CollideShapeSettings`, body/shape/
  broad-phase/object-layer filters, base offset `RVec3` and transform `RMat44` for the lifetime of
  the app. Worse, `setJoltMatrix()` replaced the transform every time `position`/`rotation`/`matrix`
  was set without freeing the previous one - `CameraBoom.checkCollision` does this every frame, so a
  long camera-collision session leaked one `RMat44` per frame.
  
  - `destroy()` now frees every Jolt object the collider owns, is idempotent (safe to call more than
    once), and nulls out its references afterwards.
  - `setJoltMatrix()` mutates one `RMat44` (and two scratch `RVec3`/`Quat` objects) in place for the
    collider's whole lifetime instead of allocating a new transform per call - zero WASM allocations
    per frame.
  - `activeShape` is now correctly reference counted: the `shape` setter and constructor `AddRef()`
    whatever shape they're holding and `Release()` the previous one, and `destroy()` releases the
    current shape instead of hard-destroying it, so a caller that also holds (and later frees) a
    reference to the same shape doesn't end up with a dangling pointer.
- 81e0d86: Fix the two memory bugs in `systems/queries/shapecasters.ts` that the matching
  raycaster fixes never reached, because nothing in that change set touched this
  sibling file:
  
  - `ShapecastHit`'s constructor called `destroy()` on the value returned by
    `RShapeCast.GetPointOnRay()`. That is a BY VALUE return: jolt-physics' WebIDL
    binder hands back a pointer to one static temporary per bound function, shared
    across every shapecast and overwritten on the next call. Freeing it returns
    the binder's own memory to the allocator, which reuses it immediately, so the
    corruption surfaces later and somewhere else entirely. `vec3.three()` already
    copies the components out, so there is nothing to free.
  - `ShapecastHit.impactNormal` allocated a `BodyID`, a `SubShapeID` and an
    `RVec3` on every read and freed none of them (the `destroy()` calls were
    commented out). It is read per hit, per frame, by the camera rig. The `Vec3`
    from `GetWorldSpaceSurfaceNormal()` is deliberately still not freed - it is
    the same kind of by-value static temporary.
  
  Adds `test/shapecasters.test.ts`, which casts against the real WASM module and
  asserts the net Jolt allocation count is flat across 100 casts. Its spy
  discovers every embind constructor on the module at runtime, so it covers
  `BodyID`/`SubShapeID` as well as the value types, and it catches the double free
  (count drifts negative) as well as the leak (count grows).
- 3b3b96a: Closes #192.
  
  **`shapecasters.ts` now mirrors the raycaster fixes from #173/#191/#174.**
  `Shapecaster.drawDebuggingLine`/`drawDebuggingPoints`/`drawDebuggingMarkers` allocated a brand new
  `THREE.BufferGeometry`/`Material`/`Object3D` on every single call, and `cast()` calls them on every
  cast while `isDebugging` is on - so a shapecaster that draws its debug view every physics step grew
  `debugObject.children` (and leaked geometries/materials) without bound, same as issue #173 for
  raycasters. `drawMarker` also always drew a world-axis-aligned cross regardless of the hit surface,
  same as issue #48. Both are fixed the same way: a shared/pooled line, points object and
  one-marker-per-hit-index pool (shared ring/normal geometry and materials, updated in place), with
  `destroy()`/`clearDebugging()` disposing the pools.
  
  `Shapecaster.destroy()` never `Release()`d its default `activeShape` (one `SphereShape` allocated
  per shapecaster), unlike `ShapeCollider.destroy()` after #174. `activeShape` is now correctly
  reference counted: the constructor `AddRef()`s the default shape, the `shape` setter `AddRef()`s
  whatever it's given and `Release()`s the previous shape, and `destroy()` `Release()`s the current
  one instead of leaking it. Along the way, the `shape` setter's `RShapeCast.set_mShape()` call was
  found to be dead code - that method doesn't exist on the runtime binding (only a read-only
  `mShape` getter does, despite the type declarations) - so setting `shape` after construction never
  actually took effect. It now rebuilds the live `RShapeCast` from `activeShape` (preserving the
  current cast direction across the rebuild), the same way `setOrigin()` already does for
  position/rotation/scale.
  
  **`hooks/use-raycasters.tsx`: `useRaycaster`/`useAdvancedRaycaster`/`useMulticaster` now destroy
  the previous instance on every dep change, not just at unmount.** All three build their
  raycaster/multicaster inside a bare `useMemo`, so whenever `origin`/`direction`/`type` changed the
  memo tore down nothing and built a fresh instance, leaking every raycaster it replaced - only the
  very last one was ever freed, by the `useUnmount` at the bottom. Each hook now tracks its previous
  instance in a ref and destroys it before building the next one, mirroring `useMouseRaycaster`
  (#191). `useAdvancedRaycaster` was additionally missing an unmount cleanup entirely; it now has
  one too.
  
  Adds regression coverage: `test/shapecasters.test.ts` gets the marker-orientation and
  scene-graph-growth tests ported from `raycasters.test.ts`, plus `destroy()`/shape-refcount tests
  (using `test/jolt-alloc.ts`'s `installAllocTracker` and `GetRefCount()`) mirroring
  `collider.test.ts`'s coverage of `ShapeCollider`. A new `test/use-raycasters.test.tsx` mounts
  `<Physics>` for real via `@react-three/test-renderer`, changes each hook's collector `type` twice,
  and asserts the allocation tracker's live count stays exactly at "one instance's worth" measured
  up front - not merely "doesn't grow" - across both type changes and after unmount.
- d380abe: Allow static bodies to be moved (#61).
  
  `bodyState.position` / `bodyState.rotation` now work on a `type="static"` body: the setters
  ask Jolt not to activate it (activating a static body asserts, and means nothing) and register
  it with the new `BodySystem.movedStatics` set, which `PhysicsSystem.onUpdate` drains once per
  frame so the three.js object picks up the new pose. Scenes whose statics never move pay
  nothing - the set stays empty and the drain is skipped.
  
  Moving a static body every frame remains an anti pattern: it teleports, so riders are not
  carried and sleeping neighbours are not woken. Use a kinematic body for anything that moves
  repeatedly.
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
