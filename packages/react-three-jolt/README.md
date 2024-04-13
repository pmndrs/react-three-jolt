<p align="center">
  <a href="#"><img width="600" alt="Logo" src="https://github.com/pmndrs/react-three-jolt/assets/1397052/3a58723c-c2fa-4899-a1cb-7ef84f9ed62c">
</a>
  <h2 align="center">⚡ Jolt physics in React</h2>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@react-three/jolt"><img src="https://img.shields.io/npm/v/@react-three/jolt?style=for-the-badge&colorA=D99743&colorB=ffffff" /></a>
  <a href="https://discord.gg/ZZjjNvJ"><img src="https://img.shields.io/discord/740090768164651008?style=for-the-badge&colorA=D99743&colorB=ffffff&label=discord&logo=discord&logoColor=ffffff" /></a>
</p>

<h2 align="center"> WARNING!!! This is a pre-alpha build of the library and highly subject to change. DO NOT use this for anything yet. It is under very high rate of change development and will likely break without notice</h2>

<p align="center">
⚠️ This library is under development. All APIs are subject to change. ⚠️
<br />
For contributions, please read the <a href="https://github.com/pmndrs/react-three-rapier/blob/main/packages/react-three-jolt/CONTRIBUTING.md">🪧 Contribution Guide</a>.
<br/>
</p>

---

JOLT is a highly capable real-time Physics Engine designed for games and VR applications built for use in Horizon Forbidden West.

`react-three/jolt` (or `r3/jolt`) is a wrapper library around the [Jolt Physics Engine](https://github.com/jrouwe/JoltPhysics), designed to slot seamlessly into a `react-three/fiber` pipeline. 


The core library is written in C++ with active support in many other platforms such as Rust and a dedicated WASM Library. The WASM version also has many different options for building worth exploring.

The goal of this library is to allow quick and easy access to a world-class physics simulation without some of the complexity or pitfalls. Jolt is very powerful and flexible, sometimes at the cost of usability.

---

** Docs will go here soon **

## Project Outline

There are 4 phases planned for this library. We are currently in Phase 0 (Pre-Alpha)

### [Alpha:Stable Library](https://github.com/pmndrs/react-three-jolt/milestone/1)
This phase is to stabilize building, deployment, and planning among any interested devs while also providing the minimum level of usability and performance.

### [1.0 Feature Parity.](https://github.com/pmndrs/react-three-jolt/milestone/2)
R3/Jolt is heavily inspired by sibling libraries [R3/Rapier](https://github.com/pmndrs/react-three-rapier/) and [useCannon/Cannon](https://github.com/pmndrs/use-cannon). While Jolt itself has many more features and capabilities, we should focus first on being comparable with these other libraries. We should also have plenty of documentation as well as examples (both functional and stylistic)

### [2.0 Advanced Jolt Features](https://github.com/pmndrs/react-three-jolt/milestone/3)
Jolt is a highly capable, powerful library. There are many features and usages we will want to include and provide. Pulleys, Buoyancy, etc.

### [3.0 Kinematic Rigs.](https://github.com/pmndrs/react-three-jolt/milestone/4)
Jolt provides a full skeleton animation system to control rigid body models. The most common use would be ragdoll/character models.

