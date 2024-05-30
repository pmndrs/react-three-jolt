// this class has two primary functions:
// To manage the shape functions of Jolt
// To generate the shape from ThreeJS objects

// Inital code ffrom Isaac's Jolt Sketch:
//https://github.com/isaac-mason/sketches/blob/main/src/sketches/jolt-physics/jolt-react-api/three-to-jolt.ts

import type Jolt from "jolt-physics";
import * as THREE from "three";
import { BufferGeometry, Mesh, Object3D, Vector3 } from "three";
import { SphereGeometry, BoxGeometry, CapsuleGeometry, CylinderGeometry } from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { Raw } from "../raw";
import { anyVec3, quat, vec3 } from "../utils";

export class ShapeSystem {
	private physicsSystem: Jolt.PhysicsSystem;
	//@ts-ignore
	private bodyInterface: Jolt.BodyInterface;
	constructor(physicsSystem: Jolt.PhysicsSystem) {
		this.physicsSystem = physicsSystem;
		this.bodyInterface = this.physicsSystem.GetBodyInterface();
	}
}

export type AutoShape =
	| "box"
	| "sphere"
	| "capsule"
	| "taperedCapsule"
	| "cylinder"
	| "convex"
	| "trimesh"
	| "compound"
	| "heightfield";

export const getShapeSettingsFromObject = (
	object: Object3D,
	// why do I need this here?
	shapeType?: AutoShape
) => {
	// TODO: Add types here
	const shapes: any = [];

	object.traverse((child) => {
		if (child instanceof Object3D) {
			const geometry = (child as Mesh)?.geometry;
			// adding ignore to meshes skips the shape generator
			// TODO: Typescript HATES the ignore property.
			//@ts-ignore
			if (!child.ignore && geometry) {
				// TODO: Until we understand the offsets we are going to get both here
				const shapeSettingsAndOffset = getShapeSettingsFromGeometry(geometry, shapeType);

				if (shapeSettingsAndOffset) {
					const shape = {
						shapeSettings: shapeSettingsAndOffset.shapeSettings,
						offset: shapeSettingsAndOffset.offset,
						position: vec3.threeToJolt(child.position),
						quaternion: quat.threeToJolt(child.quaternion)
					};

					shapes.push(shape);
				}
			}
		}
	});

	// BAIL IF EMPTY
	// if (shapes.length === 0) return undefined;
	//console.log('shapes', shapes);
	// if theres only one, return it
	if (shapes.length === 1) return shapes[0].shapeSettings;
	const compoundShapeSettings = new Raw.module.StaticCompoundShapeSettings();

	// Note: offset also available
	for (const { shapeSettings, position, quaternion } of shapes) {
		compoundShapeSettings.AddShape(position, quaternion, shapeSettings, 0);

		Raw.module.destroy(position);
		Raw.module.destroy(quaternion);
	}

	return compoundShapeSettings;
};
// TODO: move this type later
type PossibleGeometry =
	| BufferGeometry
	| BoxGeometry
	| SphereGeometry
	| CapsuleGeometry
	| CylinderGeometry;
// check the instanceOf value against known three geometries
const getShapeTypeFromGeometry = (geometry: PossibleGeometry): AutoShape => {
	//hack the switch statement to check the instanceOf value
	switch (true) {
		case geometry instanceof BoxGeometry:
			return "box";
		case geometry instanceof SphereGeometry:
			return "sphere";
		case geometry instanceof CapsuleGeometry:
			return "capsule";
		case geometry instanceof CylinderGeometry:
			return "cylinder";
		// if unknown do a convex hull
		case geometry instanceof BufferGeometry:
			return "convex";
		default:
			// bail out with sphere
			return "convex";
	}
};

