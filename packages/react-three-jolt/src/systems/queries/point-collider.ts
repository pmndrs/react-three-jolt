// `NarrowPhaseQuery.CollidePoint` (issue #248): "which bodies contain this point right now" - a
// spawn-point check, a click-to-select-what's-under-the-cursor-in-3D test, a trigger volume made
// of an arbitrary shape rather than a sensor body.
//
// Modeled directly on ShapeCollider (collider.ts): same QueryBase filters/destroy template, same
// 'closest'/'any'/'all' collector switch. It is simpler than ShapeCollider in one respect - a
// point has no shape, scale or rotation, just a world-space position - and Jolt's own result
// (`CollidePointResult`) is correspondingly thin: a body and a sub-shape id, no contact points or
// penetration depth (a point is either inside a shape or it isn't).

import type Jolt from 'jolt-physics';
import type * as THREE from 'three';
import { Raw } from '../../raw';
import { type anyVec3, vec3 } from '../../utils';
import { type CastFailHandler, type CastSuccessHandler, QueryBase } from './query-base';

type CollidePointCollector =
    | Jolt.CollidePointAllHitCollisionCollector
    | Jolt.CollidePointAnyHitCollisionCollector
    | Jolt.CollidePointClosestHitCollisionCollector;

export type PointCollectorType = 'closest' | 'any' | 'all';

export class PointCollider extends QueryBase {
    type: PointCollectorType = 'closest';

    collector: CollidePointCollector = new Raw.module.CollidePointClosestHitCollisionCollector();
    hits: PointCollisionResult[] = [];
    hasCast = false;

    // world-space point CollidePoint takes an RVec3, and it is the sole source of truth for
    // `point` (mirrors Raycaster.origin/direction, which read/write `this.ray.mOrigin`/
    // `mDirection` directly rather than keeping a parallel THREE.Vector3 field). Kept alive for
    // the collider's whole lifetime and mutated in place via `.Set()` on every write instead of
    // being replaced - a caller driving `point` every frame (a ground probe, say) allocates no
    // WASM memory doing so.
    private scratchPoint: Jolt.RVec3 = new Raw.module.RVec3(0, 0, 0);

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);
        this.createFilters();
    }

    // Free every Jolt object this collider allocated. Idempotent - safe to call more than once.
    protected releaseResources(): void {
        this.destroyFilters();
        Raw.module.destroy(this.collector);
        Raw.module.destroy(this.scratchPoint);

        // null everything out so a stray call after destroy() fails loudly (or is a no-op)
        // instead of silently touching freed memory - see ShapeCollider.releaseResources.
        this.bodyFilter = null as unknown as Jolt.BodyFilter;
        this.shapeFilter = null as unknown as Jolt.ShapeFilter;
        this.bpFilter = null as unknown as Jolt.DefaultBroadPhaseLayerFilter;
        this.objectFilter = null as unknown as Jolt.DefaultObjectLayerFilter;
        this.collector = null as unknown as CollidePointCollector;
        this.scratchPoint = null as unknown as Jolt.RVec3;
    }

    //raw jolt cast query
    rawCast() {
        this.joltPhysicsSystem
            .GetNarrowPhaseQuery()
            .CollidePoint(
                this.scratchPoint,
                this.collector,
                this.bpFilter,
                this.objectFilter,
                this.bodyFilter,
                this.shapeFilter
            );
    }

    //* Properties ====================================

    get point(): THREE.Vector3 {
        return vec3.three(this.scratchPoint);
    }
    set point(point: anyVec3) {
        if (this.checkDestroyed()) return;
        const newVec = vec3.three(point);
        this.scratchPoint.Set(newVec.x, newVec.y, newVec.z);
    }

    //* Methods =======================================
    // set the collector
    setCollector(type: PointCollectorType = 'closest') {
        if (this.checkDestroyed()) return;
        // destroy existing collector
        if (this.collector) Raw.module.destroy(this.collector);
        this.type = type;
        switch (type) {
            case 'any':
                this.collector = new Raw.module.CollidePointAnyHitCollisionCollector();
                break;
            case 'all':
                this.collector = new Raw.module.CollidePointAllHitCollisionCollector();
                break;
            default:
                this.collector = new Raw.module.CollidePointClosestHitCollisionCollector();
                break;
        }
    }

    cast(
        successHandler?: CastSuccessHandler<PointCollisionResult>,
        failHandler?: CastFailHandler
    ): PointCollisionResult | PointCollisionResult[] | false {
        if (this.checkDestroyed()) return false;
        // clear the collector
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
            const collector = this.collector as Jolt.CollidePointAllHitCollisionCollector;
            if (this.type === 'all') {
                for (let i = 0; i < collector.mHits.size(); i++) {
                    this.hits.push(new PointCollisionResult(collector.mHits.at(i)));
                }
                if (successHandler) successHandler(this.hits);
            } else {
                // just a single hit result
                const collector = this.collector as Jolt.CollidePointClosestHitCollisionCollector;
                const hit = new PointCollisionResult(collector.mHit);
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
}

export class PointCollisionResult {
    bodyHandle: number;
    // owned by the collector's own hit storage, exactly like ShapeCollider's subShapeId1/2 -
    // read `.GetValue()`, never destroy (see CollisionResult in collider.ts).
    subShapeId2: Jolt.SubShapeID;

    constructor(mHit: Jolt.CollidePointResult) {
        this.bodyHandle = mHit.mBodyID.GetIndexAndSequenceNumber();
        this.subShapeId2 = mHit.mSubShapeID2;
    }
}
