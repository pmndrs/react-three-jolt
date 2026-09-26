# Linting baseline

`yarn lint` (`eslint .`) is wired into CI and must exit 0. Formatting is a separate command and a
separate CI step, `yarn format:check` (`prettier --check .`) - this repo does not use
`eslint-plugin-prettier`, so lint and format problems are never conflated. To get `yarn lint` to
exit 0 without hand-editing runtime logic, a handful of rules that were erroring across the
codebase were temporarily downgraded to `warn`. Each one is raised back to `error` once its
violations are gone.

**NEVER run `eslint --fix` across files you did not otherwise edit**, and never run it repo-wide.
Format your own files with `yarn prettier --write <paths>`; that never changes program behaviour.
An `eslint --fix` can - see "`useImportType` / `consistent-type-imports`" below for a concrete way
an autofix breaks the build without lint ever noticing.

Through the 1.0 alpha this project used [Biome](https://biomejs.dev/) for linting, formatting,
and import sorting instead of ESLint + Prettier. `chore/prettier-eslint` moved it to the same
split drei and react-three-fiber use. See "Migrating off Biome" at the bottom for the mapping from
every `biome.json` rule to its ESLint equivalent (or lack of one) and what changed along the way.

## Rules that have been cleaned up and re-enabled

| Rule | Baseline | Re-enabled in |
| --- | --- | --- |
| `no-unreachable` (off for `.ts`/`.tsx` - see below) | 3 errors under Biome's `correctness/noUnreachable` | the lint-baseline pass (dead `break`s after `return` in `constraint-system.ts`) |
| `@typescript-eslint/ban-ts-comment` (`ts-ignore`) | 208 warnings under Biome's `suspicious/noTsIgnore` | the types pass (#144/#145/#11) - see below |
| `eqeqeq` | 19 errors under Biome's `suspicious/noDoubleEquals` | the types pass - every `==`/`!=` is now `===`/`!==` |
| n/a - `noImplicitAnyLet` has no ESLint equivalent | 13 errors under Biome | the types pass - the last two were `let layer, motionType` and `let threeObject` in `body-system.ts`; tsconfig's `noImplicitAny` covers this now, see below |
| `array-callback-return` | 26 errors under Biome's `suspicious/useIterableCallbackReturn` | the types pass - the 16 remaining `forEach` arrows got block bodies |
| `@typescript-eslint/no-unsafe-function-type` / `no-empty-object-type` / `no-wrapper-object-types` | 14 warnings under Biome's `complexity/noBannedTypes` | the types pass - every bare `Function` is a real signature or a `(...args: never[]) => unknown` identity key |

`no-unreachable` is turned off for `.ts`/`.tsx` files by `typescript-eslint`'s own recommended
config (`typescript-eslint/eslint-recommended`), not by anything in `eslint.config.mjs` - it stays
on for the rare `.js`/`.mjs` file via `@eslint/js`'s `recommended` config.

### `@typescript-eslint/ban-ts-comment` and `@ts-ignore` (issue #145)

`@ts-ignore` suppresses *any* error on the next line, including errors that no longer exist, so a
suppression can outlive the problem it was added for and hide a new one. `@ts-expect-error` fails
the build when the line underneath is actually fine, which is what makes it safe to keep.

The rule is configured as:

```js
'@typescript-eslint/ban-ts-comment': [
    'error',
    { 'ts-ignore': true, 'ts-expect-error': false, 'ts-nocheck': true, 'ts-check': false }
]
```

i.e. `@ts-ignore` and `@ts-nocheck` are banned, `@ts-expect-error` and `@ts-check` are not (the
rule's own default additionally requires a description on `@ts-expect-error`; that requirement is
turned off here to match what Biome enforced). There are **zero** `@ts-ignore` left in
`packages/*/src`, `packages/*/test` and `apps/examples/src`.

Biome offered an autofix for this rule, and it was not safe to apply in bulk: it rewrites every
`@ts-ignore` to `@ts-expect-error`, and any suppression that was never needed then breaks the
build with `TS2578: Unused '@ts-expect-error' directive`. The conversion was done by hand instead:
convert, run `tsc`, and for each "unused directive" error delete the directive entirely, because
it was covering nothing.

`packages/*/test` is type checked too (`tsconfig.test.json` per package, run by that package's
`test` script before vitest), so a suppression in a test cannot go stale unnoticed either.

## Still downgraded

| Rule | Count | Why it's a warning for now |
| --- | --- | --- |
| `jsx-a11y/no-static-element-interactions` | 4 warnings | `onClick`/etc. handlers on non-interactive elements (`<mesh>`, `<div>`) in the example app. Fixing properly means adding roles/keyboard handlers, a UX decision, not a mechanical one. |
| `react/button-has-type` | 1 warning | `<button>` without an explicit `type`. Defaulting to `type="button"` can change form-submission behaviour if the button is ever moved inside a `<form>`. |
| `@typescript-eslint/no-redeclare` | 3 warnings | All three are the same idiom: a `const X = {...} as const` object paired with `export type X = ...` on the next line, so a value and a type share a name on purpose (`EventKind` in `contact-events.ts`, `VehicleFourWheelManager` and `VehicleManagerTwoWheels`, both `@deprecated` renamed-export aliases). The rule's `ignoreDeclarationMerge` option (on by default) covers `interface`/`namespace`/`enum` merges but not a plain `const`+`type` pair, so it fires here even though Biome's `noRedeclare` didn't consider this a conflict. Not fixed because there's nothing to fix - the pattern is intentional and the rule has no option that recognizes it. |

## Rules already at `warn` by default (no override needed)

`@typescript-eslint/no-unused-vars` is configured at `warn` with `argsIgnorePattern`/
`varsIgnorePattern`/`caughtErrorsIgnorePattern` all set to `^_`, matching Biome's own behaviour of
never reporting a leading-underscore name as unused (this codebase leans on that convention -
`_pid`, `_inSettings`, `_collisionResult`, ...). A handful of genuinely unused, non-underscored
bindings (`fl`/`fr`/`bl`/`br` in `wheels.ts`, a couple of unused imports) were already warnings
under Biome's `noUnusedVariables`/`noUnusedImports` defaults and still are; they don't block
`yarn lint`.

**If you rename an unused binding to satisfy this rule, don't just prefix it with `_` reflexively
- check first whether it should actually be used (a forgotten parameter, a dropped return value).**

## Rules deliberately `off`

- `@typescript-eslint/no-non-null-assertion` - this is a physics/graphics interop heavy codebase
  where `!` on a value that was just null-checked (or is guaranteed live by the physics loop) is
  pervasive and intentional. (Biome: `style/noNonNullAssertion`.)
- `@typescript-eslint/consistent-type-imports` - see "`useImportType` / `consistent-type-imports`"
  below. (Biome: `style/useImportType`.)
- `@typescript-eslint/no-explicit-any` - `any` is no longer the default answer. After the types
  pass there are **7** `any` tokens left in `packages/*/src`, all of them variadic constraints
  that `unknown` cannot express: `JoltClass<T>`'s constructor signature (`raw.ts` - a constructor
  type has to match every embind class), `EventMap` and `Entry.fn` (`emitter.ts` - a heterogeneous
  event map), and `useEventCallback`'s generic bound (`hooks.ts`). Everything else is a real
  signature, `unknown` plus a narrowing helper, or a single documented cast at the embind
  boundary. (Biome: `suspicious/noExplicitAny`.)
