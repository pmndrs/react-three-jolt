// creates a bridge static rigidbody
import { RigidBody } from "@react-three/jolt";

export function Arch(props: any) {
	const { position = [0, 0, 0] } = props;

	return (
		<RigidBody position={position} type={"static"} allowObstruction>
			<mesh position={[0, 7, 0]}>
				<boxGeometry args={[7, 1, 3]} />
				<meshStandardMaterial color="#AD6A6C" />
			</mesh>
			<mesh position={[3.5, 3.5, 0]}>
				<boxGeometry args={[1, 7, 3]} />
				<meshStandardMaterial color="#AD6A6C" />
			</mesh>
			<mesh position={[-3.5, 3.5, 0]}>
				<boxGeometry args={[1, 7, 3]} />
				<meshStandardMaterial color="#AD6A6C" />
			</mesh>
		</RigidBody>
	);
}
