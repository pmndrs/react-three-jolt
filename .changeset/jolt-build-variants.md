---
'@react-three/jolt': patch
---

Fix `initJolt`/`<Physics module>` silently reinitialising (and leaking) the jolt-physics WASM module.

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
