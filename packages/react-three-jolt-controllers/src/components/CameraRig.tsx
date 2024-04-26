import { useEffect, forwardRef, useImperativeHandle, useContext } from "react";
import { useCameraRig } from "../hooks";
import type { BodyState } from "@react-three/jolt";
import { useCommand, useLookCommand } from "@react-three/jolt-addons";
//import * as THREE from 'three';
import React from "react";
//import { useJolt } from "@react-three/jolt";

//lets try importing the character context
import { CharacterControllerContext } from "./CharacterController";
//import { useThree } from "@react-three/fiber";
//import { CharacterControllerSystem } from 'src/systems';
interface CameraRigProps {
	anchor?: BodyState;
}

export const CameraRig = forwardRef(function CameraRig(props: CameraRigProps, ref) {
	const { anchor } = props;

	const cameraRig = useCameraRig();
	//const { physicsSystem } = useJolt();
	//const { scene } = useThree();

	// bind the look command for look and zoom
	useLookCommand(
		(lookVector: any) => {
			cameraRig.moveBoom(lookVector);
		},
		(zoomLevel: number) => {
			cameraRig.zoom(zoomLevel);
		}
	);

	// bind the cameraRig to the anchor
	useEffect(() => {
		if (!anchor) return;
		cameraRig.attach(anchor);
		return () => {
			cameraRig.detach();
		};
	}, [anchor]);

	// lets try and see if we are in a character context
	const { characterSystem } = useContext(CharacterControllerContext);

	useEffect(() => {
		if (!characterSystem) return;
		//@ts-ignore
		cameraRig.attach(characterSystem.anchor);
		cameraRig.setActiveCamera("main");
		//cameraRig.controls.shapecaster.initDebugging(scene);
		//cameraRig.controls.shapecaster.drawMarkers = true;
		return () => cameraRig.detach();
	}, [characterSystem]);
	useCommand("z", () => {
		console.log("Zooming out");
		//const cast = cameraRig.controls.castObstructionShape();
	});
	useCommand("c", () => {
		//const collision = cameraRig.controls.doCollisionTest();
	});
	// reset to follow cam
	useCommand("r", () => {
		console.log("Resetting to follow cam");
		cameraRig.controls.setRotation(cameraRig.anchor.rotation.y, true);
	});

	// send the parent the rig in the ref
	useImperativeHandle(ref, () => cameraRig, [cameraRig]);

	return <></>;
});
