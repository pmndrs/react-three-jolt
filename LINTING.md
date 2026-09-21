# Linting baseline

`yarn lint` (`biome check .`) is wired into CI and must exit 0. To get there without
hand-editing runtime logic, a handful of rules that were erroring across the codebase
were temporarily downgraded to `warn` in `biome.json`. Each one is raised back to
`error` once its violations are gone.

**NEVER run `biome check --write --unsafe`**, and never run `biome check --write` across
files you did not edit. Format your own files with `yarn biome format --write <paths>`.

## Rules that have been cleaned up and re-enabled

| Rule | Category | Baseline | Re-enabled in |
| --- | --- | --- | --- |
| `correctness/noUnreachable` | correctness | 3 errors | the lint-baseline pass (dead `break`s after `return` in `constraint-system.ts`) |
| `suspicious/noTsIgnore` | suspicious | 208 warnings | the types pass (#144/#145/#11) - see below |
| `suspicious/noDoubleEquals` | suspicious | 19 errors | the types pass - every `==`/`!=` is now `===`/`!==` |
| `suspicious/noImplicitAnyLet` | suspicious | 13 errors | the types pass - the last two were `let layer, motionType` and `let threeObject` in `body-system.ts` |
| `suspicious/useIterableCallbackReturn` | suspicious | 26 errors | the types pass - the 16 remaining `forEach` arrows got block bodies |
| `complexity/noBannedTypes` | complexity | 14 warnings | the types pass - every bare `Function` is a real signature or a `(...args: never[]) => unknown` identity key |

### `noTsIgnore` (issue #145)

`@ts-ignore` suppresses *any* error on the next line, including errors that no longer
exist, so a suppression can outlive the problem it was added for and hide a new one.
`@ts-expect-error` fails the build when the line underneath is actually fine, which is
what makes it safe to keep.

The rule is now `error`. There are **zero** `@ts-ignore` left in `packages/*/src`,
`packages/*/test` and `apps/examples/src`.

Biome offers an autofix for this rule, and **it is not safe to apply in bulk**: it
rewrites every `@ts-ignore` to `@ts-expect-error`, and any suppression that was never
needed then breaks the build with `TS2578: Unused '@ts-expect-error' directive`. The
conversion was done by hand instead: convert, run `tsc`, and for each "unused directive"
error delete the directive entirely, because it was covering nothing.

`packages/*/test` is type checked too (`tsconfig.test.json` per package, run by that
package's `test` script before vitest), so a suppression in a test cannot go stale
unnoticed either.

## Still downgraded

| Rule | Category | Count | Why it's a warning for now |
| --- | --- | --- | --- |
| `noStaticElementInteractions` (a11y) | a11y | 4 warnings | `onClick`/etc. handlers on non-interactive elements (`<mesh>`, `<div>`) in the example app. Fixing properly means adding roles/keyboard handlers, a UX decision, not a mechanical one. |
| `useButtonType` (a11y) | a11y | 1 warning | `<button>` without an explicit `type`. Defaulting to `type="button"` can change form-submission behaviour if the button is ever moved inside a `<form>`. |
| `noRedeclare` | suspicious | 1 warning | `Routes` redeclared in the same scope in `apps/examples/src/App.tsx` (a duplicate identifier from the router import). Needs a look at the import structure. |

## Rules already at `warn` by Biome's own defaults (no override needed)

- **`style/useImportType`** (38 warnings) — Biome offers a "safe" fix that splits a
  default import into `import type X from '...'` when it thinks `X` is only used as a
  type. It misses call sites where the default import (`React`) is also used as a value
  elsewhere in the same file, which breaks the build
  (`TS1361: 'React' cannot be used as a value because it was imported using 'import type'`)
  in `Heightfield.tsx`, `InstancedRigidBody.tsx` and `Shape.tsx`. Left as-is.
- `noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters`,
  `noCommaOperator`, `useOptionalChain`, `noUnusedPrivateClassMembers`,
  `suppressions/unused`, and a few `info` level style rules (`useNodejsImportProtocol`,
  `useTemplate`, `noUselessFragments`, `noUselessTernary`, `noUselessConstructor`) are
  warnings/info under Biome's defaults. They don't block `yarn lint`.

**If you re-trigger `useImportType`'s fix, re-run `yarn build` before committing** — it
will not fail lint (it's a warning), but it can silently break the TypeScript build.

## Rules deliberately `off`

- `complexity/noForEach`, `style/noNonNullAssertion` — this is a physics/graphics
  interop heavy codebase where these patterns are pervasive and intentional.
- `suspicious/noExplicitAny` — still off, but `any` is no longer the default answer.
  After the types pass there are **7** `any` tokens left in `packages/*/src`, all of
  them variadic constraints that `unknown` cannot express:
  `JoltClass<T>` (`raw.ts`, a constructor type that must match every embind class),
  `EventMap`/`Entry.fn` (`emitter.ts`, a heterogeneous event map) and
  `useEventCallback`'s generic bound (`hooks.ts`). Everything else is a real signature,
  `unknown` plus a narrowing helper, or a single documented cast at the embind boundary.
