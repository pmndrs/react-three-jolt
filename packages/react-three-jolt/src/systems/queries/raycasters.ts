// this system lets us create raycasts, shapecasts, and specific collision tests

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../../raw';
import { type anyVec3, vec3 } from '../../utils';
import { CastQueryBase, HitBase, QueryBase } from './query-base';

type RaycasterCollector =
    | Jolt.CastRayAllHitCollisionCollector
    | Jolt.CastRayClosestHitCollisionCollector
    | Jolt.CastRayAnyHitCollisionCollector
    | Jolt.CastRayCollectorJS;

export class Raycaster extends CastQueryBase<RaycastHit, RaycasterCollector> {
    // ray settings
    ray = new Raw.module.RRayCast();
    raySettings = new Raw.module.RayCastSettings();
    doCullBackFaces = true;

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);
        this.createFilters();

        // initialize the ray origin and destination
        this.ray.mOrigin.Set(0, 0, 0);
        this.ray.mDirection.Set(10, 10, 10);

        // initialize the collector
        this.setCollector();
    }
    // Cleanup ---------------------------------------
    protected releaseResources(): void {
        this.active = false;
        this.stopDebugging();
        this._disposeDebugResources();
        Raw.module.destroy(this.ray);
        Raw.module.destroy(this.raySettings);
        this.destroyFilters();
        Raw.module.destroy(this.collector);
        //console.log('Raycaster destroyed    ');
    }

    //* Getters and Setters ----------------------------
    get origin(): THREE.Vector3 {
        return vec3.three(this.ray.mOrigin);
    }
    set origin(value: anyVec3) {
        const newVec = vec3.three(value);
        this.ray.mOrigin.Set(newVec.x, newVec.y, newVec.z);
    }
    get direction(): THREE.Vector3 {
        return vec3.three(this.ray.mDirection);
    }
    set direction(value: anyVec3) {
        const newVec = vec3.three(value);
        this.ray.mDirection.Set(newVec.x, newVec.y, newVec.z);
    }
    get cullBackFaces() {
        return this.doCullBackFaces;
    }
    set cullBackFaces(value) {
        // jolt split RayCastSettings.mBackFaceMode into mBackFaceModeTriangles and
        // mBackFaceModeConvex; SetBackFaceMode sets both, which is what the single field did.
        this.raySettings.SetBackFaceMode(
            value
                ? Raw.module.EBackFaceMode_IgnoreBackFaces
                : Raw.module.EBackFaceMode_CollideWithBackFaces
        );
    }

    //* Methods ---------------------------------------
    //this has no callback, it just triggers the ray and you have to process it
    rawCast(): void {
        if (!this.active) return;
        // console.log('Raw Casting...');
        this.joltPhysicsSystem
            .GetNarrowPhaseQuery()
            .CastRay(
                this.ray,
                this.raySettings,
                this.collector,
                this.bpFilter,
                this.objectFilter,
                this.bodyFilter,
                this.shapeFilter
            );
    }
    protected createCollector(type: string): RaycasterCollector {
        switch (type) {
            case 'any':
                return new Raw.module.CastRayAnyHitCollisionCollector();
            case 'all':
                return new Raw.module.CastRayAllHitCollisionCollector();
            default:
                return new Raw.module.CastRayClosestHitCollisionCollector();
        }
    }
    protected buildHit(mHit: unknown, index: number): RaycastHit {
        return new RaycastHit(this.joltPhysicsSystem, this.ray, mHit as Jolt.RayCastResult, index);
    }
}

// More advanced raycast with collector level customizing. Way more advanced,
// probably never to be used but its here if you need it
//TODO: This might have some bind/apply scope issues
export class AdvancedRaycaster extends Raycaster {
    declare collector: Jolt.CastRayCollectorJS;
    //@ts-ignore
    activeBody: Jolt.Body;
    collisionCount = 0;
    hits: RaycastHit[] = [];
    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);

        // the base constructor's setCollector() already built a "closest" native collector;
        // free it before swapping in our JS collector instead of leaking it.
        Raw.module.destroy(this.collector);
        this.collector = new Raw.module.CastRayCollectorJS();

        // jolt-physics' JSImplementation requires Reset/OnBody/AddHit to exist as the
        // collector's OWN properties before it is ever passed to CastRay - otherwise embind
        // throws "a JSImplementation must implement all functions" the first time the engine
        // calls back into an unimplemented one. Install no-op defaults so a freshly created
        // AdvancedRaycaster can cast() immediately; onBody()/addHit()/onReset() below let
        // callers override them.
        this.collector.Reset = () => {
            this.collisionCount = 0;
            this.hits = [];
        };
        this.collector.OnBody = () => {};
        this.collector.AddHit = () => {};
    }
    // pass through for the onBody
    onBody(handler: any) {
        this.collector.OnBody = (body) => {
            //@ts-ignore wrapPointer TS bug
            body = Raw.module.wrapPointer(body, Raw.module.Body);
            //@ts-ignore
            this.activeBody = body;
            handler(body, this.collector);
        };
    }
    // runs on every hit
    addHit(handler: any) {
        //@ts-ignore
        this.collector.AddHit = (result: Jolt.RayCastResult) => {
            //@ts-ignore wrap pointer TS bug
            result = Raw.module.wrapPointer(result, Raw.module.RayCastResult);
            const hit = new RaycastHit(
                this.joltPhysicsSystem,
                this.ray,
                result,
                this.collisionCount,
                this.activeBody.GetID()
            );
            this.collisionCount++;
            this.hits.push(hit);
            const bail = handler(hit, this.collector);
            if (bail) this.collector.UpdateEarlyOutFraction(result.mFraction);
        };
    }
    onReset(handler?: any) {
        this.collector.Reset = () => {
            this.collisionCount = 0;
            this.hits = [];
            if (handler) handler(this.collector);
            this.collector.ResetEarlyOutFraction();
        };
    }
    reset() {
        this.collector.Reset();
    }

    // slight override on the parent class as we have to call override on our
    // raw handler. Reset happens BEFORE the cast (clearing hits/collisionCount left over from
    // the previous call), not after - resetting afterwards would wipe out the hits this very
    // cast just collected before the caller ever sees them.
    //@ts-ignore
    cast(successHandler?: any, failHandler?: any) {
        if (this.hasCast) this.reset();
        this.hasCast = true;
        this.rawCast();
        if (this.hits.length > 0) {
            if (successHandler) {
                if (this.type === 'all') {
                    this.hits.forEach((hit) => successHandler(hit));
                    return this.hits;
                } else {
                    successHandler(this.hits[0]);
                    return this.hits[0];
                }
            }
        } else if (failHandler) failHandler();
    }
}

