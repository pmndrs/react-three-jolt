// ridged body wrapping and mesh components
// biome-ignore lint/style/useImportType: <explanation>
import type Jolt from "jolt-physics";
import React, {
	createContext,
	memo,
	useEffect,
	useState,
	//  useLayoutEffect,
	useMemo,
	useRef,
	forwardRef,
	ReactNode
} from "react";
import * as THREE from "three";
import { Object3D } from "three";
import { useForwardedRef, useJolt, useMount } from "../../hooks";
import { vec3 } from "../../utils";
import { AutoShape, BodyState, CompoundShapeData } from "../../systems";
import { generateShapeSettings, generateCompoundShapeSettings } from "../../systems";
// creates a Jolt Shape from three.js meshes.
//NOTE by default doesn't render them

// Shape Props
interface ShapeProps {
	children: ReactNode;
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
			scale = [1, 1, 1],
			...options
		} = props;

		const { jolt, physicsSystem } = useJolt();
		const shapeSystem = physicsSystem.bodySystem.shapeSystem;
		const ref = useForwardedRef(forwardedRef);

		// dynamic checker
		const dynamicOnInit = useRef(dynamic);

		// if the user tries to change the dynamic prop throw an error
		if (dynamicOnInit.current !== dynamic) {
			throw new Error("Cannot change dynamic prop after initialization");
		}
		const isScaled = dynamic && !children;

		const [shape, setShape] = useState<Jolt.Shape>();
		const shapeSettings = useRef<Jolt.ShapeSettings>();
		const baseShape = useRef<Jolt.Shape>();

		// helper method to generate the compound shape data
		const generatecompoundData = (settings): CompoundShapeData => {
			const quaternion = new THREE.Quaternion().setFromEuler(
				new THREE.Euler().fromArray(options.rotation || [0, 0, 0])
			);
			return {
				shapeSettings: settings,
				position: position,
				quaternion: quaternion
			};
		};
		// sets or updates the shape with scale
		const updateScaleShape = () => {
			if (!isScaled || !baseShape.current) return;
			const currentScaledShape = shape;
			//todo: do we need to cleanup this vec3?
			setShape(new jolt.ScaledShape(baseShape.current, vec3.jolt(scale)));
			// cleanup the old shape
			jolt.destroy(currentScaledShape);
		};
		// creates the shape from scratch
		const generateShape = () => {
			if (!shapeSettings.current) return;
			// if there is already a shape, save it and destroy it in a minute
			let currentShape: Jolt.Shape | undefined;
			if (baseShape.current) currentShape = baseShape.current;

			// if we have children we are a compound shape
			if (children) {
				// get the shapes from the children
				console.log("children", children);
			}
			//generate the shape
			baseShape.current = shapeSettings.current.Create().Get();
			// if we need to scale, wrap the shape in a transformShape
			if (isScaled) {
				updateScaleShape();
			} else {
				setShape(baseShape.current);
			}
			// cleanup the old shape
			if (currentShape) jolt.destroy(currentShape);
		};
		// updates the shape using the existing shapesettings

		// when the component mounts create the shape
		useEffect(() => {
			// we have to have a shape even if it gets replaced
			shapeSettings.current = generateShapeSettings(type, options);
			generateShape();
		}, [type, options, generateShape]);

		// WHen the shape changes
		useEffect(() => {
			ref.current = generatecompoundData(shapeSettings.current);
		}, [shape]);

		return (
			<ShapeContext.Provider
				value={{
					shape
				}}
			>
				{children}
			</ShapeContext.Provider>
		);
	})
);
