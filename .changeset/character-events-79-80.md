---
'@react-three/jolt-controllers': minor
---

Character controller events, `isMoving` and `isSliding` (issues #79, #80, and the `onAction`
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
