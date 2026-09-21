---
'@react-three/jolt': patch
---

Fix the one relative documentation link left in the published README.

`README.md` is listed in the package's `files`, so it ships to npm on its own — a link to
`../../docs/getting-started/installation.mdx` only resolves inside a repository checkout. It now
points at the published page like every other doc link in the file
(`https://pmndrs.github.io/react-three-jolt/getting-started/installation#choosing-a-jolt-build`).

Documentation only, no runtime changes. The rest of this pass updated the `docs/` site to match
the code that landed in wave 2 (events, the shape descriptor pipeline, collision groups,
`<Vehicle>`, the camera rig options, `useMouseRaycaster`, the gamepad poller) and folded
`packages/react-three-jolt/docs/events.md` into the RigidBody and Physics pages.