- No rule for `complexity/noForEach` - Biome's rule (discouraging `.forEach` in favour of
  `for...of`) has no ESLint equivalent, and this codebase uses `.forEach` throughout, so nothing
  was added in its place.

### `useImportType` / `consistent-type-imports`

`@typescript-eslint/consistent-type-imports`'s autofix splits a default import into
`import type X from '...'` when it thinks `X` is only used as a type - and it misses call sites
where the default import (`React`) is also used as a *value* elsewhere in the same file (every
component compiled with the classic JSX runtime: `Floor.tsx`, `CommanderContext.tsx`,
`Heightfield.tsx`, `CameraRig.tsx`, `Vehicle.tsx`, and their tests), because the emitted
`React.createElement` calls need `React` in scope at runtime. Turning that `import` into an
`import type` compiles fine and then breaks at runtime, or fails the build with
`TS1361: 'React' cannot be used as a value because it was imported using 'import type'`, depending
on which file it hits. Biome had the equivalent problem with `style/useImportType`'s own autofix
and reached the same conclusion: leave the rule off rather than fix the false positives one file
at a time.

**If you re-enable this rule, run `yarn build` before trusting `yarn lint`'s exit code** - a
broken `import type` is a build failure or a runtime crash, not a lint error, so lint alone can't
catch it.

