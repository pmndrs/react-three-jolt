---
'@react-three/jolt': minor
---

Heightfield generation without an image (#45).

`<Heightfield>` now takes the terrain directly, synchronously, and with no loader involved:

```tsx
<Heightfield samples={samples} size={64} scale={[2, 20, 2]} />
<Heightfield generator={(x, z) => Math.sin(x * 0.1) * 4} size={64} />
```

A new `heightfield` utilities module (exported from the package root) backs it:

- `generateHeightfield({ size, noise, octaves, frequency, amplitude, lacunarity, gain, seed,
  spacing })` builds the samples from noise. Deterministic for a seed.
- `psrdnoise2` / `simplex2` / `fbm2` - the psrddnoise GLSL that shipped next to the heightfield
  code is now also a CPU TypeScript port (the `.glsl` files stay for GPU use), plus classic 2D
  simplex noise. `noise` also accepts your own `(x, z) => value`.
- `heightfieldToGeometry(samples, size, scale)` builds the matching `PlaneGeometry` - already
  laid flat, one vertex per sample - so what is drawn and what is simulated are the same
  numbers.
- `samplesFromGenerator`, `heightfieldMaterialIndices`, `validateHeightfieldSize`.

Every entry point enforces the sample-count rule from #152 (`getValidatedHeightfieldSampleCount`):
a square grid, a multiple of the block size, at least two blocks per edge.

Generation is synchronous - there is no worker. A 512x512 field is a few milliseconds; generate
anything larger off the render path and hand it in through `samples`.

Also fixed: the heightfield descriptor's sample spacing was `planeWidth / sampleCount` where
`sampleCount` samples span `sampleCount - 1` segments, so the physics field was one sample wider
than the mesh that was drawn. It is now `planeWidth / (sampleCount - 1)`, with
`addHeightfield`'s centring offset derived from the same numbers, and the depth of a
non-square plane is honoured on z.
