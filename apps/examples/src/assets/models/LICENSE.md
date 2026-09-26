# Model assets

## `Soldier.glb`

Source: [`three.js` examples](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/Soldier.glb)
(`examples/models/gltf/Soldier.glb`), downloaded from the `dev` branch on 2026-09-24 via:

```
curl -sL -o Soldier.glb \
  https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb
```

`three.js` (MIT-licensed) ships this rigged, animated character (a Mixamo-derived humanoid,
"vanguard" mesh, skeleton root `mixamorig:Hips`, animation clips `Idle` / `Walk` / `Run` /
`TPose`) as one of its own public example assets, used unmodified by thousands of `three.js`
demos and tutorials. It is included here, unmodified, solely to drive the `Ragdolls` and
`PoweredRagdoll` demos in `apps/examples` - not redistributed standalone, not sold, and not used
outside this demo app. If a stricter CC0 asset is preferred later, swap this file for `Xbot.glb`
(same directory in the `three.js` repo, same license situation) - both demos read the character
skeleton generically by bone name pattern, not by a hardcoded name, so either file drops in
without code changes beyond the import path.

File size: ~2.1 MB (kept as the smaller of the two common `three.js` example rigs -
`Xbot.glb` is ~2.9 MB).
