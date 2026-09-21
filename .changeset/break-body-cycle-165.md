---
'@react-three/jolt': patch
---

#165: broke the `systems/body-state.ts` <-> `systems/body-system.ts` import cycle that rollup's
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