## Migrating off Biome (`chore/prettier-eslint`)

This project used Biome (`biome check .` / `biome format --write .`) for linting, formatting, and
import sorting through the 1.0 alpha. `chore/prettier-eslint` split that into ESLint (linting) and
Prettier (formatting) - the split drei and react-three-fiber both use - while keeping this repo's
existing style (4 space indent, 100 column width, semicolons, single quotes, no trailing commas)
so the source diff stayed close to zero: 28 PRs were stacked on this branch at the time, and a
repo-wide reformat to pmndrs' usual 2-space/120-column/no-semicolon style would have broken every
one of them. `.prettierrc` reproduces Biome's old formatter output rather than pmndrs' house
style; see the comment at the top of that file.

Every rule Biome had customized in `biome.json` was ported to its ESLint equivalent (the tables
above and below cover all of them) with two exceptions that have no ESLint equivalent at all:

- **`suspicious/noImplicitAnyLet`** (implicit `any` on an unannotated `let`) moved from lint to
  the type checker: `tsconfig.json`'s `noImplicitAny` (on by default in `strict` mode) already
  catches every case this rule did, at build time instead of lint time. This is a real change in
  *when* the problem surfaces (a `yarn build`/`tsc` failure instead of a `yarn lint` warning), not
  a loss of coverage.
- **`complexity/noForEach`** has no ESLint rule that does the same thing, and this codebase uses
  `.forEach` throughout, so nothing was added in its place. This is a real, if minor, loss of
  coverage - nothing in this ESLint setup steers away from `.forEach`.

### Import sorting dropped

Biome's `assist.actions.source.organizeImports` sorted and grouped imports on every format.
Neither drei nor react-three-fiber enforces import order today, and adding
`eslint-plugin-simple-import-sort` (the usual ESLint equivalent) would have reordered imports in
essentially every one of the ~190 source files in one shot, on top of the 28 PRs already stacked
on this branch. This capability was dropped rather than replaced - imports are not sorted or
grouped by anything in this repo any more, the same way they never were in drei or
react-three-fiber.

### `react-hooks/exhaustive-deps` kept, the compiler rule bundle did not

Biome's `useExhaustiveDependencies` maps to `eslint-plugin-react-hooks`'s `exhaustive-deps` rule,
kept at `warn`. drei sets `react-hooks/exhaustive-deps` to `off` entirely, but this repo has (at
the time of this migration) 10 deliberate, individually documented suppressions that encode real
teardown/identity semantics across `Physics.tsx`, `RigidBody.tsx`, `Shape.tsx`,
`InstancedRigidBodies.tsx` and `Vehicle.tsx` - turning the rule off would strand every one of
those comments with no rule left to explain. Each one was converted from a
`// biome-ignore lint/correctness/useExhaustiveDependencies: <reason>` comment to
`// eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>`, prose preserved verbatim.

`eslint-plugin-react-hooks` 7 (the installed major at the time of this migration) bundles a much
larger "React Compiler" rule set into every one of its preset configs -
`recommended`/`recommended-latest`/`flat.recommended` all turn on `static-components`, `use-memo`,
`immutability`, `purity`, `set-state-in-render`, `error-boundaries`, `refs`, `globals`, `config`,
`gating`, `unsupported-syntax` and `incompatible-library` alongside `rules-of-hooks` and
`exhaustive-deps`. None of that was part of what Biome enforced and none of it was evaluated here
- `eslint.config.mjs` registers the plugin and turns on only `rules-of-hooks` (`error`) and
`exhaustive-deps` (`warn`) by hand rather than pulling in a preset. If this repo wants the
Compiler rule set later, that's a deliberate, separate decision with its own cleanup pass, not a
side effect of an ESLint version bump.

### `eslint-plugin-react`'s defaults needed three overrides

`eslint-plugin-react`'s `recommended` config assumes a plain DOM, often-PropTypes-based React
app, which doesn't describe this codebase:

