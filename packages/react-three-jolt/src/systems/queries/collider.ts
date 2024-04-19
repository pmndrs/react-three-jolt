// does a collision test with a shape. based on raycaster
//import { PhysicsSystem } from '../physics-system';
import { Layer } from '../../constants';
import * as THREE from 'three';

import type Jolt from 'jolt-physics';
import { Raw } from '../../raw';
import { generateJoltMatrix, vec3 } from '../../utils';

type CollideShapeCollector =
    | Jolt.CollideShapeAllHitCollisionCollector
    | Jolt.CollideShapeAnyHitCollisionCollector
    | Jolt.CollideShapeClosestHitCollisionCollector;
//| Jolt.CollideShapeCollectorJS;

type CollectorTypeString = 'closest' | 'any' | 'all';

export class ShapeCollider {
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;
    // filters
    bpFilter: Jolt.DefaultBroadPhaseLayerFilter;
    objectFilter: Jolt.DefaultObjectLayerFilter;
    // TODO figure out how to do custom body filters
    bodyFilter: Jolt.BodyFilter = new Raw.module.BodyFilter(); // BodyFilterJS?
    shapeFilter: Jolt.ShapeFilter = new Raw.module.ShapeFilter();

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
    activeShape: Jolt.Shape = new Raw.module.SphereShape(1);

    // required jolt props
    shapeScale = new Raw.module.Vec3(1, 1, 1);
    centerOfMassTransform = new Raw.module.RMat44();
    baseOffset = new Raw.module.Vec3(0, 0, 0);

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.joltInterface = joltInterface;
        // these two filters mean the ray will cast as if its a dynamic object
        this.bpFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
            joltInterface.GetObjectVsBroadPhaseLayerFilter(),
            Layer.MOVING
        );
        this.objectFilter = new Raw.module.DefaultObjectLayerFilter(
            joltInterface.GetObjectLayerPairFilter(),
            Layer.MOVING
        );
    }

    destroy() {}

    //raw jolt cast query
    rawCast() {
        console.log('Raw Collide Shape Query');
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
        //if we had a shape already, we need to destroy it
        if (this.activeShape) Raw.module.destroy(this.activeShape);
        this.activeShape = shape;
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

    cast(successHandler: any, failHandler: any) {
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
        failHandler();
        return false;
    }

    //* Internal Methods ===============================
    // set the matrix for the cast
    setJoltMatrix() {
        this.centerOfMassTransform = generateJoltMatrix(this.position, this.rotation);
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

    constructor(_joltPhysicsSystem: Jolt.PhysicsSystem, shapeMatrix: any, mHit: Jolt.CollideShapeResult) {
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
