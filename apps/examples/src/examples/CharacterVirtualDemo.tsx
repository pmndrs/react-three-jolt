import { Physics, RigidBody } from "@react-three/jolt";
import { Floor } from "@react-three/jolt-addons";
import { CharacterController, CameraRig } from "@react-three/jolt-controllers";
//helpers for example
import { BoundBoxes } from "./BoundBoxes";
import InitJolt from "../jolt/Distribution/jolt-physics.wasm-compat";
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

	// body settings so shapes bounce
	const defaultBodySettings = {
		mRestitution: 0
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
			<Physics module={InitJolt} gravity={25} defaultBodySettings={defaultBodySettings}>
				<RigidBody position={[0, 0, -10]}>
					<mesh>
						<boxGeometry args={[5, 1, 5]} />
						<meshStandardMaterial color="#92DCE5" />
					</mesh>
				</RigidBody>
				<RigidBody position={[0, 0, 10]}>
					<mesh>
						<boxGeometry args={[5, 1, 5]} />
						<meshStandardMaterial color="#D64933" />
					</mesh>
				</RigidBody>
				<RigidBody position={[-10, 0, 0]}>
					<mesh>
						<boxGeometry args={[5, 1, 5]} />
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
				<CharacterController debug position={[0, 4, 0]}>
					<CameraRig />
				</CharacterController>
				<Floor size={150} position={[0, 0, 0]} />
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
