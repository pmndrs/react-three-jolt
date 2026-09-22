<p align="center">
  <a href="#"><img width="600" alt="Logo" src="https://github.com/pmndrs/react-three-jolt/assets/1397052/3a58723c-c2fa-4899-a1cb-7ef84f9ed62c">
</a>
  <h2 align="center">⚡ Jolt physics in React</h2>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@react-three/jolt"><img src="https://img.shields.io/npm/v/@react-three/jolt?style=for-the-badge&colorA=D99743&colorB=ffffff" /></a>
  <a href="https://discord.gg/ZZjjNvJ"><img src="https://img.shields.io/discord/740090768164651008?style=for-the-badge&colorA=D99743&colorB=ffffff&label=discord&logo=discord&logoColor=ffffff" /></a>
</p>

<p align="center">
⚠️ <strong>Alpha.</strong> All APIs are subject to change. Pin an exact version if you build on it today. ⚠️
</p>

---

[The Jolt Physics Engine](https://github.com/jrouwe/JoltPhysics) is a highly capable, real-time physics engine designed for games and VR applications, built for _Horizon Forbidden West_.

`@react-three/jolt` (or `r3/jolt`) is a wrapper library designed to slot seamlessly into a [react-three-fiber](https://github.com/pmndrs/react-three-fiber) pipeline. Jolt is very powerful and flexible, sometimes at the cost of usability — the goal of this library is to give you a world-class physics simulation without the complexity or the pitfalls.

## 📖 Documentation

**[pmndrs.github.io/react-three-jolt](https://pmndrs.github.io/react-three-jolt)**

| | |
| --- | --- |
| [Introduction](https://pmndrs.github.io/react-three-jolt/getting-started/introduction) | what this is, and Jolt vs Rapier |
| [Installation](https://pmndrs.github.io/react-three-jolt/getting-started/installation) | peers, Vite, Next.js, Jolt build variants |
| [Physics](https://pmndrs.github.io/react-three-jolt/api/physics) | the world component and every prop |
| [RigidBody](https://pmndrs.github.io/react-three-jolt/api/rigid-body) | bodies, `BodyState`, constraints, instancing |
| [Shapes](https://pmndrs.github.io/react-three-jolt/api/shapes) | autodetection, `<Shape>`, heightfields |
| [Queries](https://pmndrs.github.io/react-three-jolt/api/queries) | raycasting, shapecasting, collide-shape |
| [Collision groups](https://pmndrs.github.io/react-three-jolt/api/collision-groups) | group and sub-group filtering |
| [Controllers](https://pmndrs.github.io/react-three-jolt/api/controllers) | character, camera rig, vehicles |
| [Addons](https://pmndrs.github.io/react-three-jolt/api/addons) | input commands and helpers |
| [Memory & lifecycle](https://pmndrs.github.io/react-three-jolt/advanced/memory) | who owns what in the WASM heap |
| [SSR & Suspense](https://pmndrs.github.io/react-three-jolt/advanced/ssr-and-suspense) | loading, error boundaries, Next.js |
| [Migration](https://pmndrs.github.io/react-three-jolt/advanced/migration) | upgrading from the pre-2026 builds |

## Installation

```bash
npm install @react-three/jolt jolt-physics
```

`jolt-physics`, `@react-three/fiber` (>=10), `three` (>=0.185) and `react`/`react-dom` (>=19) are peer dependencies — see [Installation](https://pmndrs.github.io/react-three-jolt/getting-started/installation).

## Example

```tsx
import { Canvas } from '@react-three/fiber';
import { Physics, RigidBody } from '@react-three/jolt';
import { Suspense } from 'react';

export function App() {
    return (
        <Canvas camera={{ position: [0, 5, 12] }}>
            <Suspense fallback={null}>
                <Physics gravity={[0, -9.81, 0]}>
                    <RigidBody position={[0, 8, 0]}>
                        <mesh>
                            <boxGeometry args={[1, 1, 1]} />
                            <meshStandardMaterial color="hotpink" />
                        </mesh>
                    </RigidBody>
                    <RigidBody type="static" position={[0, -1, 0]}>
                        <mesh>
                            <boxGeometry args={[20, 1, 20]} />
                            <meshStandardMaterial color="#444" />
                        </mesh>
                    </RigidBody>
                </Physics>
            </Suspense>
            <directionalLight position={[5, 10, 5]} />
            <ambientLight intensity={0.4} />
        </Canvas>
    );
}
```

`<Physics>` suspends while the Jolt WASM module loads, so it needs a `<Suspense>` boundary above it.

`jolt-physics` ships several builds (embedded `wasm-compat`, separate-file `/wasm`, debug and
multi-threaded variants). Pass an initializer to `<Physics module>` to pick one — see
[Choosing a Jolt build](https://pmndrs.github.io/react-three-jolt/getting-started/installation#choosing-a-jolt-build)
for the table and the Vite / Next.js recipes.

---

## Group Filtering
Jolt has two independent collision filters and they answer different questions.

**Object layers** (`Layer` in `constants.ts`) are the *broad* one: "what kind of thing is this" — moving, non-moving, kinematic, rig. They are pre-set in R3/Jolt _(we plan to expose them later)_ and are what you would reach for to say "bullets never hit other bullets".

**Collision groups** are the *narrow* one: "should these two specific objects collide with each other". They are the right tool for a ragdoll whose upper arm shouldn't collide with its own torso, or a door that shouldn't collide with its own frame.

A body's collision group is a pair of numbers, a `group` and a `subGroup`:

- Two bodies with **different `group` ids always collide** — the filter is skipped entirely.
- Two bodies with the **same `group` id** consult the system-wide filter table, which decides based on their `subGroup` ids. Every sub group pair collides until you turn one off.

Give every body inside a group its own `subGroup` id.

### Setting a group
On the `<RigidBody>` component, with the `group` / `subGroup` props. Both are reactive — change them at any time and the body is updated (and woken) on the next step.

```tsx
<RigidBody group={1} subGroup={2}>
    <mesh>
        <boxGeometry args={[5, 0.5, 8]} />
        <meshStandardMaterial color="#ff4060" />
    </mesh>
</RigidBody>
```

Or from the `BodySystem`, either at creation or afterwards:

```ts
const handle = bodySystem.addBody(cubeMesh, { group: 1, subGroup: 2 });

const body = bodySystem.getBody(handle)!;
body.group = 1; // alias: body.collisionGroup
body.subGroup = 3; // alias: body.collisionSubGroup
```

A body with no group set never pays for filtering, so only set one where you need it.

### Turning a pair off
```ts
const { bodySystem } = physicsSystem;

bodySystem.disableCollision(2, 3); // sub groups 2 and 3 pass through each other
bodySystem.enableCollision(2, 3); // ...and back again
bodySystem.setGroupCollision(2, 3, false); // same thing, as one call
bodySystem.isCollisionEnabled(2, 3); // -> false
```

This only affects bodies that share a `group` id. Two bodies in sub groups 2 and 3 but in *different* groups still collide.

### Sub group ids
Sub group ids index a fixed-size table, `bodySystem.subGroupCount` (default 256). Jolt does not bounds check that index in the release build, so R3/Jolt range checks every id and warns instead of letting it corrupt the heap. If you need more than the default, raise it before creating the first body that uses a group:

**Subgroup 0** is the default and acts like most other physics systems. Any two Bodies in the same parent `Group` and `Subgroup-0` will not collide with each other. 

Bodies in `Subgroup-0` will also ignore bodies in `Subgroup-1`.

_(Green in the example. Note how when coming to a rest the cubes do not stack nicely, instead merge with each other)_

#### SubGroup-1

| Doesnt Collide: | 0 |  | | |
|---|---|---|---|---|
| Collides: | | 1| 2 | Non-Members |

'Subgroup-1' is an addition made by R3/Jolt and the one we recommend using for any “standard” objects. 

Filtering is often done to create trapdoors or filters but you still want the objects to collide with each other. This subgroup allows objects to access filters/traps but still act as regular bodies.
_(Besides green, all boxes in the example are in subgroup-1)_

#### Subgroup-2
Doesn’t collide: Non Group Bodies
Collides: All subgroups
| Doesnt Collide: |  |  | | Non-Members |
|---|---|---|---|---|
| Collides: | 0 |1| 2 |  |

`Subgroup-2` is best used as a block/filter device. Bodies in this subgroup ONLY collide with items in the same PARENT group. This means ALL OTHER bodies will ignore these bodies and fall right through them. However, items in the same “Group” will collide.
_(The blue filter in the example is in subgroup-2)_

---

## Project Outline

There are 4 phases planned for this library. We are currently in Phase 0 (Pre-Alpha).

- [**Alpha: Stable Library**](https://github.com/pmndrs/react-three-jolt/milestone/1) — stabilize building, deployment and planning, with the minimum level of usability and performance.
- [**1.0 Feature Parity**](https://github.com/pmndrs/react-three-jolt/milestone/2) — comparable with [r3/rapier](https://github.com/pmndrs/react-three-rapier/) and [use-cannon](https://github.com/pmndrs/use-cannon), with documentation and examples.
- [**2.0 Advanced Jolt Features**](https://github.com/pmndrs/react-three-jolt/milestone/3) — pulleys, buoyancy, and the rest of what Jolt can do.
- [**3.0 Kinematic Rigs**](https://github.com/pmndrs/react-three-jolt/milestone/4) — Jolt's skeleton animation system for rigid body models (ragdolls, characters).

## Contributing

See the [Development Guide](https://github.com/pmndrs/react-three-jolt/blob/main/DEVELOPMENT.md) and the [Contributing](https://pmndrs.github.io/react-three-jolt/advanced/contributing) docs page.
