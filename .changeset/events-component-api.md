---
'@react-three/jolt': minor
---

Event props on `<RigidBody>`, `<InstancedRigidBody>` and `<Physics>` (issues #32, #21, #156),
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
