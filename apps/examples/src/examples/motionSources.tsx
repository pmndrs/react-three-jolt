import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import {
	BodyState,
	Physics,
	RaycastHit,
	Raycaster,
	RigidBody,
	useConst,
	useJolt,
	useMount,
	useMulticaster,
	useRaycaster,
	useSetInterval,
	useSetTimeout,
	useUnmount
} from "@react-three/jolt";
import { Floor } from "@react-three/jolt-addons";
import { useDemo } from "../App";
import { max } from "three/examples/jsm/nodes/Nodes.js";
// because im lazy
const dtr = (degree: number) => THREE.MathUtils.degToRad(degree);

// we have to wrap the demo so we can provide the physics component

export function MotionSources() {
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
	const debugObject = useRef(new THREE.Object3D());
	const rearConveyor = useRef<BodyState>();
	const leftConveyor = useRef<BodyState>();
	const angledBouncer = useRef<BodyState>();
	const forcefield = useRef<BodyState>();
	const randomBouncer = useRef<BodyState>();
	const teleporter = useRef<BodyState>();
	const susan = useRef<BodyState>();
	const blender = useRef<BodyState>();

	const intervals = useSetInterval();

	const { scene } = useThree();
	const { bodySystem } = useJolt();

	// Helper functions ---------------------
	const getRandomGroup = () => Math.floor(Math.random() * 4);
	const geGroupColor = (group: number) => {
		switch (group) {
			case 0:
				return "#ff4060";
			case 1:
				return "#4060ff";
			case 2:
				return "#20ffa0";
			case 3:
				return "#ffcc00";
		}
	};
	// for bouncer
	const getRandomVector = (max: number) => {
		return new THREE.Vector3(
			Math.random() * max - max / 2,
			Math.abs((Math.random() * max) / 2),
			Math.random() * max - max / 2
		);
	};

	const [activeBodies, setActiveBodies] = useState<number[]>([]);

	// dynamicly create bodies
	useMount(() => {
		const boxInterval = intervals.setInterval(() => {
			const groupId = getRandomGroup();
			const geometry = new THREE.BoxGeometry(1, 1, 1);
			const material = new THREE.MeshStandardMaterial({ color: geGroupColor(groupId) });
			const cube = new THREE.Mesh(geometry, material);
			// add to the scene
			scene.add(cube);
			// set the position
			cube.position.set(0, 10, -15);
			// add to physics

			const bodyId = bodySystem.addBody(cube, { group: groupId, subGroup: 1 });
			const body = bodySystem.getBody(bodyId);
			// set the mass
			body!.mass = 15;
			// disable internal collision for group 2 by setting the subGroup to 0
			if (groupId === 2) body!.subGroup = 0;
			// add to the active bodies
			setActiveBodies((current) => [...current, bodyId]);

			if (activeBodies.length > 100) {
				intervals.clearInterval(boxInterval);
			}
		}, 4000);
	});

	// setup movement sources
	useMount(() => {
		if (!rearConveyor.current || !leftConveyor.current) return;
		// setup the conveyors
		rearConveyor.current.activateMotionSource(new THREE.Vector3(-2.6, 0, 0));
		leftConveyor.current.activateMotionSource(new THREE.Vector3(-2.4, 0, 0));
		// setup the bouncer
		angledBouncer.current!.activateMotionSource(new THREE.Vector3(0, 300, 0));
		// setup the forcefield
		forcefield.current!.activateMotionSource(new THREE.Vector3(3.6, 10, -0.7));
		//disable auto rotation of field vector
		forcefield.current!.useRotation = false;

		// Random Bouncer -----------------------
		randomBouncer.current!.activateMotionSource(new THREE.Vector3(0, 300, 0));
		// change the bouncers vector every 4 seconds
		intervals.setInterval(() => {
			randomBouncer.current!.motionLinearVector = getRandomVector(300);
		}, 4000);

		// Teleporter --------------------------------
		teleporter.current!.activateMotionSource(new THREE.Vector3(-40, 20, -35));
		teleporter.current!.isTeleporter = true;

		// Lazy Susan --------------------------------
		susan.current!.activateMotionSource(
			new THREE.Vector3(0, 0, 0),
			new THREE.Vector3(0, 50, 0)
		);
		susan.current!.motionType = "angular";
		// this makes the susan use surface velocity
		susan.current!.motionAsSurfaceVelocity = true;

		// Blender --------------------------------
		// the blender applies a raw torque to the object
		blender.current!.activateMotionSource(
			new THREE.Vector3(0, 0, 0),
			new THREE.Vector3(0, 50, 0)
		);
		blender.current!.motionType = "angular";
	});

	useUnmount(() => {
		// console.log('Raycast Simple Demo unmounting...');
		scene.remove(debugObject.current);
	});

	return (
		<>
			<RigidBody position={[0, 10, -13]} group={0} mass={15} onlyInitialize>
				<mesh>
					<boxGeometry args={[1, 1, 1]} />
					<meshStandardMaterial color="#ff4060" />
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
			<RigidBody position={[-14, 4, 14]} rotation={[0, dtr(15), 0]} type={"static"}>
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
			<RigidBody position={[24, 12, 2]} rotation={[0, 1.65, 0.3]} type={"static"}>
				<mesh>
					<boxGeometry args={[8, 8, 0.5]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
				<mesh position={[0, -2, -2]}>
					<boxGeometry args={[8, 0.5, 4]} />
					<meshStandardMaterial color="#D8F1A0" transparent opacity={0.5} />
				</mesh>
			</RigidBody>
			{/* Filters */}
			<RigidBody
				position={[22, 7, 6]}
				rotation={[dtr(-15), 0, dtr(-5)]}
				type="static"
				group={0}
				subGroup={0}
			>
				<mesh>
					<boxGeometry args={[5, 0.5, 8]} />
					<meshStandardMaterial color="#ff4060" />
				</mesh>
			</RigidBody>
			<RigidBody
				position={[22, 5, 0]}
				rotation={[dtr(5), 0, dtr(15)]}
				type="static"
				group={1}
				subGroup={2}
			>
				<mesh>
					<boxGeometry args={[8, 0.5, 5]} />
					<meshStandardMaterial color="#4060ff" />
				</mesh>
			</RigidBody>
			<RigidBody
				position={[22, 2.7, -1]}
				rotation={[dtr(5), 0, dtr(-15)]}
				type="static"
				group={2}
				subGroup={0}
			>
				<mesh>
					<boxGeometry args={[8, 0.5, 5]} />
					<meshStandardMaterial color="#20ffa0" />
				</mesh>
			</RigidBody>
			<RigidBody
				position={[22, 1, -1]}
				rotation={[dtr(-35), 0, 0]}
				type="static"
				group={3}
				subGroup={1}
			>
				<mesh>
					<boxGeometry args={[4, 0.5, 4]} />
					<meshStandardMaterial color="#ECE4B7" />
				</mesh>
			</RigidBody>

			{/* Special Bounce */}
			<RigidBody ref={randomBouncer} position={[14, 0, 0]} type={"static"}>
				<mesh>
					<cylinderGeometry args={[5, 5, 1, 32]} />
					<meshStandardMaterial color="#92D5E6" />
				</mesh>
			</RigidBody>
			{/* Teleporter */}
			<RigidBody ref={teleporter} position={[28, 0, -2]} type={"static"}>
				<mesh>
					<cylinderGeometry args={[2, 2, 1, 32]} />
					<meshStandardMaterial color="#F0A202" />
				</mesh>
			</RigidBody>
			<RigidBody
				position={[-40, 21, -35]}
				rotation={[0, 0, dtr(15)]}
				group={3}
				subGroup={0}
				type={"static"}
			>
				<mesh>
					<cylinderGeometry args={[2, 2, 1, 32]} />
					<meshStandardMaterial color="#F0A202" />
				</mesh>
			</RigidBody>
			{/* Lazy Susan */}
			<RigidBody ref={susan} position={[22, 0, 12]} type={"static"}>
				<mesh>
					<cylinderGeometry args={[5, 5, 1, 32]} />
					<meshStandardMaterial color="#FB899E" />
				</mesh>
			</RigidBody>
			{/* Blender */}
			<RigidBody ref={blender} position={[24, 0, -4]} type={"static"}>
				<mesh>
					<cylinderGeometry args={[2, 2, 1, 32]} />
					<meshStandardMaterial color="#83B692" />
				</mesh>
			</RigidBody>

			{/* Yellow container */}
			<RigidBody
				position={[-40, 5, -40]}
				rotation={[dtr(35), 0, 0]}
				type="static"
				group={3}
				subGroup={1}
			>
				<mesh>
					<boxGeometry args={[10, 0.5, 10]} />
					<meshStandardMaterial color="#ECE4B7" transparent opacity={0.3} />
				</mesh>
				<mesh position={[0, 5, -5]}>
					<boxGeometry args={[10, 10, 0.5]} />
					<meshStandardMaterial color="#ECE4B7" transparent opacity={0.3} />
				</mesh>
				<mesh position={[0, 5, 5]}>
					<boxGeometry args={[10, 10, 0.5]} />
					<meshStandardMaterial color="#ECE4B7" transparent opacity={0.3} />
				</mesh>
				<mesh position={[-5, 5, 0]} rotation={[0, 1.57, 0]}>
					<boxGeometry args={[10, 10, 0.5]} />
					<meshStandardMaterial color="#ECE4B7" transparent opacity={0.3} />
				</mesh>
				<mesh position={[5, 5, 0]} rotation={[0, 1.57, 0]}>
					<boxGeometry args={[10, 10, 0.5]} />
					<meshStandardMaterial color="#ECE4B7" transparent opacity={0.3} />
				</mesh>
			</RigidBody>

			<Floor position={[0, 0, 0]} size={100}>
				<meshStandardMaterial color="#fdf0d5" />
			</Floor>
		</>
	);
}
