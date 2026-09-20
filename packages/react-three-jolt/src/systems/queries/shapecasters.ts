// this system lets us create raycasts, shapecasts, and specific collision tests

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Layer } from '../../constants';
import { Raw } from '../../raw';
import { type anyVec3, generateJoltMatrix, vec3 } from '../../utils';

type Callback = (hit?: ShapecastHit | ShapecastHit[]) => void;

// `drawMarker()` orients its marker's local +Y axis (this vector) onto the hit's surface normal
// via `Quaternion.setFromUnitVectors`. Shared/never mutated - `setFromUnitVectors` only reads it.
// Mirrors the constant of the same name in raycasters.ts.
const MARKER_UP = new THREE.Vector3(0, 1, 0);

type CastShapeCollector =
    | Jolt.CastShapeAllHitCollisionCollector
    | Jolt.CastShapeClosestHitCollisionCollector
    | Jolt.CastShapeAllHitCollisionCollector;

export class Shapecaster {
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;
    // filters
    bpFilter: Jolt.DefaultBroadPhaseLayerFilter;
    objectFilter: Jolt.DefaultObjectLayerFilter;
    // TODO figure out how to do custom body filters
    bodyFilter: Jolt.BodyFilter = new Raw.module.BodyFilter(); // BodyFilterJS?
    shapeFilter: Jolt.ShapeFilter = new Raw.module.ShapeFilter();

    // shapecast settings
    shapecast!: Jolt.RShapeCast;
    shapecastSettings = new Raw.module.ShapeCastSettings();
    doIgnoreBackfaceTriangles = true;
    doIgnoreBackfaceConvex = true;

    activePosition = new THREE.Vector3();
    activeRotation = new THREE.Quaternion();
    activeDirection = new THREE.Vector3();
    activeScale = new THREE.Vector3(1, 1, 1);
    activeShape: Jolt.Shape = new Raw.module.SphereShape(0.5);

    //important
    type = 'closest';
    // @ts-ignore
    collector: CastShapeCollector;
    hits: ShapecastHit[] = [];
    hasCast = false;
    active = true;
    // probably never need this
    baseOffset = new Raw.module.RVec3(0, 0, 0);

    // For debugging. Still not sure this belongs on the class or as a subclass/hook
    isDebugging = false;
    lineColor = '#68D8D6';

    drawPoints = false;
    drawMarkers = false;
    startColor = '#3454D1';
    pointColor = '#E6AF2E';
    endColor = '#FE654F';

    // store multi debug items until cleared
    // @ts-ignore
    debugObject: THREE.Object3D;

    // Debug drawing resource pools -------------------------------------
    // drawDebuggingLine/Points/Marker used to build a brand new THREE.BufferGeometry, Material
    // and Object3D on every single call, and cast() calls them on every cast while isDebugging is
    // on - so a shapecaster that draws its debug view every physics step leaked one full set of
    // three.js resources (and grew `debugObject.children`/the scene graph) per cast, the same bug
    // #173 fixed for raycasters.ts (issue #192). Everything below is created lazily on first use,
    // then updated in place; destroy()/clearDebugging() dispose it all.
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

