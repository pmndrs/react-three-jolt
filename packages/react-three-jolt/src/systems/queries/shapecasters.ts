// this system lets us create raycasts, shapecasts, and specific collision tests
//import { PhysicsSystem } from '../physics-system';

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../../raw';
import { type anyVec3, generateJoltMatrix, vec3 } from '../../utils';
import { CastQueryBase, HitBase } from './query-base';

type ShapecasterCollector =
    | Jolt.CastShapeAllHitCollisionCollector
    | Jolt.CastShapeClosestHitCollisionCollector
    | Jolt.CastShapeAnyHitCollisionCollector;

export class Shapecaster extends CastQueryBase<ShapecastHit, ShapecasterCollector> {
    // shapecast settings
    shapecast!: Jolt.RShapeCast;
    shapecastSettings = new Raw.module.ShapeCastSettings();
    doIgnoreBackfaceTriangles = true;
    doIgnoreBackfaceConvex = true;

    activePosition = new THREE.Vector3();
    activeRotation = new THREE.Quaternion();
    activeDirection = new THREE.Vector3();
    activeScale = new THREE.Vector3(1, 1, 1);
    /** Default cast shape, owned by this caster: see the AddRef in the constructor. */
    activeShape: Jolt.Shape = new Raw.module.SphereShape(0.5);

    // probably never need this
    baseOffset = new Raw.module.RVec3(0, 0, 0);

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);
        // `activeShape` is a Jolt reference counted object (RefTarget) and `new SphereShape(...)`
        // starts it at zero references (see the jolt-physics README's "Reference counting
        // objects" section). `RShapeCast` stores a *raw* pointer to it - verified against
        // jolt-physics 1.1.0: the sphere's refcount is still 0 after the cast is constructed,
        // and its 40 bytes are still allocated after the cast is destroyed - so nothing else
        // will ever free it (the leak flagged on issue #162). AddRef() here also means the
        // `shape` setter/destroy() below can treat `activeShape` uniformly with Release(),
        // whether it is this default shape or one a caller handed us. Mirrors `ShapeCollider`
        // (#174/issue #142).
        this.activeShape.AddRef();
        this.createFilters();
        // initialize the shapecast
        this.initializeShapecast();

        // initialize the collector
        this.setCollector();
    }
    // Cleanup ---------------------------------------
    protected releaseResources(): void {
        this.active = false;
        this.stopDebugging();
        this._disposeDebugResources();

        // `activeShape` is reference counted - see the `shape` setter and the constructor. We
        // AddRef()'d whatever shape we're holding, so give that reference back with Release()
        // rather than a hard destroy(), which would free memory a caller (or another owner) might
        // still be using (issue #192, mirrors ShapeCollider from #174).
        if (this.activeShape) {
            this.activeShape.Release();
            this.activeShape = null as unknown as Jolt.Shape;
        }

        Raw.module.destroy(this.shapecast);
        Raw.module.destroy(this.shapecastSettings);
        this.destroyFilters();
        Raw.module.destroy(this.collector);
        Raw.module.destroy(this.baseOffset);
        // give back the reference the constructor took; the shapecast that pointed at it is gone
        if (this.activeShape) {
            this.activeShape.Release();
            this.activeShape = null as unknown as Jolt.Shape;
        }
    }

    // this shouldnt be needed but changing the origin doesn't seem to work correctly
    initializeShapecast() {
        const mat4 = generateJoltMatrix(this.activePosition, this.activeRotation, this.activeScale);
        const scale = vec3.jolt(this.activeScale);
        const direction = vec3.jolt(this.activeDirection);
        const shape = this.activeShape;
        this.shapecast = new Raw.module.RShapeCast(shape, scale, mat4, direction);
        // destroy the temp items
        Raw.module.destroy(mat4);
        Raw.module.destroy(scale);
        Raw.module.destroy(direction);
    }

    //* Getters and Setters ----------------------------
    get origin(): THREE.Vector3 {
        return this.activePosition;
    }
    set origin(value: anyVec3) {
        const newVec = vec3.three(value);
        this.activePosition = newVec;
        this.setOrigin();
    }
    get rotation(): THREE.Quaternion {
        return this.activeRotation;
    }
    set rotation(value: THREE.Quaternion) {
        this.activeRotation = value;
        this.setOrigin();
    }
    get scale(): THREE.Vector3 {
        return this.activeScale;
    }
    set scale(value: anyVec3) {
        this.activeScale = vec3.three(value);
        this.setOrigin();
    }
    get direction(): THREE.Vector3 {
        return vec3.three(this.shapecast.mDirection);
    }
    set direction(value: anyVec3) {
        const newVec = vec3.three(value);
        this.shapecast.mDirection.Set(newVec.x, newVec.y, newVec.z);
    }
    get ignoreBackfaceTriangles() {
        return this.doIgnoreBackfaceTriangles;
    }
    set ignoreBackfaceTriangles(value) {
        this.doIgnoreBackfaceTriangles = value;
        if (value)
            this.shapecastSettings.mBackFaceModeTriangles =
                Raw.module.EBackFaceMode_IgnoreBackFaces;
        else
            this.shapecastSettings.mBackFaceModeTriangles =
                Raw.module.EBackFaceMode_CollideWithBackFaces;
    }
    get ignoreBackfaceConvex() {
        return this.doIgnoreBackfaceConvex;
    }
    set ignoreBackfaceConvex(value) {
        this.doIgnoreBackfaceConvex = value;
        if (value)
            this.shapecastSettings.mBackFaceModeConvex = Raw.module.EBackFaceMode_IgnoreBackFaces;
        else
            this.shapecastSettings.mBackFaceModeConvex =
                Raw.module.EBackFaceMode_CollideWithBackFaces;
    }
    //shape
    get shape() {
        return this.activeShape;
    }
    set shape(value: Jolt.Shape) {
        if (value === this.activeShape) return;
        // Shape is reference counted (RefTarget) and starts life with a refcount of 0. AddRef()
        // here means a caller that later Release()s (or reassigns) its own reference to `value`
        // doesn't leave us holding a dangling pointer once they're done with theirs, and
        // Release() (rather than a hard destroy()) on whichever shape we're replacing means it's
        // only actually freed once every owner - us included - is done with it. Mirrors
        // `ShapeCollider.shape` (#174/issue #142).
        value.AddRef();
        const previous = this.activeShape;
        this.activeShape = value;
        if (previous) previous.Release();
        // `RShapeCast.mShape` is a read-only getter at runtime - there is no `set_mShape`
        // despite the type declarations advertising one - so the only way to change it is to
        // rebuild the RShapeCast, the same as setOrigin() does for position/rotation/scale.
        // Capture + restore the current direction across the rebuild: initializeShapecast()
        // otherwise reconstructs it from `activeDirection`, which the `direction` setter below
        // never updates (it mutates the live shapecast in place instead), so a naive rebuild here
        // would silently reset direction back to zero.
        const direction = vec3.three(this.shapecast.mDirection);
        Raw.module.destroy(this.shapecast);
        this.initializeShapecast();
        this.direction = direction;
    }

    //* Methods ---------------------------------------
    setOrigin() {
        Raw.module.destroy(this.shapecast);
        this.initializeShapecast();
        //const translation = vec3.jolt(this.activePosition);
        //const rotation = quat.jolt(this.activeRotation);
        //this.shapecast.mCenterOfMassStart.SetTranslation(translation);
        //TODO: Fix this to use the rotation
        //this.shapecast.mCenterOfMassStart.SetRotation(rotation);
        // cleanup
        //Raw.module.destroy(translation);
    }
    //this has no callback, it just triggers the ray and you have to process it
    rawCast(): void {
        if (!this.active) return;
        this.joltPhysicsSystem
            .GetNarrowPhaseQuery()
            .CastShape(
                this.shapecast,
                this.shapecastSettings,
                this.baseOffset,
                this.collector,
                this.bpFilter,
                this.objectFilter,
                this.bodyFilter,
                this.shapeFilter
            );
    }
    protected createCollector(type: string): ShapecasterCollector {
        switch (type) {
            case 'any':
                return new Raw.module.CastShapeAnyHitCollisionCollector();
            case 'all':
                return new Raw.module.CastShapeAllHitCollisionCollector();
            default:
                return new Raw.module.CastShapeClosestHitCollisionCollector();
        }
    }
    protected buildHit(mHit: unknown, index: number): ShapecastHit {
        return new ShapecastHit(
            this.joltPhysicsSystem,
            this.shapecast,
            mHit as Jolt.ShapeCastResult,
            index
        );
    }
}

