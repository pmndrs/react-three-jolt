// does a collision test with a shape. based on raycaster

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../../raw';
import { vec3 } from '../../utils';
import { type CastFailHandler, type CastSuccessHandler, QueryBase } from './query-base';

type CollideShapeCollector =
    | Jolt.CollideShapeAllHitCollisionCollector
    | Jolt.CollideShapeAnyHitCollisionCollector
    | Jolt.CollideShapeClosestHitCollisionCollector;
//| Jolt.CollideShapeCollectorJS;

type CollectorTypeString = 'closest' | 'any' | 'all';

export class ShapeCollider extends QueryBase {
    collideShapeSettings: Jolt.CollideShapeSettings = new Raw.module.CollideShapeSettings();
    ignoreBackFaces = false;

    type: CollectorTypeString = 'closest';

    collector: CollideShapeCollector = new Raw.module.CollideShapeClosestHitCollisionCollector();
    hits: CollisionResult[] = [];
    hasCast = false;

    // we add active to these becuase we need them in get/set
    activePosition = new THREE.Vector3();
    activeRotation = new THREE.Quaternion();
    activeScale = new THREE.Vector3(1, 1, 1);

    //primary shape to test against
    activeShape: Jolt.Shape = new Raw.module.SphereShape(0.3);

    // required jolt props
    shapeScale = new Raw.module.Vec3(1, 1, 1);
    // world space transform used for the query. Kept alive for the collider's whole lifetime and
    // mutated in place by setJoltMatrix() instead of being replaced every call - see the comment
    // there for why.
    centerOfMassTransform: Jolt.RMat44 = new Raw.module.RMat44();
    baseOffset = new Raw.module.RVec3(0, 0, 0);

