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
| the world stopped moving | `<Physics onSettled>` | `physicsSystem.events.on("settled", fn)` |
| awake body count changed | `<Physics onActivityChange>` | `physicsSystem.events.on("activityChange", fn)` |
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

## Which part of a compound was hit

`payload.targetSubShape` and `payload.otherSubShape` turn a raw `SubShapeID` into the `<Shape>`
that produced it:

```ts
interface SubShapeRef {
    id: number;                            // SubShapeID.GetValue()
    index: number;                         // top-level compound child, or -1 for a leaf shape
    userData: number;                      // the tag stamped on the <Shape>/descriptor, or 0
    descriptor: ShapeDescriptor | undefined;  // what it was built from, `name` included
}
```

**They are resolved on first read.** Touching `targetSubShape` is what walks the shape; a handler
that never asks costs nothing per contact, which is why they are getters rather than fields. The
`SubShapeRef` is pooled like the rest of the payload.

`index` comes from the bit path Jolt packs into the id, and `userData` from
`Shape::GetSubShapeUserData`, which resolves all the way down to the leaf that was hit. The two
answer different questions: `index` is *which child of the body's shape*, `userData` is *which
declaration*, at any nesting depth. `descriptor` is only filled in when the body kept the
description it was built from — `<Shape>` and the automatic `describeObject` path both do;
`bodySystem.addBody(object, { shape })` does not unless you also pass `shapeDescriptor`.

```tsx
<RigidBody onCollisionEnter={(e) => console.log('hit', e.targetSubShape.descriptor?.name)}>
    <Shape>
        <Shape name="hull" size={[4, 1, 2]} />
        <Shape name="wing" size={[1, 0.2, 6]} position={[2, 0, 0]} />
    </Shape>
</RigidBody>
```

### Per-`<Shape>` handlers

A `<Shape>` takes the same `onCollisionEnter` / `onCollisionPersist` / `onCollisionExit` /
`onSensorEnter` / `onSensorExit` props as a `<RigidBody>`, scoped to itself:

```tsx
<RigidBody type="static">
    <Shape>
        <Shape size={[8, 1, 8]} position={[-6, 0, 0]} onCollisionEnter={leftPanelLitUp} />
        <Shape size={[8, 1, 8]} position={[6, 0, 0]} onCollisionEnter={rightPanelLitUp} />
    </Shape>
</RigidBody>
```

They subscribe on the parent body and filter by sub-shape, so they cost the same as the body's
own handlers plus one integer compare. A `<Shape>` that has any of them and no explicit
`userData` is assigned one automatically (from the top of the 32-bit range, well clear of your
own numbering). Pass `userData` yourself to choose the tag, and `name` to label the descriptor.

Two caveats, both from how Jolt resolves a `SubShapeID`:

- a `<Shape>` with handlers should be a **leaf**. Jolt resolves a contact down to the leaf shape,
  so an intermediate compound's own tag is never what a contact reports. A *root* `<Shape>` that
  is the whole compound is the exception and is handled: it is the whole body, so its handlers
  simply are the body's, unfiltered.
- for a two-child compound, child 1's id is `0xFFFFFFFF` — the same word as the "empty" id, since
  Jolt pads the unused high bits with ones. `index` is therefore resolved against the body's
  shape rather than from the id alone, and is `-1` only when the shape genuinely has no children.

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

### Steady state

```tsx
<Physics
    onSettled={() => console.log('everything is asleep')}
    onActivityChange={(active, total) => setLabel(`${active}/${total} awake`)}
/>
```

`onSettled` is edge-triggered: it fires on the step where the last awake body goes to sleep, and
not again until something wakes up. Both are driven by a count the activation listener
maintains (`bodySystem.activeBodyCount`, `bodySystem.simulatedBodyCount`,
`bodySystem.isSettled`), so they cost one comparison per step rather than a per-frame scan. A
world that was never active does not announce itself settled.

Or imperatively, from anywhere under `<Physics>`:

```ts
const { physicsSystem } = useJolt();
useEffect(() => physicsSystem.events.on('collisionEnter', fn), [physicsSystem]);
```

## Character controller events

`CharacterControllerSystem` emits on the same `Emitter`, with the same subscription contract:

| Concept | `<CharacterController>` prop | imperative |
|---|---|---|
| started moving under its own power | `onMove` | `controller.events.on('move', fn)` |
| stopped moving | `onStop` | `…on('stop', fn)` |
| started sliding down something too steep | `onSlide` | `…on('slide', fn)` |
| stopped sliding | `onSlideEnd` | `…on('slideEnd', fn)` |
| a jump was accepted | `onJump` | `…on('jump', fn)` |
| touched down | `onLand` | `…on('land', fn)` |
| became / stopped being supported | `onGround` / `onAirborne` | `…on('ground' \| 'airborne', fn)` |
| crouched / stood up | `onCrouch` / `onStand` | `…on('crouch' \| 'stand', fn)` |
| a contact with a body | `onContactAdded` / `onContactPersisted` / `onContactRemoved` | `…on('contactAdded', fn)` |
| anything, as `(name, payload)` | `onAction` | `controller.on(name, fn)` |

`controller.isMoving`, `controller.isSliding` and `controller.isGrounded` are the state those
edges come from — cached booleans, recomputed once per pre-step, free to read every frame. (They
were declared fields that nothing ever assigned; issues #79 and #80.)

**Movement is measured relative to whatever is carrying you.** Jolt's `GetLinearVelocity()` on a
moving platform already includes the platform's velocity, so `GetGroundVelocity()` is subtracted
before the horizontal speed is taken — riding a lift is not walking. `isSliding` is the
*tangential* part of that same relative velocity, and only counts on a surface Jolt reports as
`OnSteepGround` (or `NotSupported`). Both use hysteresis — enter at the threshold, leave at half
of it — so a character hovering at exactly the threshold does not emit an event per step.
`moveThreshold` and `slideThreshold` (default `0.5` m/s each) are settable on the controller and
as props.

Every one of these is *also* emitted as an `action` under the same name, so
`controller.on('move', fn)` — the older action-filtered API — and
`controller.events.on('move', fn)` agree about what happened. They differ only in signature:
actions are `(name, payload)`, typed events take the payload directly.

Contact events are forwarded from Jolt's `CharacterContactListener`, which fires from *inside*
`CharacterVirtual::ExtendedUpdate`. They are queued there and dispatched once it returns, so a
handler may do anything — the same two-tier arrangement bodies use. The payload is pooled:

```ts
interface CharacterContactPayload {
    body: BodyState | undefined;   // undefined for a body BodySystem never registered
    object: THREE.Object3D | undefined;
    handle: number;
    subShapeId: number;            // on the *other* body's shape
    position: THREE.Vector3;       // world space; zeroed for contactRemoved
    normal: THREE.Vector3;         // points from the character into the other body
}
```

`contactRemoved` carries no geometry — Jolt's callback for it takes only the body and sub-shape —
so `position` and `normal` are zero there.

With nothing subscribed the contact callbacks return on a mask test and queue nothing, exactly
like the body pipeline.

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
