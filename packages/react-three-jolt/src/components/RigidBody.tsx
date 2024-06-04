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
import { BodyType, GenerateBodyOptions, getThreeObjectForBody } from "../systems/body-system";
import { vec3 } from "../utils";
import { BodyState } from "../systems";

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
	shape?: string;
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

	//TODO: do these work yet?
	scale?: number[];
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

			debug: propDebug,

			onContactAdded,
			onContactRemoved,
			onContactPersisted,
			...objectProps
		} = props;

		const objectRef = useRef<Object3D>(null);
		//TODO: Figure out way to put BodyState type on this ref
		const rigidBodyRef = useForwardedRef(forwardedRef);
		const debugMesh = useRef<THREE.Mesh>();

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
			// if the children are shapes, we will wait for them to mount
			if (hasShapes && !activeShape) return;
			// todo: is this protection needed?
			if (objectRef.current) {
				//handle options from props
				const options: GenerateBodyOptions = {
					group: group,
					subGroup: subGroup,
					shape: activeShape,
					bodyType: type
				};
				//put the initial position, rotation, scale, and quaternion in the options
				if (position) objectRef.current.position.copy(vec3.three(position));
				if (rotation) objectRef.current.rotation.setFromVector3(vec3.three(rotation));

				//@ts-ignore
				const bodyHandle = bodySystem.addBody(objectRef.current, options);
				const body = bodySystem.getBody(bodyHandle);
				rigidBodyRef.current = body;
				console.log("body created", body);
			}
			bodyLoaded.current = true;
		}, [activeShape, bodySystem, rigidBodyRef]);

		// When destroying we need to do some stuff
		useUnmount(() => {
			console.log("RB Destroying");
			//@ts-ignore
			bodySystem.removeBody(rigidBodyRef.current.handle);
		});

		//*/ Debugging -------------------------------------
		// create the debug mesh
		const createDebugMesh = () => {
			const bodyState = rigidBodyRef.current as BodyState;
			const newMesh = getThreeObjectForBody(bodyState.body);
			newMesh.material = new THREE.MeshPhongMaterial({
				color: 0xff0000,
				wireframe: true
			});
			// set the debugMesh
			debugMesh.current = newMesh;
		};
		useEffect(() => {
			if (!rigidBodyRef.current) return;
			if (debug) {
				if (!debugMesh.current) createDebugMesh();

				objectRef.current!.add(debugMesh.current!);
			}
			if (!debug && debugMesh.current) {
				objectRef.current!.remove(debugMesh.current);
			}
		}, [debug, createDebugMesh, rigidBodyRef]);

		//* Shape Updates -------------------------------------
		// Shape update
		useEffect(() => {
			if (!rigidBodyRef.current || !bodyLoaded) return;
			console.log("RB setting shape");
			const body = rigidBodyRef.current as BodyState;
			if (activeShape) {
				body.shape = activeShape;
				// if there is a debug mesh, update it
				// if we are debugging

				if (debug) {
					// remove the existing mesh
					if (debugMesh.current) objectRef.current!.remove(debugMesh.current);
					createDebugMesh();
					objectRef.current!.add(debugMesh.current!);
					console.log("Debug Mesh Reset");
				} else {
					// if we are not debugging, remove the debug mesh
					if (debugMesh.current) {
						// todo: probably can remove this, safty removal
						objectRef.current!.remove(debugMesh.current);
						debugMesh.current = undefined;
					}
				}
			}
		}, [activeShape, rigidBodyRef]);

		// scale the shape when the input scale changes
		useEffect(() => {
			if (!rigidBodyRef.current || !bodyLoaded) return;
			const body = rigidBodyRef.current as BodyState;
			if (scale) {
				body.scale = vec3.three(scale);
			}
		}, [scale, rigidBodyRef]);
		//* Prop Updates -------------------------------------
		useEffect(() => {
			if (!rigidBodyRef.current || onlyInitialize) return;
			const body = rigidBodyRef.current as BodyState;
			if (position) body.position = vec3.three(position);
			if (rotation) {
				const quaternion = Array.isArray(rotation)
					? new THREE.Quaternion().setFromEuler(
							new THREE.Euler(rotation[0], rotation[1], rotation[2])
						)
					: rotation;
				body.rotation = quaternion;
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
					console.log("setting allow obstruction", allowObstruction);
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

		// groups
		useEffect(() => {
			if (!rigidBodyRef.current) return;
			const body = rigidBodyRef.current as BodyState;
			if (group) body.group = group;
			if (subGroup) body.subGroup = subGroup;
		}, [group, subGroup, rigidBodyRef]);

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
