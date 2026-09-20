---
'@react-three/jolt': patch
'@react-three/jolt-addons': patch
'@react-three/jolt-controllers': patch
---

Fix package manifests: peer dependencies, `sideEffects`, and `exports` maps (#150).

**Peer dependencies:**

- `@react-three/drei` is now a declared `peerDependency` (`>=11.0.0-0`) of
  `@react-three/jolt` (used by `Heightfield`'s `useTexture`) and
  `@react-three/jolt-addons` (used as a type in `useGamepadForCameraControls`). It was
  previously imported by both without being declared anywhere, so consumers could end up
  with an unresolvable import or a duplicate/mismatched copy.
- `jolt-physics` moves from a regular `dependency` to a `peerDependency` (`>=1.1.0`) of
  `@react-three/jolt`, and is now also a declared `peerDependency` of
  `@react-three/jolt-controllers` (previously undeclared, despite being imported for
  types throughout its character-controller and vehicle systems). Making it a peer
  avoids two copies of the Jolt WASM module ending up in a consumer's bundle, and lets
  apps pick their own `jolt-physics` build variant (e.g. `/wasm`, `/wasm-multithread`)
  instead of being locked to whatever core resolves internally.
- `@react-three/jolt-addons` does not import `jolt-physics` anywhere, so it was left
  alone there.
- `camera-controls` is dropped from `@react-three/jolt-controllers`'s `dependencies` —
  its only importer, `camera-rig-system-camera-controls.ts`, is dead code unreferenced
  by any export (removed outright in a separate cleanup pass).

**Tree-shaking / packaging:**

- All three packages now declare `"sideEffects": false`. Audited for import-time
  mutations first — the only real one found (`CameraControls.install()` in the same
  dead `camera-rig-system-camera-controls.ts` file above) is unreachable from any
  package export, so it doesn't affect this.
- `exports` maps gained a `"./package.json"` entry and a `"default"` fallback, and keep
  `main`/`module`/`types` for resolvers that don't understand `exports`.
- Each `rollup.config.mjs` now derives its `external` list from that package's own
  `dependencies` + `peerDependencies` keys (plus `three/*` and `jolt-physics/*` subpath
  regexes) instead of a hand-maintained array, so a newly-imported dependency can no
  longer get silently inlined into `dist`. This also fixes `gamepad.js` (a real
  dependency of core and addons) previously being bundled into `dist/index.mjs`/`.cjs`
  instead of left external.
- `files` now includes `CHANGELOG.md` alongside `dist`, `README.md`, and `LICENSE`.
- Auditing every `dist` bundle against the new external list turned up two more
  genuinely undeclared runtime imports that were being silently inlined instead of
  externalized: `suspend-react` (used by `Physics.tsx`, added as a regular
  `dependency` of `@react-three/jolt`) and `@react-three/jolt-addons` (its
  `useCommand`/`useLookCommand` are used by `CameraRig`, `VehicleFourWheel`, and
  `CharacterController`, added as a regular `dependency` of
  `@react-three/jolt-controllers`).

**Also:** added `"type": "commonjs"` and `"engines": { "node": ">=22" }` to each
package's own manifest (`publint` suggestions — these matter once a package is
installed standalone rather than through the monorepo root, which already had
`engines.node`).

No runtime behavior changes; `yarn build`, `yarn test`, and `yarn lint` stay green.
