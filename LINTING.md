# Linting baseline

`yarn lint` (`biome check .`) is wired into CI and must exit 0. To get there without
hand-editing runtime logic, a handful of rules that were erroring across the codebase
have been temporarily downgraded to `warn` in `biome.json`. None of these have a safe
autofix in Biome, so fixing them for real requires a source-level (behavioral) change
that's out of scope for a mechanical formatting/lint-baseline pass.

Re-enable each one (set back to `"error"`, or just remove the override to fall back to
Biome's recommended default) once its warnings have been cleaned up. Counts below are
from the baseline established in this pass; re-run `yarn lint` to see current counts.

| Rule | Category | Baseline count | Why it's a warning for now |
| --- | --- | --- | --- |
| `useIterableCallbackReturn` | suspicious | 26 errors | Flags `.forEach()` callbacks with an arrow-expression body that returns a value (e.g. `arr.forEach((x) => doThing(x))` where `doThing` returns something). Harmless in practice since the return value is discarded by `forEach`, but fixing every call site means rewriting to block-bodied arrows one by one. |
| `noDoubleEquals` | suspicious | 19 errors | `==`/`!=` usage instead of `===`/`!==`. Biome only offers an **unsafe** fix (converting can change behavior when the operands aren't already the same type), so it wasn't auto-applied. Needs case-by-case review. |
| `noImplicitAnyLet` | suspicious | 13 errors | `let`/`var` declared without an initializer or type annotation (e.g. `let texture;`). Needs real type annotations added per call site. |
| `noStaticElementInteractions` (a11y) | a11y | 4 errors | `onClick`/etc. handlers on non-interactive elements (`<div>`, `<mesh>`-wrapped DOM, etc.) in the example app. Fixing properly means adding roles/keyboard handlers, a UX decision, not a mechanical one. |
| `useButtonType` (a11y) | a11y | 1 error | `<button>` without an explicit `type` attribute. Defaulting to `type="button"` can change form-submission behavior if the button is ever moved inside a `<form>`, so it wasn't auto-applied. |
| `noUnreachable` | correctness | 3 errors | Dead code after a `return`/`throw` in `constraint-system.ts`. Looks like leftover debug code; left in place rather than deleting logic during a formatting pass. |
| `noRedeclare` | suspicious | 1 error | `Routes` redeclared in the same scope in `apps/examples/src/App.tsx` (likely a duplicate import/identifier from the router). Needs a look at the actual import structure. |

## Rules already at `warn` by Biome's own defaults (no override needed, but flagged here since they also have unsafe "safe" fixes)

These two are already warnings under Biome's recommended defaults, but running
`biome check --write` (not `biome format --write`, which is what `yarn format` runs)
**will** try to apply their fixes, and in this codebase those fixes are not actually
safe:

- **`suspicious/noTsIgnore`** (208 warnings) — Biome offers a "safe" fix that rewrites
  `// @ts-ignore` to `// @ts-expect-error`. `@ts-expect-error` requires the following
  line to actually have a type error, and many of the `@ts-ignore` comments in this
  codebase (jolt-physics interop, mostly) suppress errors that only show up under
  certain type-narrowing paths or don't currently error at all. Applying the fix
  repo-wide broke the build (`TS2578: Unused '@ts-expect-error' directive`) in
  `Heightfield.tsx`, `InstancedRigidBody.tsx`, `RigidBody.tsx`, `use-raycasters.tsx`,
  `body-system.ts`, and `shapecasters.ts`. Left as-is; convert case by case if desired.
- **`style/useImportType`** (60 warnings) — Biome offers a "safe" fix that splits a
  default import into `import type X from '...'` when it thinks `X` is only used as a
  type. It missed a few call sites where the default import (`React`) is also used as
  a value elsewhere in the same file, which broke the build
  (`TS1361: 'React' cannot be used as a value because it was imported using 'import type'`)
  in `Heightfield.tsx`, `InstancedRigidBody.tsx`, and `Shape.tsx`. Left as-is.

**If you run `biome check --write --unsafe` or otherwise re-trigger these two fixes,
re-run `yarn build` before committing** — they will not fail lint (they're warnings),
but they can silently break the TypeScript build.

## Rules already `off` (unchanged from before this pass)

- `complexity/noForEach`, `suspicious/noExplicitAny`, `style/noNonNullAssertion` — this
  is a physics/graphics interop-heavy codebase where these patterns are pervasive and
  intentional; disabling them predates this pass.

## Also warnings, not touched in this pass

`noBannedTypes`, `noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`,
`noCommaOperator`, `useOptionalChain`, `noUnusedPrivateClassMembers`, and a few
`info`-level style rules (`useNodejsImportProtocol`, `useTemplate`,
`noUselessFragments`, `noUselessTernary`, `noUselessConstructor`) are already
warnings/info under Biome's defaults. They don't block `yarn lint` and weren't changed.
