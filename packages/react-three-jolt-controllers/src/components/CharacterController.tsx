import React, { useState } from "react";
import { useRef, useEffect, forwardRef, memo } from "react";
import { useThree } from "@react-three/fiber";
import { useJolt } from "@react-three/jolt";
import * as THREE from "three";
import { CharacterControllerSystem } from "../systems/character-controller";
import { useCommand } from "@react-three/jolt-addons";
import { useForwardedRef } from "@react-three/jolt";
// create a blank context
export const CharacterControllerContext = React.createContext(undefined!);
interface CControllerProps {
	children?: any;
	radius?: number;
	height?: number;
	debug?: boolean;
	rest?: any;
	position?: any;
	anchor?: any;
}
export const CharacterController: React.FC<CControllerProps> = memo(
	forwardRef((props, forwardedRef) => {
		const {
			children,
			radius = 1,
			height = 2,
			debug = true,
			//@ts-ignore
			...objectProps
		} = props;
		//@ts-ignore pass the body via the ref
		const characterRef = useForwardedRef(forwardedRef);

		const objectRef = useRef<THREE.Object3D>(null);
		const offsetObject = useRef<THREE.Object3D>(null);
		const debugCapsule = useRef<THREE.Mesh>(null);
		const { physicsSystem } = useJolt();
		//TODO: Not really sure why we had to do this as a state but oh well
		const [characterSystem, setCharacterSystem] = useState<
			CharacterControllerSystem | undefined
		>(undefined);

		// we need the three camera
		const { camera, scene } = useThree();

		const cameraRotation = new THREE.Quaternion();
		// set values and initializers for characterSystem
		useEffect(() => {
			const newCCS = new CharacterControllerSystem(physicsSystem);
			//@ts-ignore
			newCCS.add(objectRef.current);
			newCCS.addToScene(scene);
			//newCCS.setCapsule(radius, height);

			setCharacterSystem(newCCS);
		}, []);

		// set debugging
		useEffect(() => {
			if (!characterSystem) return;
			characterSystem.debug = debug;
		}, [characterSystem, debug]);

		// trigger commands
		useCommand(
			"run",
			(info) => {
				// TODO Check this TS error. isInitial should exist
				//@ts-ignore
				if (!info.isInitial) return;
				// console.log('Start running', info);
				characterSystem!.startRunning();
			},
			() => {
				//console.log('Stop running', info);
				characterSystem!.stopRunning();
			}
		);
		// TODO move to utils
		// gets the horizontal rotation of the camera
		const getHorizontalRotation = () => {
			const cameraRotation = new THREE.Quaternion();
			camera.getWorldQuaternion(cameraRotation);
			cameraRotation.x = 0;
			cameraRotation.z = 0;
			cameraRotation.normalize();
			return cameraRotation;
		};
		useCommand(
			"jump",
			(info) => {
				//@ts-ignore
				if (!info.isInitial) return;
				if (characterSystem) characterSystem.jump();
			},
			undefined,
			{ rate: 0.1, keys: [" "] }
		);
		useCommand(
			"move",
			(info) => {
				// get the camera direction
				camera.getWorldQuaternion(cameraRotation);
				const direction = new THREE.Vector3(
					//@ts-ignore
					info.value.x,
					0,
					//@ts-ignore
					info.value.y
				)
					.applyQuaternion(getHorizontalRotation())
					.normalize();

				if (characterSystem) characterSystem.move(direction);
			},
			() => {
				if (characterSystem) characterSystem.move(new THREE.Vector3(0, 0, 0));
			},
			{ asVector: true }
		);
		useCommand(
			"c",
			(info) => {
				//@ts-ignore this does exist?
				if (!info.isInitial) return;
				characterSystem?.setCrouched(true);
			},
			() => {
				characterSystem?.setCrouched(false);
			}
		);

		const contextValue = {
			characterSystem
		};

		// if you change the radius or height, you need to update the capsule
		useEffect(() => {
			//if (characterSystem) characterSystem.setCapsule(radius, height);
		}, [radius, height]);

		return (
			//@ts-ignore
			<CharacterControllerContext.Provider value={contextValue}>
				<object3D ref={objectRef}>{children}</object3D>
			</CharacterControllerContext.Provider>
		);
	})
);
