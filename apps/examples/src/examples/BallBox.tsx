import { Physics, RigidBody } from "@react-three/jolt";
import { useDemo } from "../App";
import { useMemo, useEffect, useState, Fragment } from "react";
//import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import InitJolt from "../jolt/Distribution/jolt-physics.wasm-compat";

import { JoltBolt } from "./Bodies/joltBolt";
import { BoxContainer } from "./Bodies/BoxContainer";
import Changer from "./Bodies/Changer";
import Scaler from "./Bodies/Scaler";

// fix typescript to know about permissions
declare global {
	interface Window {
		DeviceMotionEvent: {
			prototype: DeviceMotionEvent;
			new (type: string, eventInitDict?: DeviceMotionEventInit): DeviceMotionEvent;
			requestPermission?: () => Promise<PermissionState>;
		};
	}
}
export function BallBox() {
	const { debug, paused, interpolate, physicsKey } = useDemo();
	const { controls, camera } = useThree();
	//disable controls
	useEffect(() => {
		if (!controls) return;
		//@ts-ignore
		controls.rotate(0, 0, false);
		setTimeout(() => {
			//@ts-ignore
			controls.enabled = false;
		}, 100);
		return () => {
			//@ts-ignore
			controls!.enabled = true;
		};
	}, [controls, camera]);

	const defaultBodySettings = {
		mRestitution: 0.5
	};

	const positions = useMemo(() => {
		const allPos = [];

		for (let i = 0; i < 15; i++) {
			allPos.push([Math.random() * 20 - 10, Math.random() * 10, 0]);
		}
		return allPos;
	}, []);

	const [gravity, setGravity] = useState([0, -9.8, 0]);

	const updateGravityOnMouse = (e: MouseEvent) => {
		// if the right click isn't pressed, don't update the gravity
		if (!e.buttons || e.buttons !== 2) return;

		const x = (e.clientX / window.innerWidth) * 20 - 10;
		const y = (e.clientY / window.innerHeight) * 20 - 10;
		setGravity([x, -y, 0]);
	};
	// attach event listener to mouse move with removal on return
	useEffect(() => {
		window.addEventListener("mousemove", updateGravityOnMouse);
		function preventDefault(e: MouseEvent) {
			e.preventDefault();
		}
		window.addEventListener("contextmenu", preventDefault);
		return () => {
			window.removeEventListener("mousemove", updateGravityOnMouse);
			window.removeEventListener("contextmenu", preventDefault);
		};
	}, []);

	// detect device orientation and set gravity
	const updateGravityOnDevice = (e: DeviceMotionEvent) => {
		if (!e.accelerationIncludingGravity || e.accelerationIncludingGravity.x === null) return;
		const { x, y, z } = e.accelerationIncludingGravity!;
		console.log("setting from device", e);
		setGravity([x || 0, y || 0, z || 0]);
	};

	// attach event listener to device orientation with removal on return
	useEffect(() => {
		//@ts-ignore
		if (typeof DeviceMotionEvent.requestPermission === "function") {
			//@ts-ignore
			DeviceMotionEvent.requestPermission()
				.then((permissionState: PermissionState) => {
					if (permissionState === "granted") {
						window.addEventListener("devicemotion", updateGravityOnDevice);
					}
				})
				.catch(console.error);
		} else {
			// handle regular non iOS 13+ devices
			window.addEventListener("devicemotion", updateGravityOnDevice);
		}

		return () => {
			window.removeEventListener("devicemotion", updateGravityOnDevice);
		};
	}, []);

	return (
		<>
			<Physics
				module={InitJolt}
				paused={paused}
				key={physicsKey}
				interpolate={interpolate}
				debug={debug}
				gravity={gravity}
				defaultBodySettings={defaultBodySettings}
			>
				<BoxContainer />

				<RigidBody
					scale={[0.03, 0.03, 0.03]}
					rotation={[3.14, 0, 0]}
					position={[-1, 3, 1]}
					onlyInitialize
				>
					<JoltBolt />
				</RigidBody>

				{positions.map((pos) => (
					<Fragment key={pos.toString()}>
						<Scaler position={pos} />
						<Changer
							position={[pos[0] - Math.random(), pos[1] + Math.random(), pos[2]]}
						/>
					</Fragment>
				))}
			</Physics>
			<ambientLight intensity={0.5} />
			<directionalLight
				position={[-29, 5, 20]}
				shadow-camera-bottom={-16}
				shadow-camera-top={16}
				shadow-camera-left={-16}
				shadow-camera-right={16}
				shadow-camera-near={0.1}
				shadow-camera-far={70}
				shadow-mapSize-width={1024}
				shadow-bias={0.001}
				shadow-normalBias={0.03}
				intensity={3}
				castShadow
			/>
		</>
	);
}
