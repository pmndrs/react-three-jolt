// this system lets us create raycasts, shapecasts, and specific collision tests
import { Layer, PhysicsSystem } from './physics-system';
import * as THREE from 'three';

import Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { vec3, quat } from '../utils';

export class QuerySystem {
    physicsSystem: PhysicsSystem;
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;

    constructor(physicsSystem) {
        this.physicsSystem = physicsSystem;
        this.joltPhysicsSystem = physicsSystem.physicsSystem;
        this.joltInterface = physicsSystem.joltInterface;
    }
}

type CastRayCollector =
    | Jolt.CastRayAllHitCollisionCollector
    | Jolt.CastRayClosestHitCollisionCollector
    | Jolt.CastRayAnyHitCollisionCollector
    | Jolt.CastRayCollectorJS;

export class Raycaster {
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;
    // filters
    bpFilter: Jolt.DefaultBroadPhaseLayerFilter;
    objectFilter: Jolt.DefaultObjectLayerFilter;
    // TODO figure out how to do custom body filters
    bodyFilter: Jolt.BodyFilter = new Raw.module.BodyFilter(); // BodyFilterJS?
    shapeFilter: Jolt.ShapeFilter = new Raw.module.ShapeFilter();

    // ray settings
    ray = new Raw.module.RRayCast();
    raySettings = new Raw.module.RayCastSettings();
    doCullBackFaces = true;

    //important
    type = 'closest';
    collector: CastRayCollector;
    hits: RaycastHit[] = [];

    // For debugging. Still not sure this belongs on the class or as a subclass/hook
    isDebugging = false;
    lineColor = '#68D8D6';

    drawPoints = false;
    drawMarkers = false;
    startColor = '#3454D1';
    pointColor = '#E6AF2E';
    endColor = '#FE654F';

    // store multi debug items until cleared
    debugObject: THREE.Object3D;

    constructor(joltPhysicsSystem, joltInterface) {
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

        // initialize the ray origin and destination
        this.ray.mOrigin = new Raw.module.Vec3(0, 0, 0);
        this.ray.mDirection = new Raw.module.Vec3(10, 10, 10);

        // initialize the collector
        this.setCollector();
    }

    //* Getters and Setters ----------------------------
    get origin() {
        return vec3.three(this.ray.mOrigin);
    }
    set origin(value) {
        const newVec = vec3.jolt(value);
        this.ray.mOrigin = newVec;
        Raw.module.destroy(newVec);
    }
    get direction() {
        return vec3.three(this.ray.mDirection);
    }
    set direction(value) {
        const newVec = vec3.jolt(value);
        this.ray.mDirection = newVec;
        Raw.module.destroy(newVec);
    }
    get cullBackFaces() {
        return this.doCullBackFaces;
    }
    set cullBackFaces(value) {
        if (value)
            this.raySettings.mBackFaceMode =
                Raw.module.EBackFaceMode_IgnoreBackFaces;
        else
            this.raySettings.mBackFaceMode =
                Raw.module.EBackFaceMode_CollideWithBackFaces;
    }