    constructor(joltPhysicsSystem: Jolt.PhysicsSystem, joltInterface: Jolt.JoltInterface) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.joltInterface = joltInterface;
        // `activeShape` is a Jolt reference counted object (RefTarget) and starts life with a
        // refcount of 0 (see the jolt-physics README's "Reference counting objects" section).
        // AddRef() here means the `shape` setter/destroy() below can always treat `activeShape`
        // uniformly with Release(), regardless of whether it's this default shape or one a caller
        // handed us. Mirrors `ShapeCollider` (#174/issue #142).
        this.activeShape.AddRef();
        // these two filters mean the ray will cast as if its a dynamic object
        this.bpFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
            joltInterface.GetObjectVsBroadPhaseLayerFilter(),
            Layer.MOVING
        );
        this.objectFilter = new Raw.module.DefaultObjectLayerFilter(
            joltInterface.GetObjectLayerPairFilter(),
            Layer.MOVING
        );
        // initialize the shapecast
        this.initializeShapecast();

        // initialize the collector
        this.setCollector();
    }
    // Cleanup ---------------------------------------
    destroy() {
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
        Raw.module.destroy(this.bpFilter);
        Raw.module.destroy(this.objectFilter);
        Raw.module.destroy(this.bodyFilter);
        Raw.module.destroy(this.shapeFilter);
        Raw.module.destroy(this.collector);
        Raw.module.destroy(this.baseOffset);
    }

    // Dispose every pooled debug-drawing geometry/material and forget the pooled objects so a
    // later draw call rebuilds them from scratch (used by both destroy() and clearDebugging()).
    private _disposeDebugResources() {
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
    rawCast() {
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
    // set the collector
    setCollector(type = 'closest') {
        //console.log('setting collector', type);
        // destroy exising collector
        if (this.collector) Raw.module.destroy(this.collector);
        this.type = type;
        switch (type) {
            case 'any':
                this.collector = new Raw.module.CastShapeAnyHitCollisionCollector();
                break;
            case 'all':
                this.collector = new Raw.module.CastShapeAllHitCollisionCollector();
                break;
            default:
                this.collector = new Raw.module.CastShapeClosestHitCollisionCollector();
                break;
        }
    }
    // ease of life handler to match how threeJS does setting the raycaster
    set(origin: THREE.Vector3, direction: THREE.Vector3) {
        this.origin = origin;
        this.direction = direction;
    }
    // do the cast, runs optional handlers and returns the hits
    // @ts-ignore early bail return triggers TS
    cast(successHandler?: any, failHandler?: any) {
        // clear the collector
        if (this.hasCast) this.collector.Reset();
        this.hasCast = true;
        //clear the hits
        this.hits = [];
        //run the cast
        this.rawCast();
        //handle results
        // @ts-ignore jolt collector TS issue
        if (this.collector.HadHit()) {
            if (this.type === 'all') {
                // multi-hit case
                // @ts-ignore Jolt TS issue
                for (let i = 0; i < this.collector.mHits.size(); i++) {
                    const hit = new ShapecastHit(
                        this.joltPhysicsSystem,
                        this.shapecast,
                        // @ts-ignore jolt TS issue for collector
                        this.collector.mHits.at(i),
                        i
                    );
                    this.hits.push(hit);
                }
                if (successHandler) successHandler(this.hits);
                //return this.hits;
            } else {
                // single hit case
                const hit = new ShapecastHit(
                    this.joltPhysicsSystem,
                    this.shapecast,
                    // @ts-ignore Jolt TS issue
                    this.collector.mHit,
                    0
                );
                if (successHandler) successHandler(hit);
                this.hits.push(hit);
                //return hit;
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
    }
    // ease of life handler to change the origin when casting
    castFrom(origin: anyVec3, successHandler?: Callback, failHandler?: Callback) {
        this.origin = origin;
        return this.cast(successHandler, failHandler);
    }
    // ease of life to cast from the origin to a point
    castTo(destination: anyVec3, successHandler?: Callback, failHandler?: Callback) {
        this.direction = vec3.three(destination).clone().sub(this.origin);
        return this.cast(successHandler, failHandler);
    }
    // ease of life to set an origin and point
    castBetween(
        origin: THREE.Vector3,
        destination: THREE.Vector3,
        successHandler?: Callback,
        failHandler?: Callback
    ) {
        this.origin = origin;
        this.direction = vec3.three(destination).sub(this.origin);
        return this.cast(successHandler, failHandler);
    }

    //* Debugging -------------------------------------
    // Not sure I want this on all raycasts, maybe a subclass or hook?
    //set the scene and init the debugger values
    initDebugging(scene: THREE.Scene, color?: any) {
        this.debugObject = new THREE.Object3D();
        scene.add(this.debugObject);
        if (color) this.lineColor = color;
        this.isDebugging = true;
    }
    stopDebugging() {
        if (!this.isDebugging) return;
        // get the parent of our debug object, then remove ourselves
        const parent = this.debugObject.parent;
        if (parent) parent.remove(this.debugObject);
        // TODO even though removed do we need to destroy the children of the object?
        this.isDebugging = false;
    }
    // clear the debug object
    clearDebugging() {
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
    // instead of allocating a new THREE.Line every call (issue #192, mirrors #173's raycaster
    // fix): the geometry is rewritten in place with setFromPoints and the material's color is
    // just updated on the existing material.
    drawDebuggingLine(
        origin = this.origin,
        end = this.origin.clone().add(this.direction),
        color = this.lineColor
    ) {
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
    drawDebuggingPoints() {
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
    drawDebuggingMarkers() {
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
    // Draw a single hit marker oriented along the hit's surface normal (issue #192, mirrors #48's
    // raycaster fix - markers used to always be axis-aligned to world space no matter what they
    // hit). `poolIndex` selects which pooled marker to update (drawDebuggingMarkers assigns one
    // per hit, in hit order). Calling this repeatedly for the same index only ever updates that
    // marker's transform - once its pool entry exists this allocates no new geometry, material or
    // Object3D.
    drawMarker(hit: ShapecastHit, size = 0.5, color = '#C6D8D3', poolIndex = 0): THREE.Group {
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
}

export class ShapecastHit {
    start: THREE.Vector3;
    end: THREE.Vector3;
    position: THREE.Vector3;
    shapeIdValue: number;
    bodyHandle: number;
    index: number;

    //not sure how to get these
    // triangleIndex: number;
    private joltPhysicsSystem: Jolt.PhysicsSystem;
    constructor(
        joltPhysicsSystem: Jolt.PhysicsSystem,
        shapecast: Jolt.RShapeCast,
        mHit: Jolt.ShapeCastResult,
        index = 0,
        bodyID?: Jolt.BodyID
    ) {
        // can we get the body with the handle

        this.joltPhysicsSystem = joltPhysicsSystem;
        this.start = vec3.three(shapecast.mCenterOfMassStart.GetTranslation());
        this.end = this.start.clone().add(vec3.three(shapecast.mDirection));
        this.shapeIdValue = mHit.mSubShapeID2.GetValue();
        this.index = index;
        this.bodyHandle = bodyID
            ? bodyID.GetIndexAndSequenceNumber()
            : mHit.mBodyID2.GetIndexAndSequenceNumber();
        // GetPointOnRay returns its Vec3/RVec3 BY VALUE through jolt-physics' WebIDL binder,
        // which hands back a pointer to ONE STATIC TEMPORARY per bound function (overwritten on
        // the next call, shared across every shapecast). Destroying it - as this did - frees
        // memory the binder still owns and immediately reuses, corrupting the next reader.
        // `vec3.three()` copies the components straight out, so there is nothing to free here.
        // Same fix as RaycastHit in raycasters.ts; this sibling was missed.
        //@ts-ignore this function was added to jolt.js #155
        const joltPosition = shapecast.GetPointOnRay(mHit.mFraction);
        this.position = vec3.three(joltPosition);
    }
    //* the more complex  values we set as getters and arent stored on the object
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
        // `vec3.rjolt` always allocates a vector we own (issue #76), so it has to be released
        // here - this getter is read per hit, per frame, by the camera rig.
        const position = vec3.rjolt(this.position);
        let toReturn = new THREE.Vector3();
        shapeID.SetValue(this.shapeIdValue);
        const body = this.joltPhysicsSystem.GetBodyLockInterfaceNoLock().TryGetBody(bodyID);
        if (body) {
            // `GetWorldSpaceSurfaceNormal` returns "by value", which in the WebIDL binder
            // means a pointer to a static temporary the binder owns - read it out immediately
            // and never destroy it.
            const joltNormal = body.GetWorldSpaceSurfaceNormal(shapeID, position);
            toReturn = vec3.three(joltNormal);
        }
        // bodyID/shapeID/position ARE fresh allocations we made above with `new Raw.module.X()`,
        // so - unlike joltNormal - these three are genuinely ours and must be freed: this getter
        // leaked all three of them on every single call. Mirrors the RaycastHit fix in
        // raycasters.ts.
        Raw.module.destroy(shapeID);
        Raw.module.destroy(bodyID);
        Raw.module.destroy(position);
        return toReturn;
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
