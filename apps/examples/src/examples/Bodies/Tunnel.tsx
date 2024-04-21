// creates a bridge static rigidbody
import { RigidBody } from "@react-three/jolt";

export function Tunnel(props: any) {
	const { position = [0, 0, 0], rotation = [0, 0, 0], color = "#151E3F" } = props;

	return (
		<RigidBody position={position} rotation={rotation} type={"static"}>
			<mesh position={[0, 7, 0]}>
				<boxGeometry args={[7, 1, 30]} />
				<meshStandardMaterial color={color} />
			</mesh>
			<mesh position={[3.5, 3.5, 0]}>
				<boxGeometry args={[1, 7, 30]} />
				<meshStandardMaterial color={color} />
			</mesh>
			<mesh position={[-3.5, 3.5, 0]}>
				<boxGeometry args={[1, 7, 30]} />
				<meshStandardMaterial color={color} />
			</mesh>
		</RigidBody>
	);
}
