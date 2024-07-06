// creates a bridge static rigidbody
import { BodyState, RigidBody, Vector3Tuple, vec3 } from "@react-three/jolt";
import { useRef, useEffect } from "react";
import { ThreeElements } from "@react-three/fiber"
import { ColorRepresentation } from "three";

type ConveyorProps = ThreeElements['mesh'] & {
	size?: Vector3Tuple
	position?: Vector3Tuple
	target?: Vector3Tuple
	asSensor?: boolean
	rotation?: Vector3Tuple
	color?: ColorRepresentation
}

export function Conveyor(props: ConveyorProps) {
	const rigidBodyRef = useRef();
	const {
		size = [5, 0.4, 15],
		position = [0, 0, 0],
		target = [0, 0, 3],
		asSensor = false,
		rotation = [0, 0, 0],
		color = "#1EA896",
		...rest
	} = props;

	useEffect(() => {
		if (!rigidBodyRef.current) return;
		const body = rigidBodyRef.current as BodyState;
		body.isConveyor = true;
		body.conveyorVector = vec3.three(target);
	}, [target]);

	return (
		<RigidBody ref={rigidBodyRef} position={position} rotation={rotation} type={"static"}>
			<mesh {...rest}>
				<boxGeometry args={size} />
				<meshStandardMaterial color={color} />
			</mesh>
		</RigidBody>
	);
}
