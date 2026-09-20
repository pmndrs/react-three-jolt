// Shared machinery for the physics query classes (issue #154).
//
// Shapecaster used to duplicate ~90% of Raycaster, most visibly a byte-identical debug-drawing
// block (issue #192 fixed it once for raycasters.ts and #192's own follow-up had to hand-port the
// same fix into shapecasters.ts). QueryBase/CastQueryBase below is what every query type now
// extends instead of copy-pasting it a third time the next time a new one shows up:
// - QueryBase owns the physicsSystem/joltInterface/bodyInterface wiring every query needs, the
//   four filters that make a query "cast as if a dynamic object" (creation/ownership/destroy),
//   and an idempotent destroy() template - subclasses implement releaseResources() for whatever
//   else they allocated. Raycaster, Shapecaster, ShapeCollider and Multicaster all extend it
//   (Multicaster and ShapeCollider directly; Raycaster/Shapecaster through CastQueryBase below).
// - CastQueryBase adds what only the ray-like casters share on top of that: the collector
//   lifecycle, the cast()/castFrom()/castTo()/castBetween() family, and the debug-drawing resource
//   pool. Raycaster and Shapecaster extend it (and AdvancedRaycaster extends Raycaster).
// - HitBase is the shared shape of a single cast result (RaycastHit/ShapecastHit): a start/end/
//   position triple plus a body/sub-shape id pair, and the `impactNormal` reader that turns those
//   ids back into a live surface normal.

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Layer } from '../../constants';
import { Raw } from '../../raw';
import { type anyVec3, vec3 } from '../../utils';

// `drawMarker()` orients its marker's local +Y axis (this vector) onto the hit's surface normal
// via `Quaternion.setFromUnitVectors`. Shared/never mutated - `setFromUnitVectors` only reads it.
const MARKER_UP = new THREE.Vector3(0, 1, 0);

//* HitBase ============================================================================
// Shared by RaycastHit (raycasters.ts) and ShapecastHit (shapecasters.ts): both wrap a single
// jolt cast result the same way (a start/end/position triple plus a body/sub-shape id pair) and
// read the hit surface normal identically.
export abstract class HitBase {
    start: THREE.Vector3;
    end: THREE.Vector3;
    position: THREE.Vector3;
    shapeIdValue: number;
    bodyHandle: number;
    index: number;

    protected joltPhysicsSystem: Jolt.PhysicsSystem;

    constructor(
        joltPhysicsSystem: Jolt.PhysicsSystem,
        start: THREE.Vector3,
        end: THREE.Vector3,
        position: THREE.Vector3,
        shapeIdValue: number,
        bodyHandle: number,
        index: number
    ) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.start = start;
        this.end = end;
        this.position = position;
        this.shapeIdValue = shapeIdValue;
        this.bodyHandle = bodyHandle;
        this.index = index;
    }

    //* the more complex values we set as getters and arent stored on the object
    get distance(): number {
        return this.start.distanceTo(this.position);
    }
    // unreal calls it Normal
    get normal(): THREE.Vector3 {
        return this.end.clone().sub(this.start).normalize();
    }
    // others use direction
    get direction(): THREE.Vector3 {
        return this.normal;
    }
    get impactNormal(): THREE.Vector3 {
        const bodyID = new Raw.module.BodyID(this.bodyHandle);
        const shapeID = new Raw.module.SubShapeID();
        const position = vec3.rjolt(this.position);
        let toReturn = new THREE.Vector3();
        shapeID.SetValue(this.shapeIdValue);
        const body = this.joltPhysicsSystem.GetBodyLockInterfaceNoLock().TryGetBody(bodyID);
        if (body) {
            // GetWorldSpaceSurfaceNormal returns its Vec3 BY VALUE through jolt-physics' WebIDL
            // binder, which hands back a pointer to ONE STATIC TEMPORARY per bound function
            // (overwritten on the next call, shared across every hit) - never call
            // Raw.module.destroy() on it, that would free memory the binder still owns and reuses.
            const joltNormal = body.GetWorldSpaceSurfaceNormal(shapeID, position);
            toReturn = vec3.three(joltNormal);
        }
        // bodyID/shapeID/position ARE fresh allocations we made above with `new Raw.module.X()`,
        // so - unlike joltNormal - these three are genuinely ours and must be freed.
        Raw.module.destroy(shapeID);
        Raw.module.destroy(bodyID);
        Raw.module.destroy(position);
        return toReturn;
    }
}

