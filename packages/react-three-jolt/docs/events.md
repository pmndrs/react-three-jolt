# Events

Every event in `@react-three/jolt` — step, contact, sensor, sleep/wake — goes through one
primitive and one set of names. A concept is spelled the same way whether you reach it as a
React prop, a hook, or an imperative subscription.

| Concept | `<RigidBody>` / `<Physics>` prop | imperative |
|---|---|---|
| started touching | `onCollisionEnter` | `body.onCollisionEnter(fn)` / `body.on("collisionEnter", fn)` |
| still touching | `onCollisionPersist` | `body.onCollisionPersist(fn)` |
| stopped touching | `onCollisionExit` | `body.onCollisionExit(fn)` |
| entered a sensor | `onSensorEnter` (alias `onIntersectionEnter`) | `body.onSensorEnter(fn)` |
| left a sensor | `onSensorExit` (alias `onIntersectionExit`) | `body.onSensorExit(fn)` |
| went to sleep | `onSleep` | `body.onSleep(fn)` |
| woke up | `onWake` | `body.onWake(fn)` |
| accept/reject a contact | `onContactValidate` | `body.onContactValidate(fn)` |
| before a physics step | — | `useBeforePhysicsStep(fn)` / `physicsSystem.onBeforeStep(fn)` |
| after a physics step | — | `useAfterPhysicsStep(fn)` / `physicsSystem.onAfterStep(fn)` |

## Subscribing

```tsx
<RigidBody onCollisionEnter={(e) => console.log(e.other.object?.name, e.normal)}>
```

```ts
const off = body.on('collisionEnter', (e) => { /* ... */ });
off();  // unsubscribe
```

**Every subscription returns its own unsubscribe, and removal never compares function
identity.** Registering the same function twice gives two subscriptions and two handles, so
React StrictMode's mount → cleanup → mount is well defined and an inline arrow is just as
removable as a named one. The old `removeXListener(fn)` methods still exist, are deprecated, and
now remove *every* subscription made for that function.

## Payloads

```ts
interface CollisionPayload {
    target: CollisionTarget;   // the body this handler is registered on
    other: CollisionTarget;
    flipped: boolean;          // true when `target` is Jolt's body 2
    contactCount: number;      // open sub-shape manifolds between the two bodies
}
interface CollisionEnterPayload extends CollisionPayload {
    normal: THREE.Vector3;     // world space, from `other` toward `target`
    penetration: number;
    points: THREE.Vector3[];   // world space; points.length === pointCount
    pointCount: number;
}
interface CollisionTarget {
    body: BodyState | undefined;
    object: THREE.Object3D | undefined;
    handle: number;            // BodyID.GetIndexAndSequenceNumber()
    subShapeId: number;        // SubShapeID.GetValue(); -1 for a shape with no sub-shapes
    index?: number;            // instance index, for <InstancedRigidBody>
}
```

**Payloads are pooled and reused.** Read what you need inside the handler, or clone it; do not
retain the payload, its `normal`, its `points` or either `CollisionTarget`. This is the contract
r3f pointer events and rapier's `TempContactManifold` already carry. Under `<Physics debug>` a
payload is poisoned (`NaN` and frozen) after dispatch, so retaining one fails loudly in
development and costs nothing in production.

`body` and `object` are `undefined` when the other side is a Jolt body that was never registered
with `BodySystem` — the vehicle chassis and the character controller's rig anchor are both like
this. `handle` is always valid.

## Ordering

Per **substep**, not per rendered frame — under a fixed `timeStep` one frame may run several:

```
beforeStep → pending body actions → joltInterface.Step() → queued events → afterStep
```

and within the event flush:

```
collisionExit, sensorExit → collisionEnter, sensorEnter → collisionPersist → sleep, wake
```

Exits come first so a handler keeping a "things I'm touching" set is never transiently
over-counted while a contact migrates between sub-shapes. Within one kind, world-level handlers
run before per-body ones, and per-body fires for Jolt's body 1 then body 2, each with its own
`target` / `other` / `flipped`.

**You may do anything from a handler.** It runs after `Step()` has returned, so adding, moving
and removing bodies is safe; the mutation lands at the top of the next substep. Each handler is
dispatched inside its own `try/catch`, so a throw is logged and does not abort the rest of the
frame.

