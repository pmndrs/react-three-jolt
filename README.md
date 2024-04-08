packages/react-three-jolt/README.md

Example of how the library correctly handles Jolt Memory so you don't have to:

```js
// raycaster class setter
set direction(value: anyVec3) {
    const newVec = vec3.jolt(value);
    this.ray.mDirection = newVec;
    Raw.module.destroy(newVec);
}
```
