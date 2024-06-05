// this body changes between shapes but keeps the same rigidBdy

// use memo so it doesn't cycle on inputs
import { RigidBody, useJolt, getShapeSettingsFromGeometry, BodyState } from "@react-three/jolt";
import { memo, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const Changer: React.FC = memo((props) => {
	//hold the refs
	const meshRef = useRef<THREE.Mesh | null>(null);
	const bodyRef = useRef<BodyState>();

	const { jolt } = useJolt();
	// original color: #6200B3
	const [activeColor, setActiveColor] = useState("#188FA7");
	const currentShape = useRef(0);
	//create the geometries
	const geometries = useMemo(() => {
		const geoArray = [];
		// sphere
		const sphereGeo = new THREE.SphereGeometry(1.3, 32, 32);
		const sphereShape = getShapeSettingsFromGeometry(sphereGeo)!.shapeSettings!.Create().Get();
		geoArray.push({ geo: sphereGeo, shape: sphereShape, color: "#188FA7" });

		// box
		const boxGeo = new THREE.BoxGeometry(2, 2, 2);
		const boxShape = getShapeSettingsFromGeometry(boxGeo)!.shapeSettings!.Create().Get();
		geoArray.push({ geo: boxGeo, shape: boxShape, color: "#DC6A07" });

		//pyramid tetrahedron
		const tetraGeo = new THREE.TetrahedronGeometry(2);
		const tetraShape = getShapeSettingsFromGeometry(tetraGeo, "convex")!
			.shapeSettings!.Create()
			.Get();
		geoArray.push({ geo: tetraGeo, shape: tetraShape, color: "#70D6EB" });

		//torus knot
		const torusGeo = new THREE.TorusKnotGeometry(1, 0.4, 64, 8);
		const torusShape = getShapeSettingsFromGeometry(torusGeo)!.shapeSettings!.Create().Get();
		geoArray.push({ geo: torusGeo, shape: torusShape, color: "#72E1D1" });
		return geoArray;
	}, []);

	// function to change things
	const nextShape = () => {
		currentShape.current = (currentShape.current + 1) % geometries.length;
		const { geo, shape, color } = geometries[currentShape.current];
		setActiveColor(color);
		(bodyRef.current as BodyState).shape = shape;
		if (meshRef.current) meshRef.current.geometry = geo;
	};

	return (
		<RigidBody {...props} ref={bodyRef}>
			<mesh ref={meshRef} onClick={() => nextShape()} castShadow receiveShadow>
				<sphereGeometry args={[1.3, 32, 32]} />
				<meshStandardMaterial color={activeColor} />
			</mesh>
		</RigidBody>
	);
});

export default Changer;
