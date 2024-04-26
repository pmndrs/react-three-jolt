// ridged body wrapping and mesh components
import React, {
	createContext,
	memo,
	useEffect,
	//  useLayoutEffect,
	useMemo,
	useRef,
	forwardRef,
	ReactNode
} from "react";
import * as THREE from "three";
import { Object3D } from "three";
import { useForwardedRef, useJolt } from "../hooks";
import { getThreeObjectForBody } from "../systems/body-system";
import { vec3 } from "../utils";
import { BodyState } from "../systems";

interface RigidBodyProps {
	children: ReactNode;
	key?: number;
	position?: number[];
	rotation?: number[];
	onContactAdded?: (body1: number, body2: number) => void;
	onContactRemoved?: (body1: number, body2: number) => void;
	onContactPersisted?: (body1: number, body2: number) => void;
	// sleep listener
	//wake listener
	// this is MOTION Type
	type?: string;
	shape?: string;
	debug?: boolean;
	ref?: any;
	allowObstruction?: boolean;
	obstructionTimelimit?: number;
	isSensor?: boolean;

	//TODO: do these work yet?
	scale?: number[];
	mass?: number;
	// remove
	quaternion?: number[];
}
export interface RigidBodyContext {
	object: any;
	type: string | undefined;
	position: THREE.Vector3 | undefined;
	rotation: THREE.Vector3 | undefined;
	scale: THREE.Vector3 | undefined;
	quaternion: THREE.Quaternion | undefined;
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
			scale,
			mass,
			quaternion,
			isSensor,

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
		const debugMeshRef = useRef<THREE.Mesh>(null);
		// load the jolt stuff
		const { bodySystem, debug: physicsDebug } = useJolt();
		// this allows us to debug on the physics system or the component specifically
		const debug = propDebug || physicsDebug;
		//* Load the body -------------------------------------
		useEffect(() => {
			if (!bodySystem) return;
			if (objectRef.current) {
				//handle options from props
				const options = {
					bodyType: type || "dynamic", // default to dynamic
					shapeType: shape || null
				};
				//put the initial position, rotation, scale, and quaternion in the options
				if (position) objectRef.current.position.copy(vec3.three(position));
				if (rotation) objectRef.current.rotation.setFromVector3(vec3.three(rotation));
				//@ts-ignore
				const bodyHandle = bodySystem.addBody(objectRef.current, options);
				const body = bodySystem.getBody(bodyHandle);
				rigidBodyRef.current = body;
			}
			//destroy the rigidBody When this component is unmounted
			return () => {
				//@ts-ignore
				bodySystem.removeBody(rigidBodyRef.current.handle);
			};
		}, [bodySystem]);
		//*/ Debugging -------------------------------------
		useEffect(() => {
			if (debug && debugMeshRef.current) {
				// get the debug threeObject for this body
				//@ts-ignore
				const debugObject = getThreeObjectForBody(rigidBodyRef.current.body);
				debugMeshRef.current.geometry = debugObject.geometry;
				debugMeshRef.current.material = new THREE.MeshStandardMaterial({
					color: 0xff0000,
					wireframe: true
				});
			}
		}, [debug]);

		//* Prop Updates -------------------------------------
		useEffect(() => {
			if (!rigidBodyRef.current) return;
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
			if (isSensor !== undefined) body.body.SetIsSensor(isSensor);
		}, [position, rotation, isSensor, rigidBodyRef]);

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
		}, [mass, allowObstruction, obstructionTimelimit]);

		// the context should update when a new handle is added
		//@ts-ignore
		const contextValue: RigidBodyContext = useMemo(() => {
			return {
				object: objectRef.current,
				type,
				position,
				rotation,
				scale,
				quaternion
			};
		}, [objectRef, type, position, rotation, scale, quaternion]);
		return (
			<RigidBodyContext.Provider value={contextValue}>
				<object3D ref={objectRef} {...objectProps}>
					{children}
					<mesh ref={debugMeshRef} visible={debug} ignore />
				</object3D>
			</RigidBodyContext.Provider>
		);
	})
);
