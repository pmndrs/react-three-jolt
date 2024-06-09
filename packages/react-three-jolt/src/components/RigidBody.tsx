// ridged body wrapping and mesh components
import Jolt from "jolt-physics";
import React, {
	createContext,
	memo,
	useEffect,
	//  useLayoutEffect,
	useMemo,
	useRef,
	forwardRef,
	ReactNode,
	Children
} from "react";
import * as THREE from "three";
import { Object3D } from "three";
import { useForwardedRef, useJolt, useUnmount } from "../hooks";
import { BodyType, GenerateBodyOptions } from "../systems/body-system";
import { vec3 } from "../utils";
import { AutoShape, BodyState } from "../systems";

interface RigidBodyProps {
	children: ReactNode;
	key?: number;
	position?: number[];
	rotation?: number[];
	onlyInitialize?: boolean;
	onContactAdded?: (body1: number, body2: number) => void;
	onContactRemoved?: (body1: number, body2: number) => void;
	onContactPersisted?: (body1: number, body2: number) => void;
	// sleep listener
	//wake listener
	// this is MOTION Type
	type?: BodyType;
	shape?: AutoShape;
	debug?: boolean;
	ref?: any;
	allowObstruction?: boolean;
	obstructionTimelimit?: number;
	isSensor?: boolean;

	// groups
	group?: number;
	subGroup?: number;

	//physics props
	linearDamping?: number;
	angularDamping?: number;
	friction?: number;
	scale?: number[];

	// dof
	lockRotations?: boolean;
	lockTranslations?: boolean;
	dof?: { x?: boolean; y?: boolean; z?: boolean; rotX?: boolean; rotY?: boolean; rotZ?: boolean };
	//TODO: do these work yet?

	mass?: number;
	// remove
	quaternion?: number[];
}
export interface RigidBodyContext {
	body: BodyState | undefined;
	type: BodyType | undefined;
	position: THREE.Vector3 | undefined;
	rotation: THREE.Vector3 | undefined;
	scale: THREE.Vector3 | undefined;
	quaternion: THREE.Quaternion | undefined;
	// methods
	setActiveShape: (shape: any) => void;
}
export const RigidBodyContext = createContext<RigidBodyContext | undefined>(undefined!);