    //* Methods ---------------------------------------
    //this has no callback, it just triggers the ray and you have to process it
    rawCast() {
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
    // set the collector
    setCollector(type = 'closest') {
        console.log('setting collector', type);
        // destroy exising collector
        if (this.collector) Raw.module.destroy(this.collector);
        this.type = type;
        switch (type) {
            case 'any':
                this.collector =
                    new Raw.module.CastRayAnyHitCollisionCollector();
                break;
            case 'all':
                this.collector =
                    new Raw.module.CastRayAllHitCollisionCollector();
                break;
            default:
                this.collector =
                    new Raw.module.CastRayClosestHitCollisionCollector();
                break;
        }
    }
    // ease of life handler to match how threeJS does setting the raycaster
    set(origin, direction) {
        this.origin = origin;
        this.direction = direction;
    }
    // do the cast, runs optional handlers and returns the hits
    cast(successHandler?, failHandler?) {
        // clear the collector
        this.collector.Reset();
        //clear the hits
        this.hits = [];
        //run the cast
        this.rawCast();
        //handle results
        if (this.collector.HadHit()) {
            if (this.type === 'all') {
                // multi-hit case
                for (let i = 0; i < this.collector.mHits.size(); i++) {
                    const hit = new RaycastHit(
                        this.joltPhysicsSystem,
                        this.ray,
                        this.collector.mHits.at(i),
                        i
                    );
                    this.hits.push(hit);
                }
                if (successHandler) successHandler(this.hits);
                //return this.hits;
            } else {
                // single hit case
                const hit = new RaycastHit(
                    this.joltPhysicsSystem,
                    this.ray,
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
            if (this.hits.length == 1) return this.hits[0];
            return this.hits;
        }
        if (failHandler) failHandler();
    }
    // ease of life handler to change the origin when casting
    castFrom(origin, successHandler?, failHandler?) {
        this.origin = origin;
        return this.cast(successHandler, failHandler);
    }
    // ease of life to cast from the origin to a point
    castTo(destination, successHandler?, failHandler?) {
        this.direction = destination.clone().sub(this.origin);
        return this.cast(successHandler, failHandler);
    }
    // ease of life to set an origin and point
    castBetween(origin, destination, successHandler?, failHandler?) {
        this.origin = origin;
        this.direction = vec3.three(destination).sub(this.origin);
        return this.cast(successHandler, failHandler);
    }

    //* Debugging -------------------------------------
    // Not sure I want this on all raycasts, maybe a subclass or hook?
    //set the scene and init the debugger values
    initDebugging(scene, color?) {
        this.debugObject = new THREE.Object3D();
        scene.add(this.debugObject);
        if (color) this.lineColor = color;
        this.isDebugging = true;
    }
    stopDebugging() {
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
        this.debugObject = new THREE.Object3D();
        parent.add(this.debugObject);
    }
    // draw the debugging line
    drawDebuggingLine(
        origin = this.origin,
        end = this.origin.clone().add(this.direction),
        color = this.lineColor
    ) {
        const points = [origin, end];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: color });
        const newLine = new THREE.Line(geometry, material);
        this.debugObject.add(newLine);
    }
    // draw the debugging points
    drawDebuggingPoints() {
        // points
        const geometry = new THREE.BufferGeometry();

        // build new points geometry
        const numPoints = 2 + this.hits.length;
        const points: { position: THREE.Vector3; color: string }[] = [];
        const positions = new Float32Array(numPoints * 3);
        const colors = new Float32Array(numPoints * 3);
        // build points array
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
        points.forEach((point, i) => {
            positions[i * 3] = point.position.x;
            positions[i * 3 + 1] = point.position.y;
            positions[i * 3 + 2] = point.position.z;
            const color = new THREE.Color(point.color);
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        });
        // set the geometry attributes
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3)
        );
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.computeBoundingBox();
        // copy the points object
        const material = new THREE.PointsMaterial({
            color: this.pointColor,
            vertexColors: true,
            size: 0.3
        });
        const newPoints = new THREE.Points(geometry, material);

        // add the new points to the debugObject
        this.debugObject.add(newPoints);
    }
    drawDebuggingMarkers() {
        this.hits.forEach((hit) => this.drawMarker(hit));
    }
    drawMarker(hit: RaycastHit, size = 0.5, color = '#C6D8D3') {
        const center = hit.position;
        const normal = hit.impactNormal;
        // draw the normal and inverse normal
        this.drawDebuggingLine(center, center.clone().add(normal), '#3CD048');
        const markerSize = size;
        const points: THREE.Vector3[] = [];
        // TODO: Apply the normal to these to correctly rotate the axis
        points.push(
            new THREE.Vector3(center.x - markerSize, center.y, center.z),
            new THREE.Vector3(center.x + markerSize, center.y, center.z),
            // vertical
            new THREE.Vector3(center.x, center.y - markerSize, center.z),
            new THREE.Vector3(center.x, center.y + markerSize, center.z),

            new THREE.Vector3(center.x, center.y, center.z - markerSize),
            new THREE.Vector3(center.x, center.y, center.z + markerSize)
        );
        const markerGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const markerMaterial = new THREE.LineBasicMaterial({ color: color });
        const marker = new THREE.LineSegments(markerGeometry, markerMaterial);
        this.debugObject.add(marker);
    }
}

