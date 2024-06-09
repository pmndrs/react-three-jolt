import { useFrame } from "@react-three/fiber";
import { Physics, RaycastHit, Raycaster, RigidBody, useRaycaster } from "@react-three/jolt";
import { useCommand } from "@react-three/jolt-addons";
import { useEffect, useRef } from "react";
import * as THREE from "three";

// prop holders
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _axis = new THREE.Vector3();

import { useDemo } from "../App";
import { Environment } from "@react-three/drei";
// we have to wrap the demo so we can provide the physics component
export function RaycastManyDemo() {
	const { debug, paused, interpolate, physicsKey } = useDemo();

	return (
		<Physics
			paused={paused}
			key={physicsKey}
			interpolate={interpolate}
			debug={debug}
			gravity={0}
		>
			<RaycastMany />
		</Physics>
	);
}

function RaycastMany({ count = 150, color = "#F4F1DE" }) {
	const instancedMarkersRef = useRef<THREE.InstancedMesh>(null);
	const linesRef = useRef<THREE.LineSegments>(null);
	const maxCount = 3000;
	//todo: change this with leva later
	const rayDistance = 5;

	const torusRef = useRef(null);
	const origin = new THREE.Vector3(10, 10, 10);
	const direction = new THREE.Vector3(-10, -10, -10);
	const raycaster: Raycaster = useRaycaster(origin, direction);

	let isDebugging = false;
	// use key listener to trigger the update for debugging
	useCommand("r", () => {
		console.log("firing update");
		updateMarkers();
	});
	useCommand("d", () => {
		isDebugging = !isDebugging;
		console.log("debugging", isDebugging);
	});

	// Set the initial positions and data
	useEffect(() => {
		// set the count to 0 and adjust usage
		instancedMarkersRef.current!.count = 0;
		instancedMarkersRef.current!.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

		// set the positions attribute on the lines geometry
		linesRef.current!.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(new Float32Array(maxCount * 3 * 2), 3)
		);

		const position = new THREE.Vector3();
		const quaternion = new THREE.Quaternion();
		const scale = new THREE.Vector3(1, 1, 1);
		const matrix = new THREE.Matrix4();

		//set the initial positions of the markers
		for (let i = 0; i < maxCount * 2; i++) {
			position.randomDirection().multiplyScalar(rayDistance);
			matrix.compose(position, quaternion, scale);
			instancedMarkersRef.current!.setMatrixAt(i, matrix);
		}
	}, []);

	const updateMarkers = () => {
		// bail if the items aren't here yet
		if (
			!instancedMarkersRef.current ||
			!linesRef.current ||
			!linesRef.current.geometry.attributes.position
		)
			return;
		let lineNum = 0;
		for (let i = 0; i < count; i++) {
			// get the current ray origin
			// we do *2 because the second will be the hit marker
			instancedMarkersRef.current!.getMatrixAt(i * 2, _matrix);
			_matrix.decompose(_position, _quaternion, _scale);

			// rotate around the origin
			const offset = 1e-4 * window.performance.now();
			_axis
				.set(
					Math.sin(i * 100 + offset),
					Math.cos(-i * 10 + offset),
					Math.sin(i * 1 + offset)
				)
				//not sure if the jolt ray needs this normalized
				.normalize();
			_position.applyAxisAngle(_axis, 0.001);

			// update the position
			_scale.setScalar(0.02);
			_matrix.compose(_position, _quaternion, _scale);
			instancedMarkersRef.current!.setMatrixAt(i * 2, _matrix);

			//* Raycasting ========================================
			// set the origin and direction of the ray
			raycaster.origin = _position.clone();
			raycaster.direction = _position.clone().multiplyScalar(-1);
			// .normalize();
			raycaster.cast(
				(hit: RaycastHit) => {
					//if this is single it wont be an array
					const point = hit.position;
					_scale.setScalar(0.01);
					_matrix.compose(point, _quaternion, _scale);
					// set the hit markers
					instancedMarkersRef.current!.setMatrixAt(i * 2 + 1, _matrix);

					// set the line positions
					linesRef.current!.geometry.attributes.position.setXYZ(
						lineNum++,
						_position.x,
						_position.y,
						_position.z
					);
					linesRef.current!.geometry.attributes.position.setXYZ(
						lineNum++,
						point.x,
						point.y,
						point.z
					);
				},
				() => {
					// no hits
					//hide the marker
					_scale.setScalar(0);
					_matrix.compose(_position, _quaternion, _scale);
					instancedMarkersRef.current!.setMatrixAt(i * 2 + 1, _matrix);

					// do the same lines
					//todo this is kinda messy to do twice
					linesRef.current!.geometry.attributes.position.setXYZ(
						lineNum++,
						_position.x,
						_position.y,
						_position.z
					);
					linesRef.current!.geometry.attributes.position.setXYZ(lineNum++, 0, 0, 0);
				}
			); //raycast
		} // for loop

		// set count and update
		instancedMarkersRef.current!.count = count * 2;
		instancedMarkersRef.current!.instanceMatrix.needsUpdate = true;

		// set line drawrange and update
		linesRef.current!.geometry.setDrawRange(0, lineNum);
		linesRef.current!.geometry.attributes.position.needsUpdate = true;
	};

	// frame loop
	useFrame(() => {
		if (!isDebugging) updateMarkers();
	});

	return (
		<>
			<RigidBody
				ref={torusRef}
				type="static"
				position={[0, 0, 0]}
				rotation={[0, 0, 0]}
				shape="trimesh"
			>
				<mesh>
					<torusKnotGeometry args={[1, 0.4, 100, 16]} />
					<meshStandardMaterial color="#e07a5f" />
				</mesh>
			</RigidBody>
			<lineSegments ref={linesRef}>
				<bufferGeometry />
				<lineBasicMaterial color={color} transparent opacity={0.25} depthWrite={false} />
			</lineSegments>
			<instancedMesh ref={instancedMarkersRef} args={[undefined, undefined, 2 * maxCount]}>
				<sphereGeometry />
				<meshBasicMaterial color={color} />
			</instancedMesh>
			<directionalLight
				castShadow
				position={[10, 10, 10]}
				shadow-camera-bottom={-40}
				shadow-camera-top={40}
				shadow-camera-left={-40}
				shadow-camera-right={40}
				shadow-mapSize-width={1024}
				shadow-bias={-0.0001}
			/>
			<Environment preset="apartment" />
		</>
	);
}

/*<RigidBody
            ref={torusRef}
            type="kinematic"
            debug
            position={[0, 0, 0]}
            rotation={[0, 0, 0]}
            shape="trimesh">
            <mesh>
                <torusKnotGeometry args={[1, 0.4, 100, 16]} />
                <meshStandardMaterial color="#F2CC8F" />
            </mesh>
        </RigidBody>
*/

/*    const drawRay = (origin: THREE.Vector3, direction: THREE.Vector3) => {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            origin,
            direction
        ]);
        const material = new THREE.LineBasicMaterial({ color: 0xff0000 });
        const line = new THREE.Line(geometry, material);
        line.name = 'ray';
        return line;
    };
    */
