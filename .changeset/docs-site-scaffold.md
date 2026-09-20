---
'@react-three/jolt': patch
---

Trim the published README down to install, a short example and links into the new
documentation site (#99, #29, #30).

The README is listed in the package's `files`, so this changes what ships on npm: the long
prose sections (the `<Physics>` prop walkthrough, RigidBody/BodyState, instancing, raycasting,
heightfields, motion sources, `useJolt`) now live as proper pages under `docs/`, published to
GitHub Pages by `.github/workflows/docs.yml` through the shared
[pmndrs/docs](https://github.com/pmndrs/docs) generator. The collision "Group Filtering" section
and the project outline are kept in the README.

New documentation (no runtime changes): Introduction, Installation (peers, Vite, Next.js
Turbopack/webpack, Jolt build variants), Physics, RigidBody, Shapes, Queries, Collision groups &
layers, Controllers, Addons, Memory & lifecycle, SSR & Suspense, Migration, Contributing.
