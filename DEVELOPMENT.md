# Development

The `@react-three/jolt` repository is structured as a yarn monorepo.

You will find published packages inside `./packages`, and deployed applications in `./apps`.

## Node

**This project uses node 22.**

If you don't already use a node version manager. Give nvm a try:

https://github.com/nvm-sh/nvm

## Yarn

**This project uses yarn 4.**

If you have Corepack enabled, you should be able to use this project's yarn version without doing anything special. If you don't have Corepack enabled, you can enable it by running the following:

```sh
> corepack enable
```

## Building

Once you have the above installed, run the following to install dependencies and build the project:

```sh
> yarn install
> yarn build
```

## Examples

To run the examples, you can run the following:

```sh
> cd apps/examples
> yarn dev
```

_Sidenote: to get HMR to work while running examples, open a seperate terminal to the react-three-jolt package and run:_

```sh
yarn build -w
```

## Package build pipeline

Each of the three publishable packages (`packages/react-three-jolt`,
`packages/react-three-jolt-addons`, `packages/react-three-jolt-controllers`) builds in four
steps, run in order by that package's `yarn build`:

1. `tsc --noEmit` (using `tsconfig.json`, `include: ["src"]`) - the typecheck gate. This is the
   only step whose failure should block a build; it now covers every file under `src/**`, not
   just what's reachable from `src/index.ts` (see #145).
2. `tsc -p tsconfig.build.json --emitDeclarationOnly --declarationMap` - emits one `.d.ts` (+
   `.d.ts.map`) per source file into `dist/types/`, mirroring `src/`'s structure. This step no
   longer needs `noEmit`/`declaration` to disagree the way the old single `tsconfig.json` did:
   `tsconfig.build.json` extends `tsconfig.json` and overrides `noEmit: false`.
