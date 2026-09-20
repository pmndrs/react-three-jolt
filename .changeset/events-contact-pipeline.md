---
'@react-three/jolt': minor
---

Rewrite the contact pipeline: sub-shape pair refcounting and two-tier dispatch.

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