The one exception is `onContactValidate`, which runs **synchronously inside the step** because
its answer is what Jolt asked for. It must be fast and must not touch bodies. Return `false` to
reject the contact (one-way platforms, team pass-through).

## What Jolt does that may surprise you

- **A body going to sleep closes its contacts.** Jolt removes the manifolds of a deactivated
  body, so a box resting on the floor reports `collisionExit` when it falls asleep and
  `collisionEnter` again when something wakes it. This is Jolt's own behaviour, not a bug in
  the refcount; if you need "is it still resting on something", use `body.isContacting(handle)`
  together with `onSleep`.
- **Destroying a body closes its pairs.** The peer gets exactly one `collisionExit`, on the next
  step, with `other.body === undefined` (the body is already gone).
- **`contactCount` counts sub-shape manifolds**, not contact points. A box on a floor is 1; a
  compound shape resting on two of its children is 2.

## World level events

Jolt's contact listener is global, so `<Physics on*>` is the *cheap* path and the per-body props
are the fan-out. A world handler fires **once per pair**, with `target` set to the body with the
lower `handle`, so a world-wide counter is right without dividing by two.

```tsx
<Physics onCollisionEnter={(e) => count++} onSleep={(e) => sleeping.add(e.handle)}>
```

Or imperatively, from anywhere under `<Physics>`:

```ts
const { physicsSystem } = useJolt();
useEffect(() => physicsSystem.events.on('collisionEnter', fn), [physicsSystem]);
```

## Cost

If nothing is listening, contacts cost a pair refcount and nothing else: no manifold is wrapped,
no payload is built, nothing is queued. Each `BodyState` publishes an `eventMask` bitfield and
the world emitter another; the Jolt callback ors them and bails out. `onCollisionPersist` is
therefore free to leave unsubscribed even though Jolt reports persisted contacts every step.

`<Physics>` copies up to 4 contact points per event. The pair refcount behind `isContacting()`
is maintained whether or not anyone is listening, because it is public API in its own right.

## Decisions taken from the RFC's open questions

These are the answers this implementation took; they are recorded here so they can be changed.

- **Q1 — sensor event names.** `onSensorEnter` / `onSensorExit` are canonical (they match the
  existing `isSensor` prop), **with** `onIntersectionEnter` / `onIntersectionExit` as documented
  rapier-compatible aliases, resolved with one `??` at subscribe time. If both are given, the
  canonical one wins.
- **Q2 — pooled payloads.** Pooled, with dev-mode poisoning under `<Physics debug>`. Allocating
  fresh payloads shows up as GC pressure in contact-heavy scenes, and the "don't retain the
  event" contract already exists in r3f.
- **Q3 — the 900 ms contact debounce.** Dropped, along with `BodyState.contactThreshold` and
  `contactTimestamps`. Sub-shape pair tracking removes the flicker the debounce compensated for,
  and a 900 ms window silently swallowed legitimate re-collisions (a bouncing ball). **Note:**
  the RFC suggested keeping `contactThreshold` as an opt-in override defaulting to `0` plus a
  `contactDebounce` prop on `<Physics>`; neither was implemented, because a debounce now has to
  *delay* an exit rather than suppress a re-enter, and nothing in the repo wants one. Say the
  word and it comes back.
- **Q4 — `<Physics onCollisionEnter>` granularity.** Once per pair, `target` = the lower handle.
  **Refinement:** the RFC sketch said `flipped: false` always; it is instead reported truthfully
  (true when the chosen target is Jolt's body 2), so `normal` stays interpretable.
- **Q5 — `on(type, fn)` vs named methods.** Both. `on()` is the documented primitive; the named
  `onCollisionEnter(fn)` etc. are one-line sugar spelled exactly like the props.

Additionally, settled empirically rather than from the typings: jolt-physics 1.1.0 invokes six
of `CharacterContactListenerJS`'s eleven declared callbacks for a `CharacterVirtual` stepping
against bodies (`OnAdjustBodyVelocity`, `OnContactValidate`, `OnContactAdded`,
`OnContactPersisted`, `OnContactRemoved`, `OnContactSolve`). Emscripten's `hasOwnProperty` check
is lazy — one per call site — so the five character-vs-character callbacks, which only fire once
a `CharacterVsCharacterCollision` is installed, do not need stubs. See
`packages/react-three-jolt-controllers/test/character-contact-listener.test.ts`.
