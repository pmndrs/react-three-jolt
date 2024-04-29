import { useRef, useState } from "react";
import * as THREE from "three";
import {
	type BodyState,
	Physics,
	RigidBody,
	useJolt,
	useMount,
	useSetInterval
} from "@react-three/jolt";
import { Floor } from "@react-three/jolt-addons";
import { useDemo } from "../App";
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
	const rearConveyor = useRef<BodyState>();
	const leftConveyor = useRef<BodyState>();
	const angledBouncer = useRef<BodyState>();
	const forcefield = useRef<BodyState>();
	const randomBouncer = useRef<BodyState>();
	const teleporter = useRef<BodyState>();
	const susan = useRef<BodyState>();
	const blender = useRef<BodyState>();

	const intervals = useSetInterval();

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

	const [activeBodies, setActiveBodies] = useState<{ groupId: number; color: string }[]>([
		{ groupId: 0, color: "#ff4060" }
	]);

	// dynamicly create bodies. When above 100 move a random body to the origin
	useMount(() => {
		let count = 0;
		intervals.setInterval(() => {
			if (count < 100) {
				const groupId = getRandomGroup();
				const color: string = geGroupColor(groupId) || "#ff4060";
				setActiveBodies((current) => {
					count = current.length + 1;
					return [...current, { groupId, color }];
				});
			} else {
				// get a random body and set it to the initial position
				const randomIndex = Math.floor(Math.random() * count);
				const randomBody: BodyState = Array.from(bodySystem.dynamicBodies.values())[
					randomIndex
				];
				randomBody.position = new THREE.Vector3(0, 10, -15);
				randomBody.rotation = new THREE.Quaternion();
			}
		}, 4000);
	});

	// setup movement sources
	useMount(() => {
		if (!rearConveyor.current || !leftConveyor.current) return;
		// setup the conveyors
		rearConveyor.current.activateMotionSource(new THREE.Vector3(-3, 0, 0));
		rearConveyor.current.motionAsSurfaceVelocity = true;
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

	return (
		<>
			{activeBodies.map((body, index) => (
				<RigidBody
					key={index}
					position={[0, 10, -15]}
					group={body.groupId}
					subGroup={body.groupId === 2 ? 0 : 1}
					mass={15}
					onlyInitialize
				>
					<mesh>
						<boxGeometry args={[1, 1, 1]} />
						<meshStandardMaterial color={body.color} />
					</mesh>
				</RigidBody>
			))}

			<RigidBody
				ref={rearConveyor}
				rotation={[0, 0, dtr(-2)]}
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
				rotation={[dtr(-15), 0, dtr(-2)]}
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