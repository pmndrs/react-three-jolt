// creates a bridge static rigidbody
import { RigidBody } from "@react-three/jolt";

export function Stairs(props: any) {
	const {
		stairHeight = 0.4,
		height = 7,
		stairWidth = 1,
		position = [0, 0, 0],
		rotation = [0, 0, 0],
		color = "#7A9E9F"
	} = props;
	const count = Math.ceil(height / stairHeight);
	return (
		<RigidBody
			allowObstruction
			obstructionTimelimit={2000}
			position={position}
			rotation={rotation}
			type={"static"}
		>
			{Array.from({ length: count }, (_, i) => (
				<mesh key={i} position={[0, 7 - i * stairHeight, i * stairWidth]}>
					<boxGeometry args={[7, stairHeight, stairWidth]} />
					<meshStandardMaterial color={color} />
				</mesh>
			))}
		</RigidBody>
	);
}
