import { useThree, Vector3 } from "@react-three/fiber";
import { RigidBody, Shape } from "@react-three/jolt";

export function BoxContainer(props: any) {
	// we need to get window data
	const { viewport } = useThree();
	const boxColor = "#38165c";

	return (
		<group {...props}>
			<Wall
				scale={[viewport.width, 1, 7]}
				color={boxColor}
				position={[0, viewport.height / 2 - 1, 2]}
			/>
			<Wall
				scale={[viewport.width, 1, 5]}
				color={boxColor}
				position={[0, -viewport.height / 2 + 1, 0]}
			/>

			<Wall
				scale={[1, viewport.height, 5]}
				color={boxColor}
				position={[-viewport.width / 2 + 1, 0, 0]}
			/>
			<Wall
				scale={[1, viewport.height, 5]}
				color={boxColor}
				position={[viewport.width / 2 - 1, 0, 0]}
			/>

			<Wall
				scale={[viewport.width + 1, viewport.height + 0.01, 1]}
				color={boxColor}
				position={[0, 0, -1]}
				cast={false}
			/>
			{props.children}
			<RigidBody
				scale={[viewport.width, viewport.height, 1]}
				position={[0, 0, 4]}
				type="static"
			>
				<Shape size={[1, 1, 1]} />
			</RigidBody>
		</group>
	);
}

function Wall({
	cast = true,
	receive = true,
	position = [0, 0, 0],
	color = "#114929",
	scale = [1, 1, 1]
}: {
	cast?: boolean;
	receive?: boolean;
	position?: Vector3
	color?: string;
	scale?: Vector3;

}) {
	return (
		<RigidBody position={position} scale={scale} type="static">
			<mesh castShadow={cast} receiveShadow={receive}>
				<boxGeometry args={[1, 1, 1]} />
				<meshStandardMaterial color={color} />
			</mesh>
		</RigidBody>
	);
}
