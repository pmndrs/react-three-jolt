---
'@react-three/jolt': minor
---

Per-heightfield and per-quad friction (#46).

`<Heightfield>` and `bodySystem.addHeightfield(mesh, options)` now take `friction` and
`restitution` for the whole field, and a list of surfaces for individual quads:

```tsx
<Heightfield
    samples={samples}
    size={128}
    materials={[
        { name: 'ice', friction: 0.02 },
        { name: 'grip', friction: 1.5 }
    ]}
    materialIndex={(x) => (x < 0 ? 0 : 1)}
/>
```

`materials` is built into the shape's `PhysicsMaterialList` and `materialIndex` (a callback
given each quad's centre, or a ready made `(size - 1)^2` array) into `mMaterialIndices`, so Jolt
resolves the right material for any contact.

Jolt's `PhysicsMaterial` carries no friction of its own - its JS binding is a constructor and
the ref-count methods, and friction always comes from the two bodies - so the new
`SurfaceMaterialTable` remembers which material stands for which `{ friction, restitution, name }`
and the contact listener writes `ContactSettings.mCombinedFriction` synchronously, inside the
step (a new internal `EventBit.surfaceMaterial`, alongside the existing motion-source hook).
Bodies without materials are untouched and pay nothing.

Ownership, verified at runtime: the `PhysicsMaterialList` is copied into the settings and again
into the shape, so the list is destroyed after `Create()` while the materials themselves are
ref-counted by the shape and must never be destroyed by hand. Adding and removing a heightfield
with materials is allocation net-zero.