// More advanced raycast with collector level customizing. Way more advanced,
// probably never to be used but its here if you need it
//TODO: This might have some bind/apply scope issues
export class AdvancedRaycaster extends Raycaster {
    collector: Jolt.CastRayCollectorJS = new Raw.module.CastRayCollectorJS();
    activeBody: Jolt.Body;
    collisionCount: number = 0;
    hits: RaycastHit[] = [];
    constructor(joltPhysicsSystem, joltInterface) {
        super(joltPhysicsSystem, joltInterface);

        //preload the reset with our own
    }
    // pass through for the onBody
    onBody(handler) {
        this.collector.OnBody = (body) => {
            body = Raw.module.wrapPointer(body, Raw.module.Body);
            this.activeBody = body;
            handler(body, this.collector);
        };
    }
    // runs on every hit
    addHit(handler) {
        this.collector.AddHit = (result: Jolt.RayCastResult) => {
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
    onReset(handler?) {
        this.collector.Reset = () => {
            this.collisionCount = 0;
            this.hits = [];
            handler(this.collector);
            this.collector.ResetEarlyOutFraction();
        };
    }
    reset() {
        this.collector.Reset();
    }

    // slight override on the parent class as we have to call override on our
    // raw handler.
    cast(successHandler?, failHandler?) {
        this.rawCast();
        this.reset();
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

export class RaycastHit {
    start: THREE.Vector3;
    end: THREE.Vector3;
    position: THREE.Vector3;
    shapeIdValue: number;
    bodyHandle: number;
    index: number;

    //not sure how to get these
    triangleIndex: number;
    private joltPhysicsSystem: Jolt.PhysicsSystem;
    constructor(
        joltPhysicsSystem,
        ray: Jolt.RRayCast,
        mHit: Jolt.RayCastResult,
        index = 0,
        bodyID?: Jolt.BodyID
    ) {
        // can we get the body with the handle

        this.joltPhysicsSystem = joltPhysicsSystem;
        this.start = vec3.three(ray.mOrigin);
        this.end = this.start.clone().add(vec3.three(ray.mDirection));
        this.shapeIdValue = mHit.mSubShapeID2.GetValue();
        this.index = index;
        this.bodyHandle = bodyID
            ? bodyID.GetIndexAndSequenceNumber()
            : mHit.mBodyID.GetIndexAndSequenceNumber();
        const joltPosition = ray.GetPointOnRay(mHit.mFraction);
        this.position = vec3.three(joltPosition);
        // destroy things
        Raw.module.destroy(joltPosition);
        Raw.module.destroy(mHit);
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
        shapeID.SetValue(this.shapeIdValue);
        const body = this.joltPhysicsSystem
            .GetBodyLockInterfaceNoLock()
            .TryGetBody(bodyID);
        const joltNormal = body.GetWorldSpaceSurfaceNormal(
            shapeID,
            vec3.jolt(this.position)
        );
        const toReturn = vec3.three(joltNormal);
        // destroy jolt items
        Raw.module.destroy(joltNormal);
        Raw.module.destroy(shapeID);
        Raw.module.destroy(bodyID);
        return toReturn;
    }

    get material(): Jolt.PhysicsMaterial {
        const shape = this.joltPhysicsSystem
            .GetBodyInterface()
            .GetShape(this.bodyID);
        return shape.GetMaterial(this.shapeId);
    }
}

// Multicast takes an array of positions and casts rays to all of them
export class Multicaster {
    joltPhysicsSystem: Jolt.PhysicsSystem;
    joltInterface: Jolt.JoltInterface;

    raycaster: Raycaster;
    hits: RaycastHit[] = [];
    positions: THREE.Vector3[] = [];
    rays: { origin: THREE.Vector3; destination: THREE.Vector3 }[] = [];
    results: {
        origin: THREE.Vector3;
        destination?;
        direction?;
        hits: RaycastHit | RaycastHit[];
    }[] = [];
    constructor(joltPhysicsSystem, joltInterface) {
        this.joltPhysicsSystem = joltPhysicsSystem;
        this.joltInterface = joltInterface;
        this.raycaster = new Raycaster(joltPhysicsSystem, joltInterface);
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
    setCollector(type) {
        this.raycaster.setCollector(type);
    }
    // cast with just the positions
    cast(successHandler?, failHandler?) {
        this.hits = [];
        this.positions.forEach((position) => {
            this.raycaster.castFrom(
                position,
                (hit: RaycastHit | RaycastHit[]) => {
                    if (Array.isArray(hit)) this.hits.push(...hit);
                    else this.hits.push(hit);
                    this.results.push({
                        origin: vec3.three(position).clone(),
                        direction: this.raycaster.direction.clone(),
                        hits: hit
                    });
                }
            );
        });
        if (this.hits.length > 0) {
            if (successHandler) successHandler(this.results, this.hits);
            return this.results;
        }
        if (failHandler) failHandler();
    }
    // cast with the rays
    castRays(successHandler?, failHandler?) {
        this.hits = [];
        this.rays.forEach((ray, i) => {
            this.raycaster.castBetween(ray.origin, ray.destination, (hit) => {
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