// We use shape settings because it lets us reuse this fn in compound shape generation
export const getShapeSettingsFromGeometry = (
	geometry: PossibleGeometry,
	shapeType?: AutoShape
):
	| {
			shapeSettings: Jolt.ShapeSettings | undefined;
			offset: Vector3 | undefined;
	  }
	| undefined => {
	const jolt = Raw.module;
	let shapeSettings, offset;

	// if the user passes the shape use that, if not, try to infer it from the geometry
	if (!shapeType) shapeType = getShapeTypeFromGeometry(geometry);
	switch (shapeType) {
		case "box": {
			geometry.computeBoundingBox();
			const { boundingBox } = geometry;
			let size;
			// if the geometry is a box, use it's parameters not the bounding box
			if (geometry instanceof BoxGeometry) {
				const { width, height, depth } = geometry.parameters;
				size = new Vector3(width, height, depth);
			} else size = boundingBox!.getSize(new Vector3());

			const shapeSize = new jolt.Vec3(size.x / 2, size.y / 2, size.z / 2);
			shapeSettings = new jolt.BoxShapeSettings(shapeSize);
			// jolt sucks at memory management
			jolt.destroy(shapeSize);

			offset = boundingBox!.getCenter(new Vector3());
			break;
		}

		case "sphere": {
			geometry.computeBoundingSphere();
			const { boundingSphere } = geometry;
			const radius = boundingSphere!.radius;

			shapeSettings = new jolt.SphereShapeSettings(radius);
			offset = boundingSphere!.center;
			break;
		}
		case "capsule": {
			// values set by parameters
			const { radius, length: height } = (geometry as CapsuleGeometry).parameters;
			shapeSettings = new jolt.CapsuleShapeSettings(height / 2, radius);
			offset = new Vector3(0, height / 2, 0);
			break;
		}

		case "cylinder": {
			// Jolt Cylinder doesn't take a top and bottom radius, so we'll just use the top radius
			const { radiusTop, height } = (geometry as CylinderGeometry).parameters;

			shapeSettings = new jolt.CylinderShapeSettings(height / 2, radiusTop, 0.5);
			offset = new Vector3(0, height / 2, 0);
			break;
		}
		// ConvexHull from points
		// this won't be determined from geometry automatically, but the user can pass it
		case "convex": {
			// generate a new geometry to hold the simplified geo
			const simplifiedGeo = geometry.clone();
			// not sure this is needed.
			//TODO: Check and cleanup if we need normals. if not merge from root geo
			simplifiedGeo.computeVertexNormals();
			// merge points
			const mergedPoints = BufferGeometryUtils.mergeVertices(simplifiedGeo);
			const points = mergedPoints.getAttribute("position").array;

			// create the hull
			shapeSettings = new jolt.ConvexHullShapeSettings();
			// add the points
			for (let i = 0; i < points.length; i += 3) {
				shapeSettings.mPoints.push_back(
					new jolt.Vec3(points[i], points[i + 1], points[i + 2])
				);
			}
			// Do we need to destroy the points, or will it destroy when the settings does?
			// we can probably destroy all the three helper objects
			// TODO: kill three objects

			break;
		}
		// trimesh as default if nothing else passed
		// using the buffer directly? which is better, array or direct?
		// base pulled from: https://github.com/sajal353/r3f-jolt/blob/main/src/Jolt/useTrimesh.ts
		default: {
			const vertices = geometry.getAttribute("position");
			const indices = geometry.index!.array;
			const verts = new jolt.VertexList();
			// loop over the bufferAttribute
			for (let i = 0; i < vertices.count; i++) {
				verts.push_back(
					new jolt.Float3(vertices.getX(i), vertices.getY(i), vertices.getZ(i))
				);
			}
			// make the triangle list
			const tris = new jolt.IndexedTriangleList();
			for (let i = 0; i < indices.length; i += 3) {
				tris.push_back(
					new jolt.IndexedTriangle(indices[i], indices[i + 1], indices[i + 2], 0)
				);
			}
			// not sure we need these mats
			const mats = new jolt.PhysicsMaterialList();
			mats.push_back(new jolt.PhysicsMaterial());

			shapeSettings = new jolt.MeshShapeSettings(verts, tris, mats);
		}
	}

	return { shapeSettings, offset };
};

// create a shape manually
export const generateShapeSettings = (
	shapeType: AutoShape,
	options?: any,
	inSettings?: Jolt.ShapeSettings
): Jolt.ShapeSettings => {
	const jolt = Raw.module;
	let shapeSettings = inSettings;

	// Switch based on shapeType to set the shapeSettings
	switch (shapeType) {
		case "sphere": {
			const radius = options.radius || 1;
			shapeSettings = new jolt.SphereShapeSettings(radius);
			break;
		}
		case "capsule": {
			const radius = options.radius || 1;
			const height = options.height || 1;
			shapeSettings = new jolt.CapsuleShapeSettings(height / 2, radius);
			break;
		}
		case "taperedCapsule": {
			const radius = options.radius || 1;
			const height = options.height || 1;
			const topRadius = options.topRadius || 0.5;
			shapeSettings = new jolt.TaperedCapsuleShapeSettings(height / 2, radius, topRadius);
			break;
		}
		case "cylinder": {
			const radius = options.radius || 1;
			const height = options.height || 1;
			shapeSettings = new jolt.CylinderShapeSettings(height / 2, radius, 0.5);
			break;
		}

		case "convex": {
			// if we passed a geometry pass to getShapeSettingsFromGeometry
			if (options.geometry) {
				const settings = getShapeSettingsFromGeometry(options.geometry, "convex");
				shapeSettings = settings!.shapeSettings;
				break;
			}
			const points = options.points || [];
			shapeSettings = new jolt.ConvexHullShapeSettings();
			points.forEach((point: Vector3) => {
				//@ts-ignore
				shapeSettings!.mPoints.push_back(new jolt.Vec3(point.x, point.y, point.z));
			});
			break;
		}
		// this one is heavy
		case "trimesh": {
			if (options.geometry) {
				const settings = getShapeSettingsFromGeometry(options.geometry, "trimesh");
				shapeSettings = settings!.shapeSettings;
				break;
			}
			const vertices = options.vertices || [];
			const indices = options.indices || [];
			const verts = new jolt.VertexList();
			vertices.forEach((point: Vector3) => {
				verts.push_back(new jolt.Float3(point.x, point.y, point.z));
			});
			const tris = new jolt.IndexedTriangleList();
			indices.forEach((tri: number[]) => {
				tris.push_back(new jolt.IndexedTriangle(tri[0], tri[1], tri[2], 0));
			});
			const mats = new jolt.PhysicsMaterialList();
			mats.push_back(new jolt.PhysicsMaterial());

			shapeSettings = new jolt.MeshShapeSettings(verts, tris, mats);
			break;
		}
	}
	// typescript needs this for some reason
	// TODO: remove this and get ts to recognize the default in the switch
	if (!shapeSettings) {
		shapeSettings = new jolt.BoxShapeSettings(new jolt.Vec3(1, 1, 1));
	}
	return shapeSettings;
};

