---
'@react-three/jolt': patch
'@react-three/jolt-addons': patch
'@react-three/jolt-controllers': patch
---

Rework the build pipeline to fix the `arethetypeswrong` "masquerading as CJS" finding
(`node16 (from ESM)`) left open by `chore/package-manifests-150` (#150/#178), and to
decouple declaration generation from rollup's TypeScript plugin (#164):

- JS bundling now uses `rollup-plugin-esbuild` instead of `@rollup/plugin-typescript`.
  esbuild only transpiles - it doesn't type-check - so `dist/index.mjs`/`dist/index.cjs`
  no longer depend on the TypeScript compiler API.
- Type declarations are emitted separately with `tsc -p tsconfig.build.json
  --emitDeclarationOnly --declarationMap` (a new `tsconfig.build.json` per package,
  `include: ["src"]`) into `dist/types/`, then bundled into single
  `dist/index.d.ts` + `dist/index.d.mts` + `dist/index.d.cts` files with
  `rollup-plugin-dts`. A single bundled declaration file per module condition is what
  stops per-file extensionless relative imports (`export * from './components'`,
  valid under `moduleResolution: "Bundler"`) from tripping up `node16 (from ESM)`
  resolution - there's only one file left to resolve, not a graph of them.
- `package.json` `exports` nests `types` inside `import`/`require` instead of listing
  it as a sibling key, so ESM and CJS consumers each get their own declaration file:
  `{ import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" }, require:
  { types: "./dist/index.d.cts", default: "./dist/index.cjs" } }`. The top-level
  `types`/`main`/`module` fields are unchanged, for resolvers that ignore `exports`.
- `tsconfig.json`'s typecheck config (`tsc --noEmit`, still run as the first step of
  `yarn build` in every package) now uses `include: ["src"]` instead of
  `files: ["./src/index.ts"]`, so it covers every file under `src/`, not just what's
  reachable from the entrypoint (partially addresses #145's "six files never
  type-checked", specifically for the build's typecheck gate). No new errors surfaced
  when broadening scope in any of the three packages.
- `typescript` is bumped to `^7.0.2` (the tsgo native compiler) in all three packages'
  `devDependencies`. Both `tsc --noEmit` and `tsc --emitDeclarationOnly
  --declarationMap` work unmodified against the existing `tsconfig.json` options and
  measured faster than 5.9.x locally. TypeScript 7 ships no classic Compiler API, so
  `@typescript/typescript6` (a compatibility shim) is added alongside it -
  `rollup-plugin-dts` needs that API and loads the shim automatically once it detects
  `typescript@7`.
- `publint` and `@arethetypeswrong/cli --pack` are both clean (all four resolution
  modes: `node10`, `node16 (from CJS)`, `node16 (from ESM)`, `bundler`) on all three
  packages; see `DEVELOPMENT.md`'s new "Package build pipeline" section for the full
  write-up and how to re-verify.
