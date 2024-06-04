// ridged body wrapping and mesh components
// biome-ignore lint/style/useImportType: <explanation>
import type Jolt from "jolt-physics";
import React, {
	createContext,
	memo,
	useEffect,
	useState,
	//  useLayoutEffect,
	//useMemo,
	useRef,
	forwardRef,
	ReactNode,
	useContext
} from "react";
import * as THREE from "three";
//import { Object3D } from "three";

import { useForwardedRef, useJolt } from "../../hooks";
import { quat, vec3 } from "../../utils";
import { AutoShape, CompoundShapeData, generateCompoundShapeSettings } from "../../systems";
import {
	generateShapeSettings
	//generateCompoundShapeSettings
} from "../../systems";
import { RigidBodyContext } from "../RigidBody";
// creates a Jolt Shape from three.js meshes.
//NOTE by default doesn't render them

// Shape Props
interface ShapeProps {
	children?: ReactNode;
	position?: number[];
	rotation?: [number, number, number];
	scale?: number[];

	dynamic?: boolean;
	type?: AutoShape;
	size?: number[];
	height?: number;
	radius?: number;
	topRadius?: number;
	geometry?: THREE.BufferGeometry;
	verts?: number[];
	indexes?: number[];
}

export interface ShapeContext {
	shape: any;
	addShape: (shapeData: CompoundShapeData) => number | undefined;
	modifyShape: (index: number, shapeData: CompoundShapeData) => void;
}
export const ShapeContext = createContext<ShapeContext | undefined>(undefined!);

export const Shape: React.FC<ShapeProps> = memo(
	forwardRef((props, forwardedRef) => {
		const {
			children,
			dynamic = false,
			type = "box",
			position = [0, 0, 0],
			rotation = [0, 0, 0],
			scale,
			...options
		} = props;

		const { jolt } = useJolt();
		//const shapeSystem = physicsSystem.bodySystem.shapeSystem;
		const ref = useForwardedRef(forwardedRef);
		// get the rigid body context
		const { setActiveShape } = useContext(RigidBodyContext) as RigidBodyContext;
		// if we are the child of another shape, we can get the shape context
		const parentShape = useContext(ShapeContext);
		//console.log("parentShape", parentShape);

		// dynamic checker
		const dynamicOnInit = useRef(dynamic);

		// if the user tries to change the dynamic prop throw an error
		if (dynamicOnInit.current !== dynamic) {
			throw new Error("Cannot change dynamic prop after initialization");
		}
		const isScaled = scale || (dynamic && !children);
		//console.log("isScaled", isScaled);

		const [shape, setShape] = useState<Jolt.Shape>();
		const shapeSettings = useRef<Jolt.ShapeSettings>();
		const baseShape = useRef<Jolt.Shape>();
		const prevShape = useRef<Jolt.Shape>();
		const prevScale = useRef<number[]>();

		// Compound Shape Data
		// lets try as a ref first
		const subShapes = useRef<CompoundShapeData[]>([]);
		const compoundInitialized = useRef(false);
		const addedToParent = useRef(false);

		// callable function to add a shape to the compound shape. return the new index
		const addShape = (shapeData: CompoundShapeData) => {
			if (compoundInitialized.current && !dynamic) return;
			subShapes.current.push(shapeData);
			if (compoundInitialized.current && dynamic) {
				// we are a mutableCompoundShape
				//const mutableCompound = baseShape.current; // as Jolt.MutableCompoundShape;
				// if(mutableCompound) mutableCompound.AddShape(shapeData);
			}
			return subShapes.current.length - 1;
		};

		// modify the shape at the index
		const modifyShape = (index: number, shapeData: CompoundShapeData) => {
			subShapes.current[index] = shapeData;
			if (compoundInitialized.current && dynamic) {
				const position = vec3.jolt(shapeData.position);
				const quaternion = quat.jolt(shapeData.quaternion);
				// we are a mutableCompoundShape
				const mutableCompound = baseShape.current; // as Jolt.MutableCompoundShape;
				//@ts-ignore
				if (mutableCompound) mutableCompound.ModifyShape(index, position, quaternion);
				// cleanup jolt items
				jolt.destroy(position);
				jolt.destroy(quaternion);
			}
			// if we are scaled we need to reapply the scale to not shear
			if (isScaled) updateScaleShape();
		};

		// helper method to generate the compound shape data
		const generatecompoundData = (settings: any): CompoundShapeData => {
			const quaternion = new THREE.Quaternion().setFromEuler(
				//@ts-ignore
				new THREE.Euler().fromArray(options.rotation || [0, 0, 0])
			);
			return {
				shapeSettings: settings,
				position: position,
				quaternion: quaternion,
				shape: baseShape.current
			};
		};
		// sets or updates the shape with scale
		const updateScaleShape = () => {
			if (!isScaled || !baseShape.current) return;
			// because we can have no scale set and be dynamic have a scale fallback
			const shapeScale = vec3.jolt(scale || [1, 1, 1]);
			const currentScaledShape = shape;
			//console.log("Setting shape from update scale shape");
			setShape(baseShape.current.ScaleShape(shapeScale).Get());
			// cleanup the old shape
			//if (currentScaledShape) jolt.destroy(currentScaledShape);
			jolt.destroy(shapeScale);
		};
		// creates the shape from scratch
		const generateShape = () => {
			if (!shapeSettings.current) return;
			// if there is already a shape, save it and destroy it in a minute
			let currentShape: Jolt.Shape | undefined;
			if (baseShape.current) currentShape = baseShape.current;

			//generate the shape
			baseShape.current = shapeSettings.current.Create().Get();
			// if we need to scale, wrap the shape in a transformShape
			if (isScaled) {
				updateScaleShape();
			} else {
				//console.log("Setting shape from generate shape");
				setShape(baseShape.current);
			}
			// cleanup the old shape
			//if (currentShape) jolt.destroy(currentShape);
		};
		// updates the shape using the existing shapesettings

		// when the component mounts create the shape
		useEffect(() => {
			if (children) {
				// we are a compound shape.
				//console.log("compound shape", subShapes.current);
				// for now lets do everything as static
				shapeSettings.current = generateCompoundShapeSettings(subShapes.current);
			} else {
				// we have to have a shape even if it gets replaced
				shapeSettings.current = generateShapeSettings(type, options);
			}
			generateShape();
		}, [type]);

		// When the scale changes
		useEffect(() => {
			if (!isScaled || scale === prevScale.current) return;
			prevScale.current = scale;
			console.log("Scale has changed in shape", scale);
			updateScaleShape();
		}, [scale]);

		// WHen the shape changes
		useEffect(() => {
			ref.current = generatecompoundData(shapeSettings.current);
			// if we are a child we need to do stuff to the parent
			if (parentShape) {
				if (!addedToParent.current) {
					// if the parent is a compound shape we need to add this shape to it
					console.log("Adding to parent shape", ref.current);
					//@ts-ignore
					if (ref.current) parentShape.addShape(ref.current);
					addedToParent.current = true;
				}
			} else {
				if (shape === prevShape.current) return;
				prevShape.current = shape;
				console.log("Shape: Sending to RB new shape", ref.current);
				// if we are the top level shape, we need to set the active shape
				setActiveShape(shape);
			}
		}, [shape]);

		return (
			<ShapeContext.Provider
				value={{
					shape,
					addShape,
					modifyShape
				}}
			>
				{children}
			</ShapeContext.Provider>
		);
	})
);
Shape.displayName = "Shape";
