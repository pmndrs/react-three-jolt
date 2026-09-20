# Events

This page has moved into the documentation site. Everything that was here — the event name table,
the pooled payload contract, the ordering guarantees, the Jolt behaviours that surprise people,
and the answers taken for the RFC's open questions — now lives in:

- **[RigidBody → Events](../../../docs/api/rigid-body.mdx#events)** — per-body props,
  `bodyState.on(type, fn)`, the payload shapes, ordering, `onContactValidate`, cost, and the
  design notes.
- **[Physics → World events](../../../docs/api/physics.mdx#world-events)** — `<Physics on*>`,
  `onSettled` / `onActivityChange`, and the step hooks.

Source comments that say "see docs/events.md" mean those two sections.
