import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import {
	BodyState,
	Physics,
	RaycastHit,
	Raycaster,
	RigidBody,
	useMount,
	useMulticaster,
	useRaycaster,
	useSetTimeout,
	useUnmount
} from "@react-three/jolt";
import { Floor } from "@react-three/jolt-addons";
import { useDemo } from "../App";
// because im lazy
const dtr = (degree: number) => THREE.MathUtils.degToRad(degree);

// we have to wrap the demo so we can provide the physics component

export function ImpulseSources() {
	const { debug, paused, interpolate, physicsKey } = useDemo();

	// Reset the restitution
	// body settings so shapes dont bounce
	const defaultBodySettings = {
		mRestitution: 0.1
	};
	return (
		<Physics
			paused={paused}
			key={physicsKey}
			interpolate={interpolate}
			debug={debug}
			gravity={22}
			defaultBodySettings={defaultBodySettings}
		>
			<Inner />
		</Physics>
	);
}

function Inner() {
	const { scene } = useThree();
	const debugObject = useRef(new THREE.Object3D());
	const rearConveyor = useRef<BodyState>();
	const leftConveyor = useRef<BodyState>();
	const angledBouncer = useRef<BodyState>();
	const forcefield = useRef<BodyState>();

	const timeouts = useSetTimeout();

	useMount(() => {
		if (!rearConveyor.current || !leftConveyor.current) return;
		// setup the conveyors
		rearConveyor.current.activateMotionSource(new THREE.Vector3(-2.6, 0, 0));
		leftConveyor.current.activateMotionSource(new THREE.Vector3(-2.4, 0, 0));
		// setup the bouncer
		angledBouncer.current!.activateMotionSource(new THREE.Vector3(0, 300, 0));
		// setup the forcefield
		forcefield.current!.activateMotionSource(new THREE.Vector3(3.6, 10, 0));
		//disable auto rotation of field vector
		forcefield.current!.useRotation = false;
	});

	useUnmount(() => {
		// console.log('Raycast Simple Demo unmounting...');
		scene.remove(debugObject.current);
	});

	return (
		<>
			<RigidBody mass={15} position={[0, 10, -13]}>
				<mesh>
					<boxGeometry args={[1, 1, 1]} />
					<meshStandardMaterial color="#FF5A5F" />
				</mesh>
			</RigidBody>

			<RigidBody
				ref={rearConveyor}
				rotation={[0, 0, dtr(-15)]}
				position={[0, 6, -15]}
				type="static"
			>
				<mesh>
					<boxGeometry args={[20, 1, 5]} />
					<meshStandardMaterial color="#087E8B" />
				</mesh>
			</RigidBody>
			<RigidBody
				ref={leftConveyor}
				rotation={[0, 1.57, dtr(-10)]}
				position={[-14, 4, -10]}
				type="static"
			>
				<mesh>
					<boxGeometry args={[15, 1, 5]} />
					<meshStandardMaterial color="#087E8B" />
				</mesh>
			</RigidBody>
			<RigidBody
				ref={angledBouncer}
				position={[-14, 1.5, 2]}
				rotation={[dtr(45), 0, 0]}
				type="static"
			>
				<mesh>
					<boxGeometry args={[5, 0.2, 5]} />
					<meshStandardMaterial color="#FE5E41" />
				</mesh>
			</RigidBody>
			<RigidBody position={[-14, 4, 14]} type={"static"}>
				<mesh>
					<boxGeometry args={[8, 4, 0.5]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
				<mesh position={[0, -2, -2]}>
					<boxGeometry args={[8, 0.5, 4]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
			</RigidBody>
			<RigidBody
				ref={forcefield}
				position={[0, 6, 8]}
				rotation={[0, dtr(15), dtr(15)]}
				type={"static"}
				isSensor
			>
				<mesh>
					<boxGeometry args={[40, 4, 4]} />
					<meshStandardMaterial color="#00A878" transparent opacity={0.1} />
				</mesh>
			</RigidBody>
			<RigidBody position={[22, 12, 4]} rotation={[0, 1.57, 0.3]} type={"static"}>
				<mesh>
					<boxGeometry args={[8, 8, 0.5]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
				<mesh position={[0, -2, -2]}>
					<boxGeometry args={[8, 0.5, 4]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
			</RigidBody>

			<Floor position={[0, 0, 0]} size={100}>
				<meshStandardMaterial color="#fdf0d5" />
			</Floor>
		</>
	);
}
