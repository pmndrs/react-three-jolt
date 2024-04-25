// creates a bridge static rigidbody
import { BodyState, RigidBody } from "@react-three/jolt";
import { useRef, useEffect } from "react";

export function Conveyor(props: any) {
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
	/*
	useEffect(() => {
		if (!rigidBodyRef.current) return;
		const body = rigidBodyRef.current as BodyState;
		body.isConveyor = true;
		body.conveyorVector = target;
	}, [target]);
	*/

	return (
		<RigidBody ref={rigidBodyRef} position={position} rotation={rotation} type={"static"}>
			<mesh {...rest}>
				<boxGeometry args={size} />
				<meshStandardMaterial color={color} />
			</mesh>
		</RigidBody>
	);
}
