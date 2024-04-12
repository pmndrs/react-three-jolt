// Base demo copied from r3/rapier
import * as THREE from 'three';
import {
  Box,
  Environment,
  OrbitControls,
  CameraControls,
} from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { Physics, RigidBody, vec3 } from '@react-three/jolt';
import { Perf } from 'r3f-perf';
import {
  ReactNode,
  //StrictMode,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useRef,
  //useEffect,
  useState,
} from 'react';
import {
  NavLink,
  NavLinkProps,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';

//* All the examples ------------------------------
import { RaycastManyDemo } from './examples/RaycastManyDemo';
import { RaycastSimpleDemo } from './examples/RaycastSimpleDemo';
import { JustBoxes } from './examples/JustBoxes';
import { HeightfieldDemo } from './examples/Heightfield';
import { CubeHeap } from './examples/CubeHeap';

//try to import a local module of jolt
import initJolt from './jolt/Distribution/jolt-physics.wasm-compat.js';
const demoContext = createContext<{
  setDebug?(f: boolean): void;
  setPaused?(f: boolean): void;
  setCameraEnabled?(f: boolean): void;
}>({});

export const useDemo = () => useContext(demoContext);

const ToggleButton = ({
  label,
  value,
  onClick,
}: {
  label: string;
  value: boolean;
  onClick(): void;
}) => (
  <button
    style={{
      background: value ? 'red' : 'transparent',
      border: '2px solid red',
      color: value ? 'white' : 'red',
      borderRadius: 4,
    }}
    onClick={onClick}
  >
    {label}
  </button>
);

export interface Demo {
  (props: { children?: ReactNode }): JSX.Element;
}
export function Clear() {
  return (
    <mesh>
      <boxGeometry args={[1, 2, 3]} />
      <meshStandardMaterial color="black" />
    </mesh>
  );
}

//* Controls Wrapper. We have to do this to get root state
export function ControlWrapper(props: any) {
  const { position = [0, 10, 10], target = [0, 1, 0], ...rest } = props;
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
        true
      );
  }, [position]);
  return <CameraControls makeDefault {...rest} />;
}

const routes = {
  '': {
    position: [2, 5, 30],
    target: [0, 1, 10],
    background: '#f0544f',
    element: <RaycastSimpleDemo />,
  },

  RaycastMany: {
    position: [0, 0, 5],
    target: [0, 0, 0],
    background: '#3d405b',
    element: <RaycastManyDemo />,
  },
  Heightfield: {
    position: [150, 110, 150],
    target: [0, 0, 0],
    background: '#3d405b',
    element: <HeightfieldDemo />,
  },
  // just for current dev purposes
  CubeHeap: {
    position: [2, 25, 51],
    target: [0, 1, 10],
    background: '#3d405b',
    element: <CubeHeap />,
  },
  // just for current dev purposes
  Boxes: {
    position: [-10, 5, 15],
    target: [0, 1, 10],
    background: '#3d405b',
    element: <JustBoxes />,
  },
  clear: { position: [5, 15, 5], background: '#81b29a', element: <Clear /> },
};

export const App = () => {
  // state
  const [debug, setDebug] = useState<boolean>(false);
  const [perf, setPerf] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [interpolate, setInterpolate] = useState<boolean>(true);
  const [physicsKey, setPhysicsKey] = useState<number>(0);

  // visuals
  const [background, setBackground] = useState<string>('#3d405b');
  const [cameraProps, setCameraProps] = useState<{
    position: any;
    target: any;
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
    const route = routes[location.pathname.replace('/', '')];
    setCameraProps({ position: route.position, target: route.target });
    setBackground(route.background);
  }, [location]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        fontFamily: 'sans-serif',
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
          />
          <Physics
            module={initJolt}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
          >
            <Routes>
              {Object.keys(routes).map((key) => (
                <Route path={key} key={key} element={routes[key].element} />
              ))}
            </Routes>
          </Physics>
          {perf && <Perf position="top-left" minimal className="perf" />}
        </Canvas>
      </Suspense>

      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: 24,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          maxWidth: 600,
        }}
      >
        {Object.keys(routes).map((key) => (
          <Link key={key} to={key} end>
            {key.replace(/-/g, ' ') || 'Raycaster'}
          </Link>
        ))}

        <ToggleButton
          label="Debug"
          value={debug}
          onClick={() => setDebug((v) => !v)}
        />
        <ToggleButton
          label="Perf"
          value={perf}
          onClick={() => setPerf((v) => !v)}
        />
        <ToggleButton
          label="Paused"
          value={paused}
          onClick={() => setPaused((v) => !v)}
        />
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
        border: '2px solid #311847',
        textTransform: 'capitalize',
        borderRadius: 4,
        padding: 4,
        background: isActive ? '#311847' : 'transparent',
        textDecoration: 'none',
        color: isActive ? 'white' : '#311847',
      })}
    />
  );
};