// the ridgedBody is a forwardRef so we can pass props directly
// inital version from r3/rapier
export const RigidBody: React.FC<RigidBodyProps> = memo(
	forwardRef((props, forwardedRef) => {
		const {
			children,

			type,
			shape,
			position,
			rotation,
			onlyInitialize,
			scale,
			mass,
			quaternion,
			isSensor,
			angularDamping,
			linearDamping,
			group,
			subGroup,

			// obstruction
			allowObstruction,
			obstructionTimelimit,

			//dof
			lockRotations,
			lockTranslations,
			dof,

			debug: propDebug,

			onContactAdded,
			onContactRemoved,
			onContactPersisted,
			...objectProps
		} = props;

		const objectRef = useRef<Object3D>(null);
		//TODO: Figure out way to put BodyState type on this ref
		const rigidBodyRef = useForwardedRef(forwardedRef);

		// state refs allow us to track if inputs have changed without triggering a re-render
		const prevPosition = useRef<THREE.Vector3 | undefined>(undefined);
		const prevRotation = useRef<THREE.Quaternion | undefined>(undefined);

		// load the jolt stuff
		const { bodySystem, debug: physicsDebug } = useJolt();

		// States
		const bodyLoaded = useRef(false);
		const [activeShape, setActiveShape] = React.useState<Jolt.Shape>();

		// this allows us to debug on the physics system or the component specifically
		const debug = propDebug || physicsDebug;

		//* Load the body -------------------------------------
		// todo: we cant use useMount here because we need the shape dependencies
		useEffect(() => {
			if (!bodySystem || bodyLoaded.current) return;
			// detect if any of the children are shapes
			let hasShapes = false;
			if (children)
				Children.toArray(children).forEach((child) => {
					//@ts-ignore
					if (child.type && child.type.displayName === "Shape") hasShapes = true;
				});
			//if (hasShapes) console.log("hasShapes", hasShapes, activeShape);
			// if the children are shapes, we will wait for them to mount
			if (hasShapes && !activeShape) return;
			// todo: is this protection needed?
			if (objectRef.current) {
				//handle options from props
				const options: GenerateBodyOptions = {
					group: group,
					subGroup: subGroup,
					shape: activeShape,
					bodyType: type,
					shapeType: shape
				};
				//put the initial position, rotation, scale, and quaternion in the options
				if (position) objectRef.current.position.copy(vec3.three(position));
				if (rotation) objectRef.current.rotation.setFromVector3(vec3.three(rotation));

				//@ts-ignore
				const bodyHandle = bodySystem.addBody(objectRef.current, options);
				const body = bodySystem.getBody(bodyHandle);
				if (!body) throw new Error("Body not found");
				rigidBodyRef.current = body;
				bodyLoaded.current = true;

				// for cycle reasons some stuff might have gotten missed
				// try setting the debug
				if (debug) body.debug = debug;
				if (position) body.position = vec3.three(position);
				if (rotation)
					body.rotation = new THREE.Quaternion().setFromEuler(
						new THREE.Euler(rotation[0], rotation[1], rotation[2])
					);
			}
		}, [activeShape, bodySystem, rigidBodyRef]);

		// When destroying we need to do some stuff
		useUnmount(() => {
			bodySystem.removeBody((rigidBodyRef.current! as BodyState).handle);
		});

		//*/ Debugging -------------------------------------

		useEffect(() => {
			if (rigidBodyRef.current) (rigidBodyRef.current as BodyState).debug = debug;
		}, [debug, rigidBodyRef]);

		//* Shape Updates -------------------------------------
		// Shape update
		useEffect(() => {
			if (!rigidBodyRef.current || !bodyLoaded) return;
			const body = rigidBodyRef.current as BodyState;
			if (activeShape) body.shape = activeShape;
			//if we have a scale we should also set the scale on this new shape
			if (scale) body.scale = vec3.three(scale);
		}, [activeShape, rigidBodyRef]);

		// scale the shape when the input scale changes
		useEffect(() => {
			if (!rigidBodyRef.current || !bodyLoaded) return;
			const body = rigidBodyRef.current as BodyState;
			if (scale) body.scale = vec3.three(scale);
		}, [scale, rigidBodyRef]);
		//* Prop Updates -------------------------------------
		useEffect(() => {
			if (!rigidBodyRef.current || onlyInitialize) return;
			const body = rigidBodyRef.current as BodyState;
			if (position) {
				// this adds a little to things,and might be worth not doing onlyInitialize
				// but if the input hasn't changed we should ignore this
				const newPositon = vec3.three(position);
				if (!prevPosition.current || !newPositon.equals(prevPosition.current)) {
					body.position = newPositon;
					prevPosition.current = newPositon;
				}
			}
			if (rotation) {
				const quaternion = Array.isArray(rotation)
					? new THREE.Quaternion().setFromEuler(
							new THREE.Euler(rotation[0], rotation[1], rotation[2])
						)
					: rotation;
				// if the input hasn't changed we should ignore this
				if (!prevRotation.current || !quaternion.equals(prevRotation.current)) {
					body.rotation = quaternion;
					prevRotation.current = quaternion;
				}
			}
		}, [onlyInitialize, position, rotation, rigidBodyRef]);

		// add the contact listeners
		useEffect(() => {
			const rb = rigidBodyRef.current as BodyState;
			if (rigidBodyRef.current) {
				if (onContactAdded) rb.addContactListener(onContactAdded, "added");
				if (onContactRemoved) rb.addContactListener(onContactRemoved, "removed");
				if (onContactPersisted) rb.addContactListener(onContactPersisted, "persisted");
			}
			// remove the listeners
			return () => {
				if (rigidBodyRef.current) {
					if (onContactAdded) rb.removeContactListener(onContactAdded);
					if (onContactRemoved) rb.removeContactListener(onContactRemoved);
					if (onContactPersisted) rb.removeContactListener(onContactPersisted);
				}
			};
		}, [rigidBodyRef.current, onContactAdded, onContactRemoved, onContactPersisted]);

		//not sure these should be set as useEffects or directly in the body
		useEffect(() => {
			if (!rigidBodyRef.current) return;
			const body = rigidBodyRef.current as BodyState;
			//@ts-ignore
			if (mass) bodySystem.setMass(body.handle, mass);
			if (linearDamping) body.linearDamping = linearDamping;
			if (angularDamping) body.angularDamping = angularDamping;

			// check if the body is allowing obstruction
			const isAllowing = body.allowObstruction;
			if (allowObstruction !== undefined) {
				if (isAllowing !== allowObstruction) {
					body.allowObstruction = allowObstruction as boolean;
				}
				if (obstructionTimelimit) {
					body.obstructionType = "temporal";
					body.obstructionTimelimit = obstructionTimelimit;
				}
			}
			if (isSensor !== undefined) body.body.SetIsSensor(isSensor);
		}, [
			mass,
			allowObstruction,
			obstructionTimelimit,
			linearDamping,
			angularDamping,
			rigidBodyRef,
			isSensor
		]);

		//* Groups -------------------------------------
		useEffect(() => {
			if (!rigidBodyRef.current) return;
			const body = rigidBodyRef.current as BodyState;
			if (group) body.group = group;
			if (subGroup) body.subGroup = subGroup;
		}, [group, subGroup, rigidBodyRef]);

		//* DOF -------------------------------------
		useEffect(() => {
			if (!rigidBodyRef.current) return;
			const body = rigidBodyRef.current as BodyState;
			if (dof) {
				const { x, y, z, rotX, rotY, rotZ } = dof;
				body.setEnabledTranslations(x || false, y || false, z || false);
				body.setEnabledRotations(rotX || false, rotY || false, rotZ || false);
			}
			if (lockRotations) body.lockRotations();
			if (lockTranslations) body.lockTranslations();
		}, [dof, lockRotations, lockTranslations, rigidBodyRef]);

		// the context should update when a new handle is added
		//@ts-ignore
		const contextValue: RigidBodyContext = useMemo(() => {
			return {
				body: rigidBodyRef.current,
				type,
				position,
				rotation,
				scale,
				quaternion,
				setActiveShape
			};
		}, [rigidBodyRef, type, position, rotation, scale, quaternion]);
		return (
			<RigidBodyContext.Provider value={contextValue}>
				<object3D ref={objectRef} {...objectProps}>
					{children}
				</object3D>
			</RigidBodyContext.Provider>
		);
	})
);
