---
'@react-three/jolt': minor
---

`@react-three/jolt-addons` and `@react-three/jolt-controllers` are now subpath exports of
`@react-three/jolt` rather than separate packages.

```diff
- import { useCommand } from '@react-three/jolt-addons';
- import { CharacterController } from '@react-three/jolt-controllers';
+ import { useCommand } from '@react-three/jolt/addons';
+ import { CharacterController } from '@react-three/jolt/controllers';
```

Change the import paths and drop the two packages from your `package.json`. Nothing else moves —
same exports, same behaviour, and each subpath is still its own bundle, so importing the root
pulls no controller or addon code into your build.

**Why.** The three packages were pinned to one version by changesets' `fixed` config and
depended on each other by exact version, so they could never be released or upgraded
independently — the cost of three packages for none of the benefit. Worse, exact cross-package
pins make a second copy of core possible in a dependency tree, and core is a deliberate
module-level singleton: it owns the one handle on the jolt-physics WASM module and the registry
of live worlds. Two copies means two registries, so `initJolt()` in one leaves the other
unarmed — the same class of bug as two copies of three.js, but harder to spot. A single package
makes that impossible to construct.

`@react-three/jolt-addons` and `@react-three/jolt-controllers` are deprecated on npm and will
not be published again.