- **`react/no-unknown-property`** is off. It only knows the DOM's attribute list and has no idea
  about `@react-three/fiber`'s Three.js-backed intrinsics (`<mesh position=.../>`,
  `<bufferGeometry args=.../>`, ...) - this fired 365 false positives across the example app and
  every component test before it was disabled. Biome never had an equivalent (it doesn't type JSX
  elements at all), so this isn't a coverage loss, just noise this plugin can't avoid for a
  react-three-fiber codebase.
- **`react/prop-types`** is off. Every prop here is typed with a TS interface/type, never
  `React.PropTypes` - the rule can't see TS types and reported "missing in props validation" for
  props that are, in fact, fully typed. `tsc` is the real prop checker for this codebase.
- **`react/display-name`** is off. It flags anonymous components passed straight to
  `memo(...)`/`forwardRef(...)` or exported as an inline arrow function, both idiomatic here and
  irrelevant for debugging (React DevTools infers a name from the assignment in every one of these
  cases anyway).

`react/react-in-jsx-scope` and `react/jsx-uses-react` needed a directory-scoped override rather
than a global one: `packages/react-three-jolt` compiles JSX with the classic runtime
(`"jsx": "react"`) and every file genuinely needs `import React from 'react'` in scope at runtime,
while `apps/examples` compiles with the automatic runtime (`"jsx": "react-jsx"`) and never imports
`React` at all. `eslint-plugin-react`'s own "auto-detect React >= 19 and disable
`react-in-jsx-scope`" fallback does not fire under the installed React 19.2.8 here, so
`eslint.config.mjs` applies `eslint-plugin-react`'s `jsx-runtime` config (which turns both rules
off) scoped to `apps/examples/**/*.{ts,tsx}` only, on top of the global `recommended` config that
`packages/react-three-jolt` needs.

### Comma-operator assignment chains

`@typescript-eslint/no-unused-expressions` is `warn` instead of its default `error`, because of
`mesh-tools.ts`'s triangle-vertex setup (and two test probes) writing
`(v1.x = x1), (v1.y = ..), (v1.z = ..);` - a comma-operator chain of assignments used as a single
statement. Biome's closest equivalent, `noCommaOperator`, was already only a "warn" that never
blocked `yarn lint`; this keeps the same non-blocking severity rather than rewrite the chains or
silence them file by file.

### TypeScript 7 and `typescript-eslint`

`packages/react-three-jolt` builds against TypeScript 7 (`typescript: ^7.0.2`, alongside
`@typescript/typescript6` for tools that still need the old API - see `DEVELOPMENT.md`).
`typescript-eslint` 8 does not support TypeScript 7 yet and refuses to load at all against it
(`Error: typescript-eslint does not support TS 7.0.`) - it resolves whichever `typescript` package
Node's module resolution finds first, which in this workspace is the real TS 7 hoisted from
`packages/react-three-jolt`. The root `package.json` pins its own `typescript` dependency to
`npm:@typescript/typescript6@^6.0.2` so that ESLint (which only runs from the repo root) resolves
a TS-6-API-compatible `typescript` before it ever reaches the real one - `packages/react-three-jolt`
and `apps/examples` each declare their own `typescript` version and are unaffected; Yarn nests a
private copy for each workspace whose requested range doesn't match what's hoisted to the root.
None of this affects type-checking - `eslint.config.mjs` does not use typed linting
(`projectService`/`parserOptions.project`), only syntactic rules, so `typescript-eslint`'s parser
never needs a real type-checker, just a `typescript` package new enough to load without throwing
and old enough to still expose the API it expects.

### Formatting scope: not everything Prettier can format

`.prettierignore` excludes `*.md`, `*.mdx`, `*.yml`/`*.yaml` and `*.html` in addition to Biome's
old exclusions (`**/dist`, `**/node_modules`, `**/coverage`, `apps/examples/public`, `.yarn`,
`yarn.lock`, `**/*.glsl`, `README.md`, plus `docs/out` for the docs build). Biome never had a
Markdown/MDX, YAML or HTML printer, so none of these were ever reformatted; Prettier does support
all of them, but not in this repo's style - Markdown tables get column-padded and `*em*` becomes
`_em_` (verified against the docs' `.mdx` pages), YAML gets reindented to this config's
`tabWidth: 4` regardless of its own 2-space convention (verified against
`.github/workflows/ci.yml`), and `apps/examples/index.html` would lose its 2-space indent the same
way. Formatting stays scoped to what Biome actually covered: JS/TS/JSX/TSX and JSON.