export type CompoundShapeData = {
	shapeSettings: Jolt.ShapeSettings;
	position: anyVec3;
	quaternion: THREE.Quaternion;
	shape?: Jolt.Shape;
};
export const generateCompoundShapeSettings = (shapes: CompoundShapeData[], dynamic = false) => {
	const jolt = Raw.module;
	const compoundShapeSettings = dynamic
		? //@ts-ignore for now as it is loaded at runtime. Type will be added soon.
			new jolt.MutableCompoundShapeSettings()
		: new jolt.StaticCompoundShapeSettings();
	shapes.forEach(({ shapeSettings, position: inPosition, quaternion: inQuaternion }) => {
		const position = vec3.jolt(inPosition);
		const quaternion = quat.jolt(inQuaternion);
		compoundShapeSettings.AddShape(position, quaternion, shapeSettings, 0);
		//destroy the memory
		jolt.destroy(position);
		jolt.destroy(quaternion);
	});
	return compoundShapeSettings;
};

// take a threejs plane that is a heightfield and generate a Jolt heightfield shape
// this is a WIP
export const generateHeightfieldShapeFromThree = (heightfieldPlane: THREE.Mesh) => {
	//TODO: resolve what these props do
	//const mapScale = 0.35;
	const BLOCK_SIZE = 2;

	const jolt = Raw.module;
	const geometry = heightfieldPlane.geometry as THREE.PlaneGeometry;
	const vertices = geometry.attributes.position.array as Float32Array;
	const vertexCount = vertices.length / 3;
	const size = Math.sqrt(vertexCount);
	const planeWidth = geometry.parameters.width;
	const scale = planeWidth / size;
	//const positionVal = -size * scale * 0.5;

	// create the heightfield
	const shapeSettings = new jolt.HeightFieldShapeSettings();
	shapeSettings.mOffset.Set(0, 0, 0);
	shapeSettings.mScale.Set(scale, 1, scale);
	shapeSettings.mSampleCount = size;
	shapeSettings.mBlockSize = BLOCK_SIZE;
	shapeSettings.mHeightSamples.resize(vertexCount);

	const heightSamples = new Float32Array(
		jolt.HEAPF32.buffer,
		jolt.getPointer(shapeSettings.mHeightSamples.data()),
		vertexCount
	); // Convert the height samples into a Float32Array
	//@ts-ignore
	heightSamples.forEach((o, i) => {
		heightSamples[i] = vertices[i * 3 + 1];
		//heightSamples[i] = 1;
		// TODO: NOTE, this implementation does not allow holes in the map, which Jolt supports
		//heightSamples[i] = Jolt.HeightFieldShapeConstantValues.prototype.cNoCollisionValue; // Invisible pixels make holes
	});
	return shapeSettings;
};

// Take a complex Jolt shape and generate a ThreeJS mesh
//taken from jolt examples
export function createMeshForShape(shape: Jolt.Shape): THREE.BufferGeometry {
	// Get triangle data
	const scale = new Raw.module.Vec3(1, 1, 1);
	const triContext = new Raw.module.ShapeGetTriangles(
		shape,
		Raw.module.AABox.prototype.sBiggest(),
		shape.GetCenterOfMass(),
		Raw.module.Quat.prototype.sIdentity(),
		scale
	);
	Raw.module.destroy(scale);

	// Get a view on the triangle data (does not make a copy)
	const vertices = new Float32Array(
		Raw.module.HEAPF32.buffer,
		triContext.GetVerticesData(),
		triContext.GetVerticesSize() / Float32Array.BYTES_PER_ELEMENT
	);

	// Now move the triangle data to a buffer and clone it so that we can free the memory from the C++ heap (which could be limited in size)
	const buffer = new THREE.BufferAttribute(vertices, 3).clone();
	Raw.module.destroy(triContext);

	// Create a three mesh
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", buffer);
	geometry.computeVertexNormals();

	return geometry;
}