export class RaycastHit extends HitBase {
    constructor(
        joltPhysicsSystem: Jolt.PhysicsSystem,
        ray: Jolt.RRayCast,
        mHit: Jolt.RayCastResult,
        index = 0,
        bodyID?: Jolt.BodyID
    ) {
        const start = vec3.three(ray.mOrigin);
        const end = start.clone().add(vec3.three(ray.mDirection));
        // GetPointOnRay returns a Vec3/RVec3 BY VALUE through jolt-physics' WebIDL binder, which
        // hands back a pointer to ONE STATIC TEMPORARY per bound function (overwritten on the
        // next call to GetPointOnRay, shared across every RayCast instance) - never call
        // Raw.module.destroy() on it, that would free memory the binder still owns and reuses.
        // vec3.three() copies the components out into a plain THREE.Vector3 immediately, so
        // there is nothing left for us to (nor should we) free here.
        const position = vec3.three(ray.GetPointOnRay(mHit.mFraction));
        const shapeIdValue = mHit.mSubShapeID2.GetValue();
        // mHit.mBodyID/mSubShapeID2 are references into the collector's own result storage, not
        // ours to destroy either.
        const bodyHandle = bodyID
            ? bodyID.GetIndexAndSequenceNumber()
            : mHit.mBodyID.GetIndexAndSequenceNumber();
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

// Multicast takes an array of positions and casts rays to all of them
export class Multicaster extends QueryBase {
    raycaster: Raycaster;
    hits: RaycastHit[] = [];
    positions: THREE.Vector3[] = [];
    rays: { origin: THREE.Vector3; destination: THREE.Vector3 }[] = [];
    results: {
        origin: THREE.Vector3;
        destination?: any;
        direction?: any;
        hits: RaycastHit | RaycastHit[];
    }[] = [];
    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        super(joltPhysicsSystem, joltInterface);
        this.raycaster = new Raycaster(joltPhysicsSystem, joltInterface);
    }
    // Cleanup ---------------------------------------
    // Multicaster owns a Raycaster (and, through it, the ray/settings/filters/collector jolt
    // allocations) but previously had no destroy() at all, so nothing ever freed it.
    protected releaseResources(): void {
        this.raycaster.destroy();
        this.hits = [];
        this.positions = [];
        this.rays = [];
        this.results = [];
    }
    //* Getters and Setters ----------------------------
    get origin() {
        return this.raycaster.origin;
    }
    set origin(value) {
        this.raycaster.origin = value;
    }
    get direction() {
        return this.raycaster.direction;
    }
    set direction(value) {
        this.raycaster.direction = value;
    }

    // set the collector type
    setCollector(type: any) {
        this.raycaster.setCollector(type);
    }
    //@ts-ignore cast with just the positions
    cast(successHandler?: any, failHandler?: any) {
        this.hits = [];
        // results was appended to forever and never cleared, growing without bound across casts
        this.results = [];
        this.positions.forEach((position) => {
            //@ts-ignore
            this.raycaster.castFrom(position, (hit: RaycastHit | RaycastHit[]) => {
                if (Array.isArray(hit)) this.hits.push(...hit);
                else this.hits.push(hit);
                this.results.push({
                    origin: vec3.three(position).clone(),
                    direction: this.raycaster.direction.clone(),
                    hits: hit
                });
            });
        });
        if (this.hits.length > 0) {
            if (successHandler) successHandler(this.results, this.hits);
            return this.results;
        }
        if (failHandler) failHandler();
    }
    //@ts-ignore cast with the rays
    castRays(successHandler?: any, failHandler?: any) {
        this.hits = [];
        this.results = [];
        this.rays.forEach((ray) => {
            this.raycaster.castBetween(ray.origin, ray.destination, (hit: any) => {
                if (Array.isArray(hit)) this.hits.push(...hit);
                else this.hits.push(hit);
                this.results.push({
                    origin: vec3.three(ray.origin).clone(),
                    destination: ray.destination,
                    hits: hit
                });
            });
        });
        if (this.hits.length > 0) {
            if (successHandler) successHandler(this.results, this.hits);
            return this.results;
        }
        if (failHandler) failHandler();
    }
}
