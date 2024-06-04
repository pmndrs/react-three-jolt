import { BodyState, Physics, RigidBody, Shape, useSetTimeout } from "@react-three/jolt";
import { useDemo } from "../App";
import { useRef, useMemo, useReducer, useEffect, useState } from "react";
import * as THREE from "three";
import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import InitJolt from "../jolt/Distribution/jolt-physics.wasm-compat";

import { easing } from "maath";

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
	const [accent, click] = useReducer((state) => ++state % accents.length, 0);
	const connectors = useMemo(() => shuffle(accent), [accent]);
	const { gl } = useThree();
	// setup onclick from outside the canvas
	useEffect(() => {
		gl.domElement.addEventListener("click", click);
		return () => gl.domElement.removeEventListener("click", click);
	}, [gl]);
	const defaultBodySettings = {
		mRestitution: 0.1
	};
	const [outScale, setOutScale] = useState([5, 5, 5]);
	const [position, setPosition] = useState([0, 0, 0]);

	const timeout = useSetTimeout();
	useEffect(() => {
		timeout.setTimeout(() => {
			setOutScale([7, 7, 7]);
			console.log("scale updated");
		}, 6000);
	}, [timeout]);

	return (
		<>
			<Physics
				module={InitJolt}
				paused={paused}
				key={physicsKey}
				interpolate={interpolate}
				debug={debug}
				gravity={0}
				defaultBodySettings={defaultBodySettings}
			>
				<RigidBody scale={outScale}>
					<pointLight intensity={10} />
					<Shape>
						<Shape type="sphere" position={[-1, 0, 0]} />
						<Shape type="sphere" position={[1, 0, 0]} />
					</Shape>
				</RigidBody>
				<RigidBody scale={outScale} position={[-2, 0, 0]}>
					<mesh>
						<sphereGeometry args={[1, 32, 32]} />
					</mesh>
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

			<Environment resolution={256}>
				<group rotation={[-Math.PI / 3, 0, 1]}>
					<Lightformer
						form="circle"
						intensity={100}
						rotation-x={Math.PI / 2}
						position={[0, 5, -9]}
						scale={2}
					/>
					<Lightformer
						form="circle"
						intensity={2}
						rotation-y={Math.PI / 2}
						position={[-5, 1, -1]}
						scale={2}
					/>
					<Lightformer
						form="circle"
						intensity={2}
						rotation-y={Math.PI / 2}
						position={[-5, -1, -1]}
						scale={2}
					/>
					<Lightformer
						form="circle"
						intensity={2}
						rotation-y={-Math.PI / 2}
						position={[10, 1, 0]}
						scale={8}
					/>
					<Lightformer
						form="ring"
						color="#4060ff"
						intensity={80}
						onUpdate={(self) => self.lookAt(0, 0, 0)}
						position={[10, 10, 0]}
						scale={10}
					/>
				</group>
			</Environment>
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
