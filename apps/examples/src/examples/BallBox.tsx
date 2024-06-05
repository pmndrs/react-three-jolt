import { BodyState, Physics, RigidBody, Shape, useSetTimeout } from "@react-three/jolt";
import { useDemo } from "../App";
import { useRef, useMemo, useReducer, useEffect, useState, Suspense } from "react";
import * as THREE from "three";
import { CameraControls, Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import InitJolt from "../jolt/Distribution/jolt-physics.wasm-compat";

import { easing } from "maath";

import { JoltBolt } from "./Bodies/joltBolt";
import { BoxContainer } from "./Bodies/BoxContainer";
import Changer from "./Bodies/Changer";
import Scaler from "./Bodies/Scaler";
import { Floor } from "@react-three/jolt-addons";
import { useControls } from "leva";

// for random
const r = THREE.MathUtils.randFloatSpread;
const accents = ["#ff4060", "#ffcc00", "#20ffa0", "#4060ff"];
const shuffle = (accent = 0) => [
	{ color: "#444", roughness: 0.1, metalness: 0.5 },
	{ color: "#444", roughness: 0.1, metalness: 0.5 },
	{ color: "#444", roughness: 0.1, metalness: 0.5 },
	{ color: "white", roughness: 0.1, metalness: 0.1 },
	{ color: "white", roughness: 0.1, metalness: 0.1 },
	{ color: "white", roughness: 0.1, metalness: 0.1 },
	{ color: accents[accent], roughness: 0.1, accent: true },
	{ color: accents[accent], roughness: 0.1, accent: true },
	{ color: accents[accent], roughness: 0.1, accent: true },
	{ color: "#444", roughness: 0.1 },
	{ color: "#444", roughness: 0.3 },
	{ color: "#444", roughness: 0.3 },
	{ color: "white", roughness: 0.1 },
	{ color: "white", roughness: 0.2 },
	{ color: "white", roughness: 0.1 },
	{ color: accents[accent], roughness: 0.1, accent: true, transparent: true, opacity: 0.5 },
	{ color: accents[accent], roughness: 0.3, accent: true },
	{ color: accents[accent], roughness: 0.1, accent: true }
];

export function BallBox() {
	const { debug, paused, interpolate, physicsKey } = useDemo();
	const { boxColor } = useControls({ boxColor: { value: "#38165c", label: "Box Color" } });

	const { gl, controls, camera } = useThree();
	//disable controls
	useEffect(() => {
		if (!controls) return;
		//controls.rotate(0, 0, false);
		setTimeout(() => {
			//controls.enabled = false;
		}, 100);
		return () => {
			controls!.enabled = true;
		};
	}, [controls, camera]);

	const defaultBodySettings = {
		mRestitution: 0.5
	};

	return (
		<>
			<Physics
				module={InitJolt}
				paused={paused}
				key={physicsKey}
				interpolate={interpolate}
				debug={debug}
				gravity={9}
				defaultBodySettings={defaultBodySettings}
			>
				<BoxContainer />
				<RigidBody position={[-1, 8, 0]} onlyInitialize>
					<JoltBolt />
				</RigidBody>
				<Changer />
				<Scaler position={[0.1, 5, 0]} />
				<Changer position={[0.1, 7, 0]} />
				<Scaler position={[0.1, 5, 0]} />
				<Changer />
				<Scaler position={[0.1, 5, 0]} />
				<Changer position={[0.1, 7, 0]} />
				<Scaler position={[0.1, 5, 0]} />
				<Changer />
				<Scaler position={[0.1, 5, 0]} />
				<Changer position={[0.1, 7, 0]} />
				<Scaler position={[0.1, 5, 0]} />
				<Changer />
				<Scaler position={[0.1, 7, 0]} />
				<Changer position={[0.1, 7, 0]} />
				<Scaler position={[0.1, 5, 0]} />
				<Changer />
				<Scaler position={[0.1, 5, 0]} />
				<RigidBody position={[0, -8, 0]} type="static">
					<mesh castShadow receiveShadow>
						<boxGeometry args={[100, 1, 100]} />
						<meshStandardMaterial color={boxColor} />
					</mesh>
				</RigidBody>
				<RigidBody position={[-5, 0, 0]} type="static">
					<mesh castShadow receiveShadow>
						<boxGeometry args={[1, 30, 10]} />
						<meshStandardMaterial color={boxColor} />
					</mesh>
				</RigidBody>
				<RigidBody position={[5, 0, 0]} type="static">
					<mesh castShadow receiveShadow>
						<boxGeometry args={[1, 30, 10]} />
						<meshStandardMaterial color={boxColor} />
					</mesh>
				</RigidBody>
				<RigidBody position={[0, 0, -1]} type="static">
					<mesh castShadow receiveShadow>
						<boxGeometry args={[10, 30, 1]} />
						<meshStandardMaterial color={boxColor} />
					</mesh>
				</RigidBody>
				<RigidBody position={[0, 0, 4]} type="static">
					<Shape size={[10, 30, 1]} />
				</RigidBody>
				{/*<Pointer /> */}
				{/*connectors.map(
					(
						props,
						i //@ts-ignore biome-ignore  Sphere props
					) => (
						<Sphere key={i} {...props} />
					)
				) */}
			</Physics>
			<directionalLight
				position={[-10, 10, 10]}
				shadow-camera-bottom={-10}
				shadow-camera-top={10}
				shadow-camera-left={-10}
				shadow-camera-right={10}
				shadow-mapSize-width={2048}
				shadow-bias={-0.0001}
				intensity={1}
				castShadow
			/>
		</>
	);
}

function Sphere({ accent = false, color = "white", ...props }) {
	const bodyRef = useRef();
	const meshRef = useRef<THREE.Mesh>(null);
	const pos = useMemo(() => [r(10), r(10), r(10)], []);
	useFrame((_state: any, inDelta: number) => {
		if (!bodyRef.current || !meshRef.current) return;
		const delta = Math.min(0.1, inDelta);
		const body = bodyRef.current as BodyState;
		body.addImpulse(body.position.clone().negate().multiplyScalar(0.2));
		//@ts-ignore
		easing.dampC(meshRef.current.material.color, color, 0.2, delta);
	});
	return (
		<RigidBody
			mass={1}
			linearDamping={4}
			angularDamping={1}
			friction={0.1}
			position={pos}
			ref={bodyRef}
		>
			<mesh ref={meshRef} castShadow receiveShadow>
				<sphereGeometry args={[1, 64, 64]} />
				<meshStandardMaterial {...props} />
			</mesh>
		</RigidBody>
	);
}

function Pointer() {
	const bodyRef = useRef(null);
	const { camera } = useThree();
	useFrame(({ pointer, viewport }, deltaTime) => {
		if (!bodyRef.current) return;
		const body = bodyRef.current as BodyState;
		// with this setup 20 is a good distance to the center
		const distance = camera.position.distanceTo(new THREE.Vector3(0, 0, 0));
		const factor = 20 / distance;
		const pointerVector = new THREE.Vector3(
			(pointer.x * viewport.width) / 2 / factor,
			(pointer.y * viewport.height) / 2 / factor,
			1 - distance
		);
		//apply the camera space to the vector
		pointerVector.applyMatrix4(camera.matrixWorld);
		//@ts-ignore move the pointer with kinematic force
		body.moveKinematic(pointerVector, undefined, deltaTime);
	});
	return (
		<RigidBody ref={bodyRef} position={[10, 10, 10]} type={"kinematic"}>
			<mesh visible={false}>
				<sphereGeometry args={[1, 32, 32]} />
				<meshStandardMaterial color="red" />
			</mesh>
		</RigidBody>
	);
}
