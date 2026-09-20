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
