## Overview

When using Jolt in javascript it is VERY IMPORTANT to manage and keep track of memory.

Javascript developers are spoiled by automatic garbage collection and cleanup by removing references.

These habits will at a minimum cause memory leaks, at worse, crash things.

First read and understand [The official Jolt Docs](https://github.com/jrouwe/JoltPhysics.js?tab=readme-ov-file#memory-management)

(Sidenote, haven't run into many cases with the whole ref count thing)

### New (ing) things

If you create a Jolt object, **You MUST destroy it**
Anything created like `new Raw.module.Vec3();` is a hanging reference and will NEVER be destroyed.

Consider:

```js
const myObject {
    position: new Raw.module.Vec3(1,2,3);
}
delete myObject;
```

In Javascript, this would free the reference to `myObject` and it would be garbage collected. **THIS IS NOT TRUE FOR JOLT**.
That reference will hang in memory forever and now have no handle to delete it.

This is also true when using helpers like our `vec3` helper.
It is very tempting to do:

```js
ray.origin = vec3.jolt(oldPosition);
```

However, the helper is creating a new object behind the scenes, and now you passed it to Jolt and have no handle or reference to it.

A better way is:

```js
const newOrigin = vec3.jolt(oldPosition);
ray.origin = newOrigin;
Raw.module.destroy(newOrigin);
```

**Special Note**
In cases like rays or bodies that have vectors for properties it's even safer to use the `Set()` Jolt method:

```js
ray.origin.Set(oldPosition.x, oldPosition.y, oldPosition.z);
```

### Destroying Things

In general, if you created it, you can destroy it.

```js
const myBodyID = new Raw.module.BodyID();
Raw.module.destroy(myBodyID);
```

However, be **VERY CAREFUL** about destroying things you get from Jolt.
The `RaycastHit` class takes a `RaycastResponse` object in it's constructor. To be safe we destroyed it after processing the values from it.

```js
class RaycastHit(mHit) {
    // do stuff with hit..

    // we are done, best to cleanup
    Raw.module.destroy(mHit);
}
this.collector.hits.forEach(mHit => myHits.push(new RayCastHit(mHit)));
```

**THIS BROKE THINGS WITH NO ERROR MESSAGE**

`mHit` was actually processed from `collector.hits` which you can see is a reference value of the `collector` and didn't need to be destroyed. When Jolt internals try to destroy the hits, it corrupts the memory and throws errors in totally different places.

This would also happen if you tried to destroy a reference like:

```js
Raw.module.destroy(ray.origin);
```

However, you can (and should) destroy the ray itself when done

```js
Raw.module.destroy(ray);
```

_What about getters?_
It's unclear if a getter is returning a reference or a new object. Be cautious and test.

```js
const standardSettings = Shape.GetShapeSettings();
```

returns a NEW object, not a reference to the original. So at this point in time we assume objects to be called from Getters are NEW OBJECTS. That also means they MUST BE DESTROYED.

** Pay special attention to Ref objects like ShapeSettings. It's still not 100% how they work with destruction**

### Destroying Bodies

As mentioned in the Jolt Docs:

> The Body class is also a special case, it is destroyed through BodyInterface.DestroyBody(body.GetID()) (which internally destroys the Body).

If you need to destroy a body:

-   If you're using this library that body should have a `BodyState` and you shouldn't need to be interfacing with the `Jolt.Body` so directly.
-   Both the `BodyState` and `BodySystem` have destroy or remove methods that we work hard to protect from the various pitfalls and memory problems.
-   If you are working within the library or on something more specialized, remember never to call destroy on the body directly. This corrupts the memory and breaks things. Instead use the bodyInterface` to do it. DONT FORGET, YOU MUST REMOVE AND DESTROY

```js
bodyInterface.RemoveBody(BodyID);
bodyInterface.DestroyBody(BodyID);
```

Failure to remove the body before destroying it will cause big problems that don't throw error messages.

These are my notes for now...