    // scratch objects owned for the collider's lifetime so setJoltMatrix() (called from every
    // position/rotation/matrix setter - CameraBoom.checkCollision does this every frame) never
    // allocates. `.Set()` copies components in place.
    private scratchPosition: Jolt.RVec3 = new Raw.module.RVec3(0, 0, 0);
    private scratchRotation: Jolt.Quat = new Raw.module.Quat(0, 0, 0, 1);

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);
        // `activeShape` is a Jolt reference counted object (RefTarget) and starts life with a
        // refcount of 0 (see the jolt-physics README's "Reference counting objects" section).
        // AddRef() here means the `shape` setter/destroy() below can always treat
        // `activeShape` uniformly with Release(), regardless of whether it's this default shape
        // or one a caller handed us.
        this.activeShape.AddRef();
        this.createFilters();
        // make sure centerOfMassTransform reflects the initial (identity) position/rotation
        // instead of whatever `new RMat44()` default-constructs to.
        this.setJoltMatrix();
    }

    // Free every Jolt object this collider allocated. Idempotent - safe to call more than once
    // (React unmount + an explicit caller cleanup, for example).
    protected releaseResources(): void {
        // `activeShape` is reference counted - see the `shape` setter and the constructor. We
        // AddRef()'d whatever shape we're holding, so give that reference back with Release()
        // rather than a hard destroy(), which would free memory a caller (or another owner) might
        // still be using.
        if (this.activeShape) {
            this.activeShape.Release();
            this.activeShape = null as unknown as Jolt.Shape;
        }

        this.destroyFilters();
        Raw.module.destroy(this.collideShapeSettings);
        Raw.module.destroy(this.collector);
        Raw.module.destroy(this.shapeScale);
        Raw.module.destroy(this.baseOffset);
        Raw.module.destroy(this.centerOfMassTransform);
        Raw.module.destroy(this.scratchPosition);
        Raw.module.destroy(this.scratchRotation);

        // null everything out so a stray call after destroy() fails loudly (or is a no-op)
        // instead of silently touching freed memory.
        this.bodyFilter = null as unknown as Jolt.BodyFilter;
        this.shapeFilter = null as unknown as Jolt.ShapeFilter;
        this.bpFilter = null as unknown as Jolt.DefaultBroadPhaseLayerFilter;
        this.objectFilter = null as unknown as Jolt.DefaultObjectLayerFilter;
        this.collideShapeSettings = null as unknown as Jolt.CollideShapeSettings;
        this.collector = null as unknown as CollideShapeCollector;
        this.shapeScale = null as unknown as Jolt.Vec3;
        this.baseOffset = null as unknown as Jolt.RVec3;
        this.centerOfMassTransform = null as unknown as Jolt.RMat44;
        this.scratchPosition = null as unknown as Jolt.RVec3;
        this.scratchRotation = null as unknown as Jolt.Quat;
    }

    //raw jolt cast query
    rawCast() {
        this.joltPhysicsSystem
            .GetNarrowPhaseQuery()
            .CollideShape(
                this.activeShape,
                this.shapeScale,
                this.centerOfMassTransform,
                this.collideShapeSettings,
                this.baseOffset,
                this.collector,
                this.bpFilter,
                this.objectFilter,
                this.bodyFilter,
                this.shapeFilter
            );
    }

    //* Properties ====================================

    //shape
    get shape() {
        return this.activeShape;
    }
    set shape(shape: Jolt.Shape) {
        if (shape === this.activeShape) return;
        // Shape is reference counted (RefTarget) and starts life with a refcount of 0. AddRef()
        // here means a caller that later Release()s (or reassigns) its own reference to `shape`
        // doesn't leave us holding a dangling pointer once they're done with theirs, and
        // Release() (rather than a hard destroy()) on whichever shape we're replacing means it's
        // only actually freed once every owner - us included - is done with it.
        shape.AddRef();
        const previous = this.activeShape;
        this.activeShape = shape;
        if (previous) previous.Release();
    }
    // possition
    get position() {
        return this.activePosition;
    }
    set position(position: THREE.Vector3) {
        this.activePosition = position;
        this.setJoltMatrix();
    }
    // rotation
    get rotation() {
        return this.activeRotation;
    }
    set rotation(rotation: THREE.Quaternion) {
        this.activeRotation = rotation;
        this.setJoltMatrix();
    }
    // matrix
    get matrix() {
        return new THREE.Matrix4().compose(this.position, this.rotation, this.activeScale);
    }
    set matrix(matrix: THREE.Matrix4) {
        // destructure the matrix onto our position and rotation
        matrix.decompose(this.position, this.rotation, new THREE.Vector3());
        this.setJoltMatrix();
    }

    //* Methods =======================================
    // set the collector
    setCollector(type: CollectorTypeString = 'closest') {
        //console.log('setting collector', type);
        // destroy exising collector
        if (this.collector) Raw.module.destroy(this.collector);
        this.type = type;
        switch (type) {
            case 'any':
                this.collector = new Raw.module.CollideShapeAnyHitCollisionCollector();
                break;
            case 'all':
                this.collector = new Raw.module.CollideShapeAllHitCollisionCollector();
                break;
            default:
                this.collector = new Raw.module.CollideShapeClosestHitCollisionCollector();
                break;
        }
    }

    cast(
        successHandler?: CastSuccessHandler<CollisionResult>,
        failHandler?: CastFailHandler
    ): CollisionResult | CollisionResult[] | false {
        // clear the collector
        //if (this.hasCast && this.type !== 'closest')
        this.collector.Reset();
        this.hasCast = true;
        // clear the hits
        this.hits = [];
        // run the cast
        this.rawCast();
        // handle results
        if (this.collector.HadHit()) {
            // if its all it will be an array of items
            // we do this to appease the typegods
            const collector = this.collector as Jolt.CollideShapeAllHitCollisionCollector;
            if (this.type === 'all') {
                for (let i = 0; i < collector.mHits.size(); i++) {
                    this.hits.push(
                        new CollisionResult(
                            this.joltPhysicsSystem,
                            this.matrix,
                            collector.mHits.at(i)
                        )
                    );
                }
                if (successHandler) successHandler(this.hits);
            } else {
                // just a single hit result
                const collector = this.collector as Jolt.CollideShapeClosestHitCollisionCollector;
                const hit = new CollisionResult(
                    this.joltPhysicsSystem,
                    this.matrix,
                    collector.mHit
                );
                this.hits.push(hit);
                if (successHandler) successHandler(hit);
            }
            // return single if just one, or array if multi.
            if (this.hits.length > 0) {
                if (this.hits.length === 1) return this.hits[0];
                return this.hits;
            }
        }
        if (failHandler) failHandler();
        return false;
    }

    //* Internal Methods ===============================
    // set the matrix for the cast
    setJoltMatrix() {
        // Mutate the persistent scratch position/rotation and centerOfMassTransform in place
        // instead of allocating a new RMat44 every call. This runs from every position/rotation/
        // matrix setter, and CameraBoom.checkCollision sets `collider.position` every frame, so a
        // naive `this.centerOfMassTransform = generateJoltMatrix(...)` here means a brand new
        // RMat44 every frame (utils/general.ts's generateJoltMatrix always returns a new
        // caller-owned object precisely so callers who DO want a fresh one can free it - see its
        // docstring). `.Set()` on RVec3/Quat copies components in place, no allocation.
        //
        // RMat44 has no SetRotation(Quat) overload, only SetRotation(Mat44), so we go through
        // Mat44.sRotation() to build the 3x3 part. Its by-value return is a single static
        // temporary owned by the emscripten WebIDL binder (overwritten on the next call to that
        // same function, never destroy()ed - see the "CRITICAL Jolt memory facts" in the repo
        // brief) - SetRotation() copies out of it immediately, before anything else can
        // overwrite it.
        this.scratchPosition.Set(
            this.activePosition.x,
            this.activePosition.y,
            this.activePosition.z
        );
        this.scratchRotation.Set(
            this.activeRotation.x,
            this.activeRotation.y,
            this.activeRotation.z,
            this.activeRotation.w
        );
        this.centerOfMassTransform.SetRotation(
            Raw.module.Mat44.prototype.sRotation(this.scratchRotation)
        );
        this.centerOfMassTransform.SetTranslation(this.scratchPosition);
    }

    //
}

export class CollisionResult {
    contactPointOn1: THREE.Vector3;
    contactPointOn2: THREE.Vector3;
    penetrationAxis: THREE.Vector3;
    contactNormal: THREE.Vector3;
    penetrationDepth: number;
    subShapeId1: Jolt.SubShapeID;
    subShapeId2: Jolt.SubShapeID;
    bodyHandle: number;
    shapeMatrix: THREE.Matrix4;

    //private joltPhysicsSystem: Jolt.PhysicsSystem;

    constructor(
        _joltPhysicsSystem: Jolt.PhysicsSystem,
        shapeMatrix: THREE.Matrix4,
        mHit: Jolt.CollideShapeResult
    ) {
        //this.joltPhysicsSystem = joltPhysicsSystem;
        this.shapeMatrix = shapeMatrix;
        this.contactPointOn1 = vec3.three(mHit.mContactPointOn1);
        this.contactPointOn2 = vec3.three(mHit.mContactPointOn2);
        this.penetrationAxis = vec3.three(mHit.mPenetrationAxis);
        this.contactNormal = vec3.three(mHit.mPenetrationAxis).normalize();
        this.penetrationDepth = mHit.mPenetrationDepth;
        this.subShapeId1 = mHit.mSubShapeID1;
        this.subShapeId2 = mHit.mSubShapeID2;
        this.bodyHandle = mHit.mBodyID2.GetIndexAndSequenceNumber();
    }
}
