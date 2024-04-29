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
For contributions, please read the <a href="https://github.com/pmndrs/react-three-jolt/blob/main/DEVELOPMENT.md">🪧 Development Guide</a>.
<br/>
  There are 4 phases planned for this library. We are currently in:  <em> Phase 0 (Pre-Alpha) </em>
  <br>
  <a href="#project-outline">(See the Project Outline for more details)</a>
</p>

---

[The Jolt Physics Engine](https://github.com/jrouwe/JoltPhysics) a highly capable, real-time Physics Engine designed for games and VR applications built for use in Horizon Forbidden West.

`react-three/jolt` (or `r3/jolt`) is a wrapper library designed to slot seamlessly into a `react-three/fiber` pipeline.

The core library is written in C++ with active support in many platforms (Windows/Mac/Linux/Android/iOS) and engines such as [Godot](https://github.com/godot-jolt/godot-jolt) as well as a [dedicated WASM/JS Library](https://github.com/jrouwe/JoltPhysics.js). The WASM version also has many different options for building worth exploring.

The goal of this library is to allow quick and easy access to a world-class physics simulation without some of the complexity or pitfalls. Jolt is very powerful and flexible, sometimes at the cost of usability.

---

## Note: These docs are in the works. Very sorry for their current state. 🙇‍♂️🙇‍♂️🙇‍♂️

### Physics

`<Physics>`

Jolt works like many other physics libraries where a `<Physics>` component acts as the entrance point for the world.
Just like everything in R3F must be within the `<Canvas>` Everything in R3/Jolt must be inside a `<Physics>`

```tsx
<Physics
    gravity={10}
    debug={doDebug}
    paused={isPaused}
    defaultBodySettings={defaultBodySettings}></Physics>
```

One way it is different however is much of the logic actually lies in a PhysicsSystem class that has it’s own api so you can make changes to the entire system without directly adjusting the component.

`<Physics>` takes a number of properties that will automatically be passed to the PhysicsSystem

#### `gravity`:

Gravity can be a single number 20: that automatically gets turned into [0,-20, 0] and applied to the simulation. You can also pass a vector directly if you have a special gravity you want. 0 also works.

#### `debug`:

Debug triggers debugging on a global level. Any class or object that has debugging possible will start debugging. For things like RigidBody ‘s this will draw the shape. Some classes will begin logging more etc.
One thing to note is Raycasters will not start or stop debugging based on this flag as they can be used for thousands of times per second and you may not want the screen filled up with lasers firing everywhere.

#### `paused`:

Paused is a simple flag that will block the update call in the core physics loop. This essentially stops the system including updating threeJS objects immediately. However, this IS NOT the rendering loop, so objects will continue to render, do shader effects, etc. The physics system will still operate and respond to requests, and the raycaster will still work.

#### `defaultBodySettings`:

This is a handy helper to pass to the `BodySystem` which will pass properties when creating bodies. This lets you make higher level changes without needing to write your own components or interacting with the Jolt interface.

NOTE: most of the time we rewrite the names of properties for you, however this injects directly into the the `BodySettings` pipeline so properties must be in the correct Jolt semanitcs. Normally that means at least starting with the letter 'm'.

```tsx
// body settings so shapes bounce
const defaultBodySettings = { mRestitution: 0.5 });
<Physics defaultBodySettings={defaultBodySettings}>
    <RigidBody position={[0, 20, 3]}>
        <mesh>
            <sphereGeometry args={[1, 32, 32]} />
            <meshStandardMaterial color="hotpink" />
        </mesh>
    </RigidBody>
</Physics>
```

// TODO: all the rapier like props

---

### RigidBody

`<RigidBody></RigidBody>`

This is the most common component you’ll use. RigidBody wraps threeJS objects and automatically creates Jolt Shapes and Rigid Bodies. This will also automatically create a BodyState with the R3/Jolt BodySystem

```tsx
<RigidBody position={[0, 1, 0]}>
    <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="green" />
    </mesh>
</RigidBody>
```

#### About Shapes:

You can however set the shape property directly with `shape=’box’` etc.
If the system can’t determine the shape, it will unwrap the mesh and build a convex shape (giftwrapping) of the mesh. As of right now it’s fairly basic convex generation.

### About Trimeshes:

To get a Trimesh shape you must specify trimesh. We do this because trimesh is actually the most difficult shape and most likely to not work correctly. For example Jolt docs say Dynamic & Kinematic Trimeshes cannot collide with each other or heightmaps, doing so will throw errors.

#### Compound Shapes:

To get a compound shape simply add multiple meshes and position them as if they are inside a group ( in local space).

```tsx
<RigidBody position={[-2, 15, 4]}>
    <mesh>
        <cylinderGeometry args={[0.5, 0.5, 3, 32]} />
        <meshStandardMaterial color="yellow" />
    </mesh>
    <mesh position={[0, -2, 0]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="yellow" />
    </mesh>
    <mesh position={[0, 2, 0]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial color="yellow" />
    </mesh>
</RigidBody>
```

#### Ignoring Meshes in shapes

You can have meshes or items within the rigid body but not generate shapes by adding the ignore attribute.
(NOTE: this may change in the future as we look to add a `<shape>` component to generate the shape but not display)

#### Properties (Component Level)

Many of the properties and options can be set at the component level.
// example of rb props

-   type (Dynamic, static, kinetic, rig)
-   shape
-   position
    Setting position or rotation will teleport the body immediately
-   rotation
-   debug
    Debug can be set on a per-object basis and wont trigger the entire system to go into debug. However, changing this prop wont disable debug at the global level.

-   _Events_
    onContactAdded, onContactRemoved, onContactPersisted
    _future_
-   isSensor
-   onSleep
-   onWake

#### BodyState

However some will need to be set on the BodyState directly. To get the BodyState for a body, you can either access it via the ref property, or request the body from the BodySystem.

As a ref:

```tsx
const myBody = useRef<BodyState>();
useEffect(() => {
    myBody.current.applyImpulse([2, 3, 1]);
}, []);

return (
    <>
        <RigidBody ref={myBody}></RigidBody>
    </>
);
```

// accessing BodyState with bodySystem

```tsx
const bodyHandle = props.bodyHandle;
const { bodySystem } = useJolt();

useEffect(() => {
    bodySystem.dynamicBodies.forEach((body: BodyState) => body.applyImpulse([0, 2, 1]));
    const myBody = bodySystem.getBody(bodyHandle);
    if (myBody) myBody.position = new THREE.Vector3(0, 3, 2);
}, []);
```

// props and methods on the BodyState

---

### InstancedRigidBodyMesh

Instancing lets you display many of the same meshes at a time with a single draw call. R3/Jolt supports that by creating bodies for each instance and automatically updating their positions.
R3/Jolt works a little different than r3/rapier in how we handle instances. We replace the normal <instancedMesh> component with <instancedRigidBodyMesh>
Anything inside is treated like RigidBody and creates the shape and mesh for the subsequent instances.
The only other prop we need is the count of instances.
Once setup, R3/Jolt automatically generates an array of all the BodyStates for each instance and this is what you’ll get on the ref
// instances example

This may seem odd. But this actually gives you significantly more control over the instance than simply forcing the position and rotation. Or only passing them at creation.

There is some concern if you don’t specify a position, as it will try to put all the bodies in roughly the same position.(We actually add a slight jitter) and the physics system will push them out with force as the next item comes into position. (This may be what you want with a shape fountain)

In the future we may allow passing an initial position array.
We also plan to allow passing an instance matrix directly. We know that when you use instancing with a GLTF that it automatically creates the matrix containing all position and color data automatically. It’s annoying to convert this to an array and would be easier to just pass directly. We’re working on it..

---

### Raycasting

R3/Jolt actually has a pretty robust raycaster. It works similarly to ThreeJS’s raycaster with some additional options and built in debugging.
At the moment to best see the raycaster see the raycasting demo. Each cast shows some of the features.

Raycasting also has a multicaster. Which allows you to setup multiple ray origins and/or destinations to cast many rays with a single request. This is common with sweeps and detections

Shapecasting is coming soon.

---

### Heightfield

The heightfield component generates a plane and automatically creates a heightfield mesh and rigidbody.
The heightfield can be an image URL, image, or texture // testing needed for other types
And can be updated after creation // should be fine, test.

Heightfields are heavy, so don’t make them too big or use too many. It’s best to update and use other static bodies together to create the effect you want.

Be warry of contact events on heightfields. Honestly, best not to even use them as they fire for every single triangle in the mesh and can easily confuse the contact listener. Meaning you’ll never correctly detect when the item stops contacting.

It’s unclear if this is true from the perspective of the other shape, but know contact listening heightfields is currently buggy.

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



## MotionSources
MotionSources are special types of bodies that modify other bodies when they come into contact with them. These aren’t explicit objects in Jolt but common patterns that we’ve standardized and simplified. These are incredibly flexible and have a ton of options we’ll try to cover.

MotionSources can be one of three types: 
- **Linear:** Apply a impulse/force towards a set vector.
- **Angular:** Apply a force/torque
- **Teleport:** Move a body to  a worldSpace location.

### Linear:
```ts
leftConveyor.current.activateMotionSource(new THREE.Vector3(-2.4, 0, 0));
```
The vector is in LOCAL SPACE

#### Conveyor:
By setting the Y value to 0 we can apply a motion to another body as if it were on a conveyor belt.
```ts
const leftConveyor = useRef();
useMount(() => {
    leftConveyor.current.activateMotionSource(new THREE.Vector3(-2.4, 0, 0));
});
return (
    <RigidBody
        ref={leftConveyor}
        rotation={[0, 1.57, -0.1]}
        position={[-14, 4, -10]}
        type="static">
        <mesh>
            <boxGeometry args={[15, 1, 5]} />
            <meshStandardMaterial color="#087E8B" />
        </mesh>
    </RigidBody>)
```

#### SurfaceVelocity
The core Jolt examples modify the surface velocity of the body that comes into contact with the conveyor belt. This provides a slightly more realistic physics simulation but only works if the bodies remain in contact (like a conveyor belt).

 By default we instead apply an impulse to the body, which instead of at the contacting surface, is applied to the center of gravity. 99% of the time you wont notice a difference.

To use Surface Velocity:
```ts
rearConveyor.current.motionAsSurfaceVelocity = true;
```

### Bounce-pad:
Because we are applying an impulse we can actually point it anywhere we want with however much force we want. This is a perfect example of a bounce/jump pad.

Remember, by default the vector is in **LOCAL** space, so if you rotate the pad, the direction will also be rotated. 
```ts
useMount(() => {
    angledBouncer.current!.activateMotionSource(new THREE.Vector3(0, 300, 0));
})
return (
    <RigidBody
        ref={angledBouncer}
        position={[-14, 1.5, 2]}
        rotation={[dtr(45), 0, 0]}
        type="static">
        <mesh>
            <boxGeometry args={[5, 0.2, 5]} />
            <meshStandardMaterial color="#FE5E41" />
        </mesh>
    </RigidBody>
)

```

You can change the direction of the vector at any point.
```ts
const intervals = useSetInterval();
intervals.setInterval(() => {
    randomBouncer.current!.motionLinearVector = getRandomVector(300);
}, 4000);
```

#### Forcefield:
When we set a RigidBody to a sensor (`isSensor`) it still fires contact events but does not cause collisions. This means we can apply our impulse while the body is inside the sensor. 
```ts
// setup the forcefield
forcefield.current!.activateMotionSource(new THREE.Vector3(3.6, 10, -0.7));
//disable auto rotation of field vector
forcefield.current!.useRotation = false;
```

#### Disabling Auto-Rotation
With conveyors and bouncepads you’ll probably want to leave the auto rotation as it makes life easier. However, we’ve found force-fields need a lot more precision control. Disabling rotation will put the vector into WORLD SPACE. Remember you’ll have to fight gravity to go up etc. 


### Angular:
Angular applies a rotation to bodies that come into contact.
```ts
// Lazy Susan --------------------------------
susan.current!.activateMotionSource(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 50, 0)
);
susan.current!.motionType = "angular";
// this makes the susan use surface velocity
susan.current!.motionAsSurfaceVelocity = true;
```
*Note angular also needs a linear vector

### SurfaceVelocity:
For angular, you may actually want the surface velocity. It will take the origin of the sourceBody into account and rotate in a more natural way. Almost as if the surface itself was actually rotating _(which would actually be more efficient than using a motionSource)_
If you DON’T use this, when the body contacts the sourceBody, it will immediately get the torque applied to it. _(see the green cubes in the example)_

### Teleports:
We utilize the same core logic and systems to trigger a position and/or rotation change that will take place on the next step.
This utilizes the sourceBodies linearVector (set when you activate the motionSource) 

```ts
// Teleporter --------------------------------
teleporter.current!.activateMotionSource(new THREE.Vector3(-40, 20, -35));
teleporter.current!.isTeleporter = true;
```


---

### Helper components

#### Floor

#### MeshFloor

---

### useJolt();

If you want to interface with any of R3/Jolts active systems or access the Jolt system directly use this hook anywhere inside the <Physics> context.

#### physicsSystem

This is the core physics system. All other systems link here and you can get to them through this system if you really needed. This also holds the active interfaces, and most of the api to manage the simulation.
//TODO make a physicsSystem API docs

#### bodySystem

This is a shortener for physicsSystem.bodySystem. Many times you dont need to mess with the physicsSystem but the bodies. Doing
// code example
Makes access easier
// TODO: api on bodySystem

#### debug

This is the debug state of the system and is updated reactively.
// TODO test if this is true, also test if it can be set directly as a setter

### paused

This is the paused state of the system and is updated reactively.
// TODO test if this is true, also test if it can be set directly as a setter

### jolt

This is the core WASM module. Be VERY CAREFUL when messing with this directly. R3/Jolt can’t save you if you mess it up.

### joltInterface

This is the running Jolt Interface for this simulation. Be VERY CAREFUL when messing with this directly.

### step

This is the running step call. Currently manual stepping isn’t setup, but when it is calling this function will progress the simulation a single step.

---

### Other library items:

### Vehicles:

We have working four wheel and two wheel controllers.
They need some minor attention before being released.

### Character controller.

The controller actually works, but needs some attention

### Camera rig

This goes hand in hand with the character controller. It’s pretty advanced but may need a refactor.
Heightfield tools
This will eventually allow you to generate heightfields in realtime from noise algorithms.

---

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