//* QueryBase ==========================================================================
// Owns the wiring every query type needs and an idempotent destroy() template. Subclasses
// implement releaseResources() for whatever else they allocated.
export abstract class QueryBase {
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;
    bodyInterface: Jolt.BodyInterface;

    // filters - allocated by createFilters(), which the constructor of every subclass that runs
    // its own NarrowPhaseQuery cast (Raycaster, Shapecaster, ShapeCollider) calls. Multicaster
    // delegates to an owned Raycaster instead and never calls it, so these stay unset on it.
    bpFilter!: Jolt.DefaultBroadPhaseLayerFilter;
    objectFilter!: Jolt.DefaultObjectLayerFilter;
    bodyFilter!: Jolt.BodyFilter;
    shapeFilter!: Jolt.ShapeFilter;

    // True once destroy() has run. Raw.module.destroy() on an already-destroyed object does NOT
    // throw - it silently double-frees, and freed pointers get reused immediately - so every
    // destroy() below is guarded by this instead of being safe to call twice by accident.
    protected destroyed = false;

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.joltInterface = joltInterface;
        this.bodyInterface = joltPhysicsSystem.GetBodyInterface();
    }

    // these two filters mean the query will run as if its origin were a dynamic object
    protected createFilters(): void {
        this.bpFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
            this.joltInterface.GetObjectVsBroadPhaseLayerFilter(),
            Layer.MOVING
        );
        this.objectFilter = new Raw.module.DefaultObjectLayerFilter(
            this.joltInterface.GetObjectLayerPairFilter(),
            Layer.MOVING
        );
        // TODO figure out how to do custom body filters
        this.bodyFilter = new Raw.module.BodyFilter(); // BodyFilterJS?
        this.shapeFilter = new Raw.module.ShapeFilter();
    }

    protected destroyFilters(): void {
        Raw.module.destroy(this.bpFilter);
        Raw.module.destroy(this.objectFilter);
        Raw.module.destroy(this.bodyFilter);
        Raw.module.destroy(this.shapeFilter);
    }

    /** Free every Jolt object this query allocated. Idempotent - safe to call more than once. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.releaseResources();
    }

    /** Subclass hook for destroy(): free whatever this query type allocated. */
    protected abstract releaseResources(): void;
}

//* CastQueryBase ======================================================================
// Adds everything Raycaster and Shapecaster share on top of QueryBase: the collector lifecycle,
// the cast()/castFrom()/castTo()/castBetween() family, and the debug-drawing resource pool.
// `THit` is the concrete hit type (RaycastHit/ShapecastHit) and `TCollector` the union of native
// collector classes a subclass' setCollector() can produce.

/**
 * The read side of one of Jolt's `Array*` result vectors (`ArrayRayCastResult`,
 * `ArrayShapeCastResult`, `ArrayCollideShapeResult`, ...). Only `size()`/`at()` are needed to
 * drain a collector, so this is deliberately narrower than the native classes.
 */
export interface JoltHitArray<THit> {
    size(): number;
    at(index: number): THit;
}

/**
 * The hit-reading surface shared by Jolt's collision collectors (issue #144).
 *
 * Every `*ClosestHitCollisionCollector` / `*AnyHitCollisionCollector` declares `HadHit()` plus a
 * single `mHit`; every `*AllHitCollisionCollector` declares `HadHit()` plus an `mHits` vector;
 * and the `*CollectorJS` variants (see `AdvancedRaycaster`) declare **neither**, because the
 * JS implementation collects hits itself. Everything is therefore optional here, which is what
 * lets one interface cover all three families structurally instead of the four `@ts-ignore`s
 * `cast()` used to need - and it forces the `HadHit?.()` guard below, which is the honest
 * runtime check for a JS collector.
 */
