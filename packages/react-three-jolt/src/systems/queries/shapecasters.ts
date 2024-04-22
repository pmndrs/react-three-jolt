// this system lets us create raycasts, shapecasts, and specific collision tests
import { Layer } from "../../constants";
import * as THREE from "three";

import type Jolt from "jolt-physics";
import { Raw } from "../../raw";
import { type anyVec3, vec3, generateJoltMatrix } from "../../utils";

type Callback = (hit?: ShapecastHit | ShapecastHit[]) => void;

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
	shapecast!: Jolt.ShapeCast;
	shapecastSettings = new Raw.module.ShapeCastSettings();
	doIgnoreBackfaceTriangles = true;
	doIgnoreBackfaceConvex = true;

	activePosition = new THREE.Vector3();
	activeRotation = new THREE.Quaternion();
	activeDirection = new THREE.Vector3();
	activeScale = new THREE.Vector3(1, 1, 1);
	activeShape = new Raw.module.SphereShape(0.5);

	//important
	type = "closest";
	// @ts-ignore
	collector: CastShapeCollector;
	hits: ShapecastHit[] = [];
	hasCast = false;
	active = true;
	// probably never need this
	baseOffset = new Raw.module.Vec3(0, 0, 0);

	// For debugging. Still not sure this belongs on the class or as a subclass/hook
	isDebugging = false;
	lineColor = "#68D8D6";

	drawPoints = false;
	drawMarkers = false;
	startColor = "#3454D1";
	pointColor = "#E6AF2E";
	endColor = "#FE654F";

	// store multi debug items until cleared
	// @ts-ignore
	debugObject: THREE.Object3D;

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
		// initialize the shapecast
		this.initializeShapecast();

		// initialize the collector
		this.setCollector();
	}
	// Cleanup ---------------------------------------
	destroy() {
		this.active = false;
		this.stopDebugging();
		Raw.module.destroy(this.shapecast);
		Raw.module.destroy(this.shapecastSettings);
		Raw.module.destroy(this.bpFilter);
		Raw.module.destroy(this.objectFilter);
		Raw.module.destroy(this.bodyFilter);
		Raw.module.destroy(this.shapeFilter);
		Raw.module.destroy(this.collector);
		Raw.module.destroy(this.baseOffset);
	}

	// this shouldnt be needed but changing the origin doesn't seem to work correctly

	initializeShapecast() {
		const mat4 = generateJoltMatrix(this.activePosition, this.activeRotation, this.activeScale);
		const scale = vec3.jolt(this.activeScale);
		const direction = vec3.jolt(this.activeDirection);
		const shape = this.activeShape;
		this.shapecast = new Raw.module.ShapeCast(shape, scale, mat4, direction);
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
		return this.shapecast.mShape;
	}
	set shape(value) {
		// remove the old one
		this.shapecast.set_mShape(value);
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
	setCollector(type = "closest") {
		//console.log('setting collector', type);
		// destroy exising collector
		if (this.collector) Raw.module.destroy(this.collector);
		this.type = type;
		switch (type) {
			case "any":
				this.collector = new Raw.module.CastShapeAnyHitCollisionCollector();
				break;
			case "all":
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
			if (this.type === "all") {
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
			if (this.type !== "all") return this.hits[0];
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
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
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
	drawMarker(hit: ShapecastHit, size = 0.5, color = "#C6D8D3") {
		const center = hit.position;
		const normal = hit.impactNormal;
		// draw the normal and inverse normal
		this.drawDebuggingLine(center, center.clone().add(normal), "#3CD048");
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
		shapecast: Jolt.ShapeCast,
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
		//@ts-ignore this function was added to jolt.js #155
		const joltPosition = shapecast.GetPointOnRay(mHit.mFraction);
		this.position = vec3.three(joltPosition);
		// destroy things
		Raw.module.destroy(joltPosition);
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
		const position = vec3.jolt(this.position);
		let toReturn = new THREE.Vector3();
		shapeID.SetValue(this.shapeIdValue);
		const body = this.joltPhysicsSystem.GetBodyLockInterfaceNoLock().TryGetBody(bodyID);
		if (body) {
			const joltNormal = body.GetWorldSpaceSurfaceNormal(shapeID, position);
			toReturn = vec3.three(joltNormal);
			//Raw.module.destroy(joltNormal);
		}
		// destroy remaining jolt items
		//Raw.module.destroy(shapeID);
		// Raw.module.destroy(bodyID);
		//Raw.module.destroy(position);
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
