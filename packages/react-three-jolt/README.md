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

`jolt-physics`, `@react-three/fiber` (>=10), `@react-three/drei` (>=11), `three` (>=0.185) and `react`/`react-dom` (>=19.0 <19.3) are peer dependencies — see [Installation](https://pmndrs.github.io/react-three-jolt/getting-started/installation).

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

---

## Group Filtering
Like many physics systems Jolt supports many different types of collision filtering. At the moment more advanced filters like Broadphase and ObjectLayer filtering is pre-set in R3/Jolt _(we plan to expose later)_ however we not only fully support Group Filters, we’ve expanded their functionality using Jolt’s sub-group system.

When you add items to a `Group`, by default they do not collide with each other. `Subgroups` let us expand on this functionality.

_(I will be referring to the filtering in the Motion Sources/Filtering demo)_

### Activating Filtering
By Default, filtering is deactivated for all bodies. Filtering is slightly expensive, so if it’s not needed, don’t activate it.
At the moment _(may 2024)_ Jolt doesn’t expose the `SetCollisionGroup()` function to Javascript.
So we have to activate filtering when creating the `RigidBody`.

If you use the `<RigidBody>` JSX Component simply add group or subGroup properties

```ts
<RigidBody group={0} subGroup={0}>
    <mesh>
        <boxGeometry args={[5, 0.5, 8]} />
        <meshStandardMaterial color="#ff4060" />
    </mesh>
</RigidBody>

```

_*These can be dynamically changed later, but MUST BE INCLUDED at body creation._

If you are creating with the `BodySystem`, just add group or subGroup to the options object.
They can be changed dynamically after creation but at least group or subGroup **MUST BE PRESENT** at creation.

```ts
bodySystem.addBody(cubeMesh, {group: 0});
```

Once set, bodies in the **SAME GROUP** now have more advanced collision options. 

### Subgroups
Subgroups are where the filtering functionality shines.
By default, all items in the main “group” WILL NOT COLLIDE.

#### Sub-Group 0:
| Doesnt Collide: | 0 | 1 | | |
|---|---|---|---|---|
| Collides: | | | 2 | Non-Members |



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