export interface HitCollector<THit = unknown> {
    Reset(): void;
    HadHit?(): boolean;
    mHit?: THit;
    mHits?: JoltHitArray<THit>;
}

/**
 * `cast()`'s success callback: called with the single hit for a 'closest'/'any' query, or with
 * the whole array for an 'all' query.
 *
 * Declared method-style (the `bivarianceHack` idiom) on purpose. Under `strictFunctionTypes` a
 * plain `(hit: THit | THit[]) => void` property would check its parameter contravariantly, so
 * the narrower `(hit: RaycastHit) => void` that every demo in `apps/examples` passes would stop
 * compiling even though it is exactly right for a 'closest' cast. Method-style parameters are
 * checked bivariantly, which permits that - the same bargain `addEventListener` and the React
 * typings make.
 */
export type CastSuccessHandler<THit> = {
    bivarianceHack(hit: THit | THit[]): void;
}['bivarianceHack'];

/** `cast()`'s miss callback: called with no arguments when a cast collected nothing. */
export type CastFailHandler = () => void;

export abstract class CastQueryBase<
    THit extends HitBase,
    TCollector extends HitCollector
> extends QueryBase {
    //important
    type = 'closest';
    collector!: TCollector;
    hits: THit[] = [];
    hasCast = false;
    active = true;

    // For debugging. Still not sure this belongs on the class or as a subclass/hook
    isDebugging = false;
    lineColor = '#68D8D6';

    drawPoints = false;
    drawMarkers = false;
    startColor = '#3454D1';
    pointColor = '#E6AF2E';
    endColor = '#FE654F';

    // store multi debug items until cleared
    debugObject!: THREE.Object3D;

    // Debug drawing resource pools -------------------------------------
    // drawDebuggingLine/Points/Marker used to build a brand new THREE.BufferGeometry, Material
    // and Object3D on every single call, and cast() calls them on every cast while isDebugging is
    // on - so a query that draws its debug view every physics step leaked one full set of
    // three.js resources (and grew `debugObject.children`/the scene graph) per cast (issues #173,
    // #192). Everything below is created lazily on first use, then updated in place; destroy()/
    // clearDebugging() dispose it all.
    private _debugLine?: THREE.Line;
    private _debugLineGeometry?: THREE.BufferGeometry;
    private _debugLineMaterial?: THREE.LineBasicMaterial;

    private _debugPoints?: THREE.Points;
    private _debugPointsGeometry?: THREE.BufferGeometry;
    private _debugPointsMaterial?: THREE.PointsMaterial;

    // Markers are pooled one-per-hit-index (drawDebuggingMarkers assigns hits[i] -> pool[i]), so
    // an "all" collector reuses exactly as many marker groups as it has hits across casts instead
    // of accumulating a new set every time. The ring + normal-line geometry/material are shared
    // by every pooled entry - only each entry's own THREE.Group transform (position/quaternion)
    // differs - so once a pool slot exists, updating it allocates nothing.
    private _markerPool: THREE.Group[] = [];
    private _markerRingGeometry?: THREE.BufferGeometry;
    private _markerRingMaterial?: THREE.LineBasicMaterial;
    private _markerNormalGeometry?: THREE.BufferGeometry;
    private _markerNormalMaterial?: THREE.LineBasicMaterial;

    //* Collector lifecycle / cast family --------------------------------
    /** Build the native collector for `type` ('closest' | 'any' | 'all'). */
    protected abstract createCollector(type: string): TCollector;
    /** Wrap a single native hit result (and its index) into this query's THit type. */
    protected abstract buildHit(mHit: unknown, index: number): THit;
    /** Run the actual NarrowPhaseQuery call against `this.collector`. */
    abstract rawCast(): void;

    abstract get origin(): THREE.Vector3;
    abstract set origin(value: anyVec3);
    abstract get direction(): THREE.Vector3;
    abstract set direction(value: anyVec3);

    // set the collector
    setCollector(type = 'closest'): void {
        // destroy exising collector
        if (this.collector) Raw.module.destroy(this.collector);
        this.type = type;
        this.collector = this.createCollector(type);
    }
    // ease of life handler to match how threeJS does setting the raycaster
    set(origin: THREE.Vector3, direction: THREE.Vector3): void {
        this.origin = origin;
        this.direction = direction;
    }

    // do the cast, runs optional handlers and returns the hits
    cast(
        successHandler?: CastSuccessHandler<THit>,
        failHandler?: CastFailHandler
    ): THit | THit[] | undefined {
        // clear the collector. Every collector type must be reset before reuse, including
        // "closest": CastRayClosestHitCollisionCollector keeps HadHit()/mHit and its early-out
        // fraction from the previous cast, so skipping the reset here made a closest-hit
        // raycaster silently return stale/blocked results after its first hit (issue #60).
        if (this.hasCast) this.collector.Reset();
        this.hasCast = true;
        //clear the hits
        this.hits = [];
        //run the cast
        this.rawCast();
        // Handle results. `HadHit` is optional on HitCollector because the *CollectorJS variants
        // (see AdvancedRaycaster, which overrides cast() anyway) genuinely don't have it at
        // runtime either - so the optional call is the real guard, not a type-level dodge.
        const mHits = this.collector.mHits;
        if (this.collector.HadHit?.()) {
            if (this.type === 'all' && mHits) {
                // multi-hit case
                for (let i = 0; i < mHits.size(); i++) {
                    const hit = this.buildHit(mHits.at(i), i);
                    this.hits.push(hit);
                }
                if (successHandler) successHandler(this.hits);
            } else {
                // single hit case
                const hit = this.buildHit(this.collector.mHit, 0);
                if (successHandler) successHandler(hit);
                this.hits.push(hit);
            }
        }
        // debugging
        if (this.isDebugging) {
            this.drawDebuggingLine();
            if (this.drawPoints) this.drawDebuggingPoints();
            if (this.drawMarkers) this.drawDebuggingMarkers();
        }
        // return single if just one, or array if multi.
        // moved here to allow debugging
        if (this.hits.length > 0) {
            if (this.type !== 'all') return this.hits[0];
            return this.hits;
        }
        if (failHandler) failHandler();
        return undefined;
    }
    // ease of life handler to change the origin when casting
    castFrom(
        origin: anyVec3,
        successHandler?: CastSuccessHandler<THit>,
        failHandler?: CastFailHandler
    ): THit | THit[] | undefined {
        this.origin = origin;
        return this.cast(successHandler, failHandler);
    }
    // ease of life to cast from the origin to a point
    castTo(
        destination: anyVec3,
        successHandler?: CastSuccessHandler<THit>,
        failHandler?: CastFailHandler
    ): THit | THit[] | undefined {
        this.direction = vec3.three(destination).clone().sub(this.origin);
        return this.cast(successHandler, failHandler);
    }
    // ease of life to set an origin and point
    castBetween(
        origin: THREE.Vector3,
        destination: THREE.Vector3,
        successHandler?: CastSuccessHandler<THit>,
        failHandler?: CastFailHandler
    ): THit | THit[] | undefined {
        this.origin = origin;
        this.direction = vec3.three(destination).sub(this.origin);
        return this.cast(successHandler, failHandler);
    }

    //* Debugging -------------------------------------
    // Not sure I want this on all raycasts, maybe a subclass or hook?
    //set the scene and init the debugger values
    initDebugging(scene: THREE.Scene, color?: string): void {
        this.debugObject = new THREE.Object3D();
        scene.add(this.debugObject);
        if (color) this.lineColor = color;
        this.isDebugging = true;
    }
    stopDebugging(): void {
        if (!this.isDebugging) return;
        // get the parent of our debug object, then remove ourselves
        const parent = this.debugObject.parent;
        if (parent) parent.remove(this.debugObject);
        // TODO even though removed do we need to destroy the children of the object?
        this.isDebugging = false;
    }
    // clear the debug object
    clearDebugging(): void {
        const parent = this.debugObject.parent;
        if (!parent) return;
        parent.remove(this.debugObject);
        // the pooled line/points/marker objects below are children of the OLD debugObject we
        // just detached, so their geometry/material must be disposed and forgotten here too -
        // otherwise the next draw call would see a stale (now-orphaned, non-null) `_debugLine`
        // etc. and skip re-adding it to the fresh debugObject, silently drawing nothing.
        this._disposeDebugResources();
        this.debugObject = new THREE.Object3D();
        parent.add(this.debugObject);
    }
    // draw the debugging line - reuses a single pooled Line/geometry/material across casts
    // instead of allocating a new THREE.Line every call (issue #173): the geometry is rewritten
    // in place with setFromPoints and the material's color is just updated on the existing
    // material.
    drawDebuggingLine(
        origin = this.origin,
        end = this.origin.clone().add(this.direction),
        color = this.lineColor
    ): THREE.Line {
        if (!this._debugLineGeometry) this._debugLineGeometry = new THREE.BufferGeometry();
        this._debugLineGeometry.setFromPoints([origin, end]);

        if (!this._debugLineMaterial)
            this._debugLineMaterial = new THREE.LineBasicMaterial({ color });
        else this._debugLineMaterial.color.set(color);

        if (!this._debugLine) {
            this._debugLine = new THREE.Line(this._debugLineGeometry, this._debugLineMaterial);
            this.debugObject.add(this._debugLine);
        }
        return this._debugLine;
    }
    // draw the debugging points - reuses a single pooled Points/geometry/material across casts.
    // The position/color attributes are still rebuilt each call because the hit count (and so
    // the point count) can change between casts, but the Points object, its geometry and its
    // material are never recreated once they exist.
    drawDebuggingPoints(): THREE.Points {
        // build the points array
        const numPoints = 2 + this.hits.length;
        const points: { position: THREE.Vector3; color: string }[] = [];
        //start point
        points.push({ position: this.origin, color: this.startColor });
        //hits
        this.hits.forEach((hit) => {
            points.push({ position: hit.position, color: this.pointColor });
        });
        //end point
        points.push({
            position: this.origin.clone().add(this.direction),
            color: this.endColor
        });
        // set the positions and colors
        const positions = new Float32Array(numPoints * 3);
        const colors = new Float32Array(numPoints * 3);
        points.forEach((point, i) => {
            positions[i * 3] = point.position.x;
            positions[i * 3 + 1] = point.position.y;
            positions[i * 3 + 2] = point.position.z;
            const color = new THREE.Color(point.color);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        });

        if (!this._debugPointsGeometry) this._debugPointsGeometry = new THREE.BufferGeometry();
        this._debugPointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this._debugPointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        this._debugPointsGeometry.computeBoundingBox();

        if (!this._debugPointsMaterial) {
            this._debugPointsMaterial = new THREE.PointsMaterial({
                color: this.pointColor,
                vertexColors: true,
                size: 0.3
            });
        }
        if (!this._debugPoints) {
            this._debugPoints = new THREE.Points(
                this._debugPointsGeometry,
                this._debugPointsMaterial
            );
            this.debugObject.add(this._debugPoints);
        }
        return this._debugPoints;
    }
    // draw one marker per current hit, pooled by index so repeated casts (with the same or a
    // smaller number of hits) reuse the same marker groups instead of accumulating new ones.
    drawDebuggingMarkers(): void {
        this.hits.forEach((hit, i) => this.drawMarker(hit, undefined, undefined, i));
        // hide (never destroy - they stay pooled for reuse) any markers left over from a
        // previous cast that returned more hits than this one, so an "all" collector going from
        // e.g. 3 hits to 1 doesn't leave 2 stale markers visible.
        for (let i = this.hits.length; i < this._markerPool.length; i++) {
            this._markerPool[i].visible = false;
        }
    }
    // Build (once) or fetch the pooled marker group at `poolIndex`. The ring and normal-line
    // geometry/material are shared across every pooled entry - only each entry's own THREE.Group
    // transform differs - so growing the pool allocates one Group plus its two static-geometry
    // children, and nothing else.
    private _getMarkerEntry(poolIndex: number, color: string): THREE.Group {
        if (!this._markerRingGeometry) {
            // a unit circle in the local XZ plane: after the group is oriented so local +Y maps
            // onto the hit normal (see drawMarker), this ring lies in the surface's tangent plane
            const segments = 24;
            const ringPoints: THREE.Vector3[] = [];
            for (let i = 0; i < segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                ringPoints.push(new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)));
            }
            this._markerRingGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
        }
        if (!this._markerRingMaterial)
            this._markerRingMaterial = new THREE.LineBasicMaterial({ color });
        else this._markerRingMaterial.color.set(color);

        if (!this._markerNormalGeometry) {
            // a unit segment along local +Y - after orientation this points along the hit normal
            this._markerNormalGeometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 1, 0)
            ]);
        }
        if (!this._markerNormalMaterial) {
            this._markerNormalMaterial = new THREE.LineBasicMaterial({ color: '#3CD048' });
        }

        let group = this._markerPool[poolIndex];
        if (!group) {
            group = new THREE.Group();
            group.add(new THREE.LineLoop(this._markerRingGeometry, this._markerRingMaterial));
            group.add(new THREE.Line(this._markerNormalGeometry, this._markerNormalMaterial));
            this._markerPool[poolIndex] = group;
            this.debugObject.add(group);
        }
        return group;
    }
    // Draw a single hit marker oriented along the hit's surface normal (issue #48). `poolIndex`
    // selects which pooled marker to update (drawDebuggingMarkers assigns one per hit, in hit
    // order). Calling this repeatedly for the same index only ever updates that marker's
    // transform - once its pool entry exists this allocates no new geometry, material or
    // Object3D.
    drawMarker(hit: THit, size = 0.5, color = '#C6D8D3', poolIndex = 0): THREE.Group {
        const group = this._getMarkerEntry(poolIndex, color);
        const normal = hit.impactNormal;
        // a degenerate (zero-length) normal has no valid rotation - fall back to "up" rather than
        // feeding setFromUnitVectors a non-unit vector
        const targetNormal = normal.lengthSq() > 1e-8 ? normal.normalize() : MARKER_UP;
        group.position.copy(hit.position);
        group.quaternion.setFromUnitVectors(MARKER_UP, targetNormal);
        group.scale.setScalar(size);
        group.visible = true;
        return group;
    }

    // Dispose every pooled debug-drawing geometry/material and forget the pooled objects so a
    // later draw call rebuilds them from scratch (used by both destroy() and clearDebugging()).
    protected _disposeDebugResources(): void {
        this._debugLineGeometry?.dispose();
        this._debugLineMaterial?.dispose();
        this._debugLine = undefined;
        this._debugLineGeometry = undefined;
        this._debugLineMaterial = undefined;

        this._debugPointsGeometry?.dispose();
        this._debugPointsMaterial?.dispose();
        this._debugPoints = undefined;
        this._debugPointsGeometry = undefined;
        this._debugPointsMaterial = undefined;

        this._markerRingGeometry?.dispose();
        this._markerRingMaterial?.dispose();
        this._markerNormalGeometry?.dispose();
        this._markerNormalMaterial?.dispose();
        this._markerRingGeometry = undefined;
        this._markerRingMaterial = undefined;
        this._markerNormalGeometry = undefined;
        this._markerNormalMaterial = undefined;
        this._markerPool = [];
    }
}
