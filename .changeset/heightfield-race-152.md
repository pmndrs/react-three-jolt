---
'@react-three/jolt': patch
---

Fix `<Heightfield>` creating/leaking a stale body when `url` changes (or the component
unmounts) while a previous heightmap image is still loading.

The image-loading effect is now cancellation-aware: each load run tracks its own
`cancelled` flag and `AbortController`, so a superseded or post-unmount load's `.then`
never touches the mesh or calls `addHeightfield`. The body an effect run owns is removed
in that run's own cleanup — which React runs before the next run's effect body — so at
most one heightfield body exists at a time, matching whichever `url` is current. Failed
loads (including genuine decode/network errors) are reported once via `console.warn`
instead of silently doing nothing.

`heightField/Generators.ts`: `imageUrlToImageData` now accepts an `AbortSignal` and drops
its canvas/image-element references as soon as it settles (success, error, or abort)
instead of holding them for the life of the promise. `applyHeightmapImgDataToPlane` now
validates that the plane's position attribute is a `Float32Array` and that the vertex
grid is a shape Jolt's `HeightFieldShapeSettings` can accept (square, edge length a
multiple of the block size, at least two blocks wide), throwing a clear error otherwise
via the new exported `getValidatedHeightfieldSampleCount`.

`HeightfieldProps.position` is now typed as `Vector3Tuple` instead of `any`, and the
remaining `@ts-ignore`s in the component have been replaced with a properly typed mesh
ref and a placeholder-texture fallback so `useTexture` never needs an `any`-typed
argument.
