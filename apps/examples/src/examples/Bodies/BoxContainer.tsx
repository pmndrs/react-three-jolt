import { useThree } from "@react-three/fiber";
import { useEffect } from "react";

export function BoxContainer() {
	// we need to get window data
	const { viewport } = useThree();

	useEffect(() => {
		console.log(viewport);
	}, [viewport]);

	return null;
}