3. `rollup --config rollup.config.mjs` - a single rollup invocation exporting two configs:
   - a JS bundle (`dist/index.mjs` + `dist/index.cjs`) built with **esbuild**
     (`rollup-plugin-esbuild`) instead of `@rollup/plugin-typescript`. esbuild only transpiles
     (strips types, doesn't check them), so it's fast and, unlike `@rollup/plugin-typescript`,
     has no dependency on the TypeScript compiler API - which is what let step 1/2 adopt
     TypeScript 7 (below) without blocking on rollup tooling support.
   - a declaration bundle (`dist/index.d.ts`, `dist/index.d.mts`, `dist/index.d.cts`) built with
     **`rollup-plugin-dts`**, which reads step 2's per-file output from `dist/types/` and rolls
     it into one file per module condition. Bundling into a single file is what makes per-file
     extensionless relative imports (`export * from './components'`, resolved by
     `moduleResolution: "Bundler"`) stop mattering for consumers: there's only one declaration
     file per condition, so there's nothing left to mis-resolve as CJS when a `.d.mts` twin
     exists. This is what closes the `arethetypeswrong` "masquerading as CJS" finding on
     `node16 (from ESM)` that `chore/package-manifests-150` (#150/#178) left open pending this
     work (#164).

`package.json` `exports` puts `types` inside `import`/`require` rather than as a sibling
key - `{ import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" }, require: {...} }`
- because a sibling `types` key is resolved for *both* conditions by tools that understand
`exports` (defeating the point of having two files); the top-level `types` field on
`package.json` still points at `dist/index.d.ts` for resolvers that ignore `exports`
entirely (`node10` mode). Verify a package's four resolution modes with:

```sh
> cd packages/<name>
> npx publint
> npx @arethetypeswrong/cli --pack
```

### TypeScript 7 (tsgo)

All three packages' `typescript` devDependency is `^7.0.2` (the tsgo native compiler). Both
`tsc --noEmit` and `tsc --emitDeclarationOnly --declarationMap` work as drop-in replacements for
TypeScript 5.x with the existing `tsconfig.json` options (no compiler option changes were
needed) and measured faster locally. TypeScript 7 ships **no classic Compiler API**
(`require('typescript')` only exposes a version string; the old `createProgram`-style API is
gone) - tools built against that API, like `rollup-plugin-dts`, need a compatibility shim.
Each package therefore also depends on `@typescript/typescript6` (the classic API frozen at the
TS 6 line), which `rollup-plugin-dts` loads automatically when it detects `typescript@7`. If a
future package or tool needs the classic API directly and TS 7 causes problems, pin that
package's `typescript` devDependency back to `^5.9.3` - nothing else in the pipeline depends on
which major version is used for typecheck/declarations.

## Component convention

React 19 (shipped in the `@react-three/fiber` 10 upgrade) makes `ref` an ordinary prop, so
`forwardRef` is no longer needed to accept one - issue #49. Before that, this codebase had four
different shapes for a component: `React.FC<Props> = memo(forwardRef(...))` (`RigidBody`,
`Shape`), a bare `FC` with no ref (`Physics`, `Debug`, `Attractor`), a plain `function` (`Vehicle`,
`Floor`), and `memo()` with no `forwardRef` even though it took a ref via a plain prop
(`InstancedRigidBodyMesh`). The convention now, for every exported component:

- **Plain function component.** No `forwardRef`, no `React.FC`/`FC<Props>` type annotation on the
  export - `export function Foo(props: FooProps) { ... }` or
  `export const Foo = memo(function Foo(props: FooProps) { ... })`. A named function expression
  (rather than an anonymous arrow) gives devtools a component name for free, without a separate
  `Foo.displayName = 'Foo'` assignment.
- **`ref` is a normal, documented prop** on the component's own props interface, typed as
  `React.Ref<T>` (or `React.Ref<T | undefined>` when the ref is filled in asynchronously, e.g.
  `RigidBody`'s body doesn't exist until the underlying Jolt body is created), destructured like
  any other prop and forwarded with `useForwardedRef` (or `useImperativeHandle`, for a ref that
  exposes something other than a DOM/scene node) exactly as it was under `forwardRef`.
- **`memo` only where the component actually benefits** - one that renders under a `<Physics>`
  tree that re-renders often (`RigidBody`, `Shape`, `InstancedRigidBodyMesh`, the collider
  components, `CharacterController`) keeps it; a component that is cheap to re-render regardless
  (`Physics`, `Debug`, `Attractor`, `Vehicle`) does not need it added just for consistency.
- **No `defaultProps`.** Default values are destructuring defaults on the props parameter
  (`{ size = 20 }: MeshFloorProps`), which is what every component here already did.
- **Props interfaces are exported** (`RigidBodyProps`, `ShapeProps`, `PhysicsProps`, ...) so a
  consumer can reference them, and extend the relevant `ThreeElements['...']` type (minus
  whichever of its keys the component gives its own, incompatible meaning to) when the component
  spreads leftover props onto a three.js element - see `RigidBodyProps` for the pattern.

## Documentation

The user-facing documentation lives in [`docs/`](./docs) as MDX and is built by
[`pmndrs/docs`](https://github.com/pmndrs/docs), the shared documentation generator behind
[docs.pmnd.rs](https://docs.pmnd.rs) (the same one react-three-fiber and drei use).

Layout and conventions:

- One folder per section (`getting-started/`, `api/`, `advanced/`), one `.mdx` file per page.
  The published URL mirrors the path: `docs/api/physics.mdx` → `/api/physics`.
- Every page starts with front matter:

  ```md
  ---
  title: Physics
  description: The <Physics> component and its props.
  nav: 3
  ---
  ```

  `nav` is a single ordering number shared across **all** pages — it drives the sidebar order,
  so inserting a page means renumbering the ones after it.
- GitHub-flavoured callouts (`> [!NOTE]`, `> [!WARNING]`, …) and standard MDX are supported.
- Images are relative to the page and inlined at build time (`MDX_BASEURL`), so put them next
  to the `.mdx` that uses them.

Preview locally:

```sh
> yarn docs        # builds the site and serves it on http://localhost:3000
> yarn docs:build  # static build only, into docs/out (gitignored)
```

`yarn docs` runs the preview script published by `pmndrs/docs`; it needs `curl` and network
access and serves the MDX folder alongside the site so relative assets resolve while editing.

### Publishing (one-time repo setup — owner only)

[`.github/workflows/docs.yml`](./.github/workflows/docs.yml) builds `docs/` on every push to
`main` that touches it (and on manual dispatch) and deploys it to GitHub Pages. It calls the
reusable workflow `pmndrs/docs/.github/workflows/build.yml@v4` and needs **no secrets** — it
authenticates with the automatic `GITHUB_TOKEN`.

Two things a repo admin has to do once before the first deploy succeeds:

1. **Settings → Pages → Build and deployment → Source: “GitHub Actions”.** The workflow calls
   `actions/configure-pages` with `enablement: true`, which can turn Pages on by itself when
   the token has `pages: write` (granted in the workflow), but a repo whose Pages is
   administratively disabled still has to be switched on by hand.
2. **Settings → Actions → General → Workflow permissions**: the `github-pages` environment
   must allow deployments from `main`.

Once enabled, the site publishes to `https://pmndrs.github.io/react-three-jolt/`, with pages
at e.g. `https://pmndrs.github.io/react-three-jolt/getting-started/introduction` (the
workflow reads the base path from the Pages API, so the `/react-three-jolt` prefix needs no
configuration). That is exactly where `pmndrs.github.io/react-three-fiber` and
`pmndrs.github.io/drei` live.

To also get listed on [docs.pmnd.rs](https://docs.pmnd.rs) — the shared index and MCP server
for pmndrs documentation — open a PR against `pmndrs/docs` adding an entry to
[`src/libs.ts`](https://github.com/pmndrs/docs/blob/main/src/libs.ts) pointing `docs_url` at
the Pages URL above (`llms_full: true` once the first build has shipped its
`llms-full.txt`). That is a change in *that* repository, not this one.

## Versioning

This project uses `@changesets/cli` to manage versioning and releases.

As changes are made, changesets should be added with `yarn change`. This will open an interactive prompt to help you describe the changes you've made.

A github action will create a PR for bumping the version based on changesets.

## Linting and formatting

This project uses [Biome](https://biomejs.dev/) for both linting and formatting (it replaced
ESLint + Prettier).

```sh
> yarn lint    # biome check .
> yarn format  # biome format --write .
```

`yarn lint` runs in CI and must exit 0. A handful of rules are currently downgraded to
`warn` rather than fixed outright - see [`LINTING.md`](./LINTING.md) for the list and
the plan to re-enable them one by one.

## Continuous Integration

Every pull request and push to `main` runs [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)
on Node 22: `yarn install --immutable`, `yarn lint`, `yarn build`, then `yarn test`. Make
sure all three pass locally before opening a PR.

Dependency updates are handled by Dependabot ([`.github/dependabot.yml`](./.github/dependabot.yml)):
weekly, grouped minor/patch bumps for both npm and GitHub Actions, with major bumps of
`three`, `react`/`react-dom`, and `@react-three/*` excluded since those are tracked as
deliberate, hand-verified upgrades (see the toolchain notes in this repo's changesets).
