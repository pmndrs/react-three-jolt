---
'@react-three/jolt': patch
'@react-three/jolt-controllers': patch
'@react-three/jolt-addons': patch
---

Remove dead code and unguarded console output from the library packages (no public API changes):

- Deleted unreferenced source files: `heightField/generators-save.ts`, `heightField/heightfieldManager.ts` + its worker scaffold, `utils/heightmap.ts`, `utils/psrddnoise3.ts` (core); the older `camera-controls`-based camera rig (`camera-rig-system-camera-controls.ts`), the empty `use-character-controller.ts`, and the unused `tmp.ts` (controllers). Dropped the now-unused `camera-controls` runtime dependency from `@react-three/jolt-controllers`.
- Added `setDebug(flag)` (exported from the core package) to gate the library's internal `console.*` output, which is off by default. Removed ~17 unconditional debug `console.log` calls, and routed the few `console.warn` calls that flag real misuse/limitations through a new `devWarn()` helper so they only print once a consumer opts in with `setDebug(true)`.

Examples app: removed `apps/examples/src/jolt/` (vendored jolt-physics build artifacts, ~1 GB, no longer referenced by any example).