export class ShapecastHit extends HitBase {
    constructor(
        joltPhysicsSystem: Jolt.PhysicsSystem,
        shapecast: Jolt.RShapeCast,
        mHit: Jolt.ShapeCastResult,
        index = 0,
        bodyID?: Jolt.BodyID
    ) {
        const start = vec3.three(shapecast.mCenterOfMassStart.GetTranslation());
        const end = start.clone().add(vec3.three(shapecast.mDirection));
        // GetPointOnRay returns its Vec3/RVec3 BY VALUE through jolt-physics' WebIDL binder,
        // which hands back a pointer to ONE STATIC TEMPORARY per bound function (overwritten on
        // the next call, shared across every shapecast) - never destroy it. `vec3.three()`
        // copies the components straight out, so there is nothing to free here.
        const position = vec3.three(shapecast.GetPointOnRay(mHit.mFraction));
        const shapeIdValue = mHit.mSubShapeID2.GetValue();
        const bodyHandle = bodyID
            ? bodyID.GetIndexAndSequenceNumber()
            : mHit.mBodyID2.GetIndexAndSequenceNumber();
        super(joltPhysicsSystem, start, end, position, shapeIdValue, bodyHandle, index);
    }
    //TODO Fix this to work with the bodyID Handle after removing BodyID
    /*
    get material(): Jolt.PhysicsMaterial {
        const shape = this.joltPhysicsSystem
            .GetBodyInterface()
            .GetShape(this.bodyID);
        return shape.GetMaterial(this.shapeId);
    }
    */
}
