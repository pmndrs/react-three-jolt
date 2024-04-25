// creates a bridge static rigidbody
import { BodyState, RigidBody } from "@react-three/jolt";
import { useRef, useEffect } from "react";

export function Teleport(props: any) {
	const rigidBodyRef = useRef();
	const {
		size = [5, 0.4, 5],
		position = [0, 0, 0],
		target = [5, 5, 5],
		asSensor = false,
		rotation = [0, 0, 0],
		color = "#151E3F",
		...rest
	} = props;

	useEffect(() => {
		if (!rigidBodyRef.current) return;
		const body = rigidBodyRef.current as BodyState;
		body.isTeleporter = true;
		body.teleporterVector = target;
	}, [target]);

	return (
		<RigidBody
			ref={rigidBodyRef}
			isSensor={asSensor}
			position={position}
			rotation={rotation}
			type={"static"}
		>
			<mesh {...rest}>
				<boxGeometry args={size} />
				<meshStandardMaterial color={color} />
			</mesh>
		</RigidBody>
	);
}
