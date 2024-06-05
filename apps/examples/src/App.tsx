// Base demo copied from r3/rapier
//import * as THREE from 'three';
import { Environment, CameraControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { vec3 } from "@react-three/jolt";
import { Perf } from "r3f-perf";
import {
	//ReactNode,
	//StrictMode,
	Suspense,
	createContext,
	useContext,
	useEffect,
	//useRef,
	//useEffect,
	useState
} from "react";
import { NavLink, NavLinkProps, Route, Routes, useLocation } from "react-router-dom";

//* All the examples ------------------------------
import { RaycastManyDemo } from "./examples/RaycastManyDemo";
import { RaycastSimpleDemo } from "./examples/RaycastSimpleDemo";
import { JustBoxes } from "./examples/JustBoxes";
import { HeightfieldDemo } from "./examples/Heightfield";
import { CubeHeap } from "./examples/CubeHeap";
import { FourWheelDemo } from "./examples/FourWheelsWithHeightmap";
import { CharacterVirtualDemo } from "./examples/CharacterVirtualDemo";
import { Impulses } from "./examples/Impulses";
import { MotionSources } from "./examples/motionSources";
import { BallBox } from "./examples/BallBox";
const demoContext = createContext<{
	debug: boolean;
	paused: boolean;
	interpolate: boolean;
	physicsKey: number;
}>({ debug: false, paused: false, interpolate: true, physicsKey: 0 });

export const useDemo = () => useContext(demoContext);

const ToggleButton = ({
	label,
	value,
	onClick
}: {
	label: string;
	value: boolean;
	onClick(): void;
}) => (
	<button
		style={{
			background: value ? "red" : "transparent",
			border: "2px solid red",
			color: value ? "white" : "red",
			borderRadius: 4
		}}
		onClick={onClick}
	>
		{label}
	</button>
);

//* Controls Wrapper. We have to do this to get root state
export function ControlWrapper(props: any) {
	const { position = [0, 10, 10], target = [0, 1, 0], transition = true, ...rest } = props;
	const { controls } = useThree();
	useEffect(() => {
		const newPosition = vec3.three(position);
		const newTarget = vec3.three(target);
		if (controls)
			//@ts-ignore can't get the types to work here
			controls.setLookAt(
				newPosition.x,
				newPosition.y,
				newPosition.z,
				newTarget.x,
				newTarget.y,
				newTarget.z,
				transition
			);
	}, [position]);
	return <CameraControls makeDefault {...rest} />;
}
type Routes = {
	[key: string]: {
		position?: number[];
		target?: number[];
		transition?: boolean;
		background?: string;
		element: JSX.Element;
		label?: string;
	};
};

const routes: Routes = {
	"": {
		position: [2, 5, 30],
		target: [0, 1, 10],
		background: "#f0544f",
		element: <RaycastSimpleDemo />
	},

	RaycastMany: {
		position: [0, 0, 5],
		target: [0, 0, 0],
		background: "#3d405b",
		element: <RaycastManyDemo />
	},
	Heightfield: {
		position: [150, 110, 150],
		target: [0, 0, 0],
		background: "#3d405b",
		element: <HeightfieldDemo />
	},
	CubeHeap: {
		position: [2, 25, 51],
		target: [0, 1, 10],
		background: "#3d405b",
		element: <CubeHeap />
	},
	Vehicle: {
		position: [2, 25, 51],
		target: [0, 1, 10],
		background: "#3d405b",
		element: <FourWheelDemo />
	},
	Character: {
		position: [2, 25, 51],
		target: [0, 1, 10],
		background: "#3d405b",
		element: <CharacterVirtualDemo />
	},
	// just for current dev purposes
	Boxes: {
		position: [-10, 5, 15],
		target: [0, 1, 10],
		background: "#3d405b",
		element: <JustBoxes />
	},
	Impulses: {
		position: [0, 0, 20],
		target: [0, 0, 0],
		background: "#141622",
		element: <Impulses />
	},
	MotionSources: {
		label: "Motion Sources",
		position: [0, 25, 15],
		target: [0, 1, -15],
		background: "#C1839F",
		element: <MotionSources />
	},
	BallBoxes: {
		position: [0, 0, 20],
		target: [0, 0, 0],
		transition: false,
		background: "#141622",
		element: <BallBox />
	}
};

export const App = () => {
	// state
	const [debug, setDebug] = useState<boolean>(false);
	const [perf, setPerf] = useState<boolean>(false);
	const [paused, setPaused] = useState<boolean>(false);
	const [interpolate, setInterpolate] = useState<boolean>(true);
	const [physicsKey, setPhysicsKey] = useState<number>(0);

	// visuals
	const [background, setBackground] = useState<string>("#3d405b");
	const [cameraProps, setCameraProps] = useState<{
		position: any;
		target: any;
		transition: boolean;
	} | null>(null);
	const location = useLocation();

	// this triggers a reset of the physics world
	const updatePhysicsKey = () => {
		setPhysicsKey((current) => current + 1);
	};

	// when the route changes move the camera
	useEffect(() => {
		// set the camera position
		//@ts-ignore
		const route = routes[location.pathname.replace("/", "")];
		setCameraProps({
			position: route.position,
			target: route.target,
			transition: route.transition
		});
		setBackground(route.background || "#3d405b");
	}, [location]);

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				fontFamily: "sans-serif"
			}}
		>
			<Suspense fallback="Loading...">
				<Canvas
					shadows
					dpr={1}
					camera={{ near: 1, fov: 45, position: cameraProps?.position }}
				>
					<color attach="background" args={[background]} />
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

					<ControlWrapper
						position={cameraProps?.position}
						target={cameraProps?.target}
						transition={cameraProps?.transition}
					/>
					<demoContext.Provider value={{ debug, paused, interpolate, physicsKey }}>
						<Routes>
							{Object.keys(routes).map((key) => (
								<Route path={key} key={key} element={routes[key].element} />
							))}
						</Routes>
					</demoContext.Provider>
					{perf && <Perf position="top-left" minimal className="perf" />}
				</Canvas>
			</Suspense>

			<div
				style={{
					position: "absolute",
					bottom: 24,
					left: 24,
					display: "flex",
					flexWrap: "wrap",
					gap: 12,
					maxWidth: 600
				}}
			>
				{Object.keys(routes).map((key) => (
					<Link key={key} to={key} end>
						{routes[key].label || key.replace(/-/g, " ") || "Raycaster"}
					</Link>
				))}

				<ToggleButton label="Debug" value={debug} onClick={() => setDebug((v) => !v)} />
				<ToggleButton label="Perf" value={perf} onClick={() => setPerf((v) => !v)} />
				<ToggleButton label="Paused" value={paused} onClick={() => setPaused((v) => !v)} />
				<ToggleButton
					label="Interpolate"
					value={interpolate}
					onClick={() => setInterpolate((v) => !v)}
				/>
				<ToggleButton label="Reset" value={false} onClick={updatePhysicsKey} />
			</div>
		</div>
	);
};

const Link = (props: NavLinkProps) => {
	return (
		<NavLink
			{...props}
			style={({ isActive }) => ({
				border: "2px solid #311847",
				textTransform: "capitalize",
				borderRadius: 4,
				padding: 4,
				background: isActive ? "#311847" : "transparent",
				textDecoration: "none",
				color: isActive ? "white" : "#311847"
			})}
		/>
	);
};
