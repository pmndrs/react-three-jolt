import { Physics, RigidBody } from "@react-three/jolt";
import { Floor } from "@react-three/jolt-addons";
import { CharacterController, CameraRig } from "@react-three/jolt-controllers";
//helpers for example
import { BoundBoxes } from "./BoundBoxes";
//import InitJolt from "../jolt/Distribution/jolt-physics.wasm-compat";
import { Arch } from "./Bodies/Arch";
import { Tunnel } from "./Bodies/Tunnel";
import { Teleport } from "./Bodies/Teleport";
import { Conveyor } from "./Bodies/Conveyor";
import { Stairs } from "./Bodies/Stairs";
import { useThree } from "@react-three/fiber";
/*
import {
    useCommand,
    useCommandState,
    useGamepadForCameraControls
} from '@react-three/jolt';
*/

export function CharacterVirtualDemo() {
	//const options = useConst({ inverted: { y: true } });
	//useGamepadForCameraControls('look', controls, options);
	const { gl } = useThree();
	// body settings so shapes bounce
	const defaultBodySettings = {
		mRestitution: 0
	};
	const pointerLock = () => {
		console.log("trying to lock");
		const element = gl.domElement;
		element.requestPointerLock();
	};

	return (
		<>
			<directionalLight
				castShadow
				position={[1, 2, 3]}
				intensity={4.5}
				shadow-normalBias={0.04}
			/>
			<ambientLight intensity={1.5} />
			<Physics gravity={25} defaultBodySettings={defaultBodySettings}>
				<Arch position={[0, 0, -15]} />
				<Arch position={[0, -2, -20]} />
				<Arch position={[0, -3, -25]} />
				<Arch position={[0, -4, -30]} />

				<Conveyor position={[-10, 0, -25]} />

				<Conveyor position={[-20, 0, -25]} target={[0, 15, 0]} color={"#3685B5"} />

				<Teleport position={[5, 0, -10]} />

				<Tunnel position={[-25, 0, 25]} rotation={[0, -0.5, 0]} />
				<Stairs position={[-30, 0, 25]} rotation={[0, 4, 0]} />

				<RigidBody position={[0, 0, 10]}>
					<mesh onClick={() => pointerLock()}>
						<boxGeometry args={[5, 1, 5]} />
						<meshStandardMaterial color="#D64933" />
					</mesh>
				</RigidBody>

				<RigidBody position={[-10, 1, 0]}>
					<mesh>
						<boxGeometry args={[5, 0.4, 5]} />
						<meshStandardMaterial color="#8B80F9" />
					</mesh>
				</RigidBody>

				<RigidBody position={[30, 10, 30]}>
					<mesh>
						<boxGeometry args={[20, 4, 24]} />
						<meshStandardMaterial color="#183A37" />
					</mesh>
				</RigidBody>
				<RigidBody position={[7, 7, 7]}>
					<mesh>
						<cylinderGeometry args={[1, 1, 2, 32]} />
						<meshStandardMaterial color="#7E52A0" />
					</mesh>
				</RigidBody>

				<RigidBody position={[10, 2, 10]}>
					<mesh shape={"box"}>
						<boxGeometry args={[4, 4, 1]} />
						<meshStandardMaterial color="hotpink" />
					</mesh>
				</RigidBody>

				<BoundBoxes />
				<CharacterController debug position={[0, 0, 0]}>
					<CameraRig />
				</CharacterController>
				<Floor size={150} position={[0, -0.5, 0]} />
			</Physics>
		</>
	);
}
/*

                <RigidBody position={[0, 100, 3]}>
                    <mesh shape={'sphere'}>
                        <sphereGeometry args={[1, 32, 32]} />
                        <meshStandardMaterial color="hotpink" />
                    </mesh>
                </RigidBody>
                */
