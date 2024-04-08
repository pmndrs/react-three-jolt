// Base demo copied from r3/rapier
import { Box, Environment, OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Physics, RigidBody } from '@react-three/jolt';
import { Perf } from 'r3f-perf';
import {
  ReactNode,
  StrictMode,
  Suspense,
  createContext,
  useContext,
  useState,
} from 'react';
import { NavLink, NavLinkProps, Route, Routes } from 'react-router-dom';
import { RaycastSimpleDemo } from './examples/RaycastSimpleDemo';
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

const Floor = () => {
  return (
    <RigidBody type="static">
      <Box
        position={[0, -12.55 - 5, 0]}
        scale={[200, 10, 200]}
        rotation={[0, 0, 0]}
        receiveShadow
      >
        <shadowMaterial opacity={0.2} />
      </Box>
    </RigidBody>
  );
};

const routes: Record<string, ReactNode> = {
  '': <RaycastSimpleDemo />,
  //joints: <Joints />,
  // cubeHeap: <ComponentsExample />,
};

export const App = () => {
  const [debug, setDebug] = useState<boolean>(false);
  const [perf, setPerf] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [interpolate, setInterpolate] = useState<boolean>(true);
  const [physicsKey, setPhysicsKey] = useState<number>(0);
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);

  const updatePhysicsKey = () => {
    setPhysicsKey((current) => current + 1);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'linear-gradient(blue, white)',
        fontFamily: 'sans-serif',
      }}
    >
      <Suspense fallback="Loading...">
        <Canvas shadows dpr={1}>
          <StrictMode>
            <Physics
              paused={paused}
              key={physicsKey}
              interpolate={interpolate}
              debug={debug}
            >
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

              <OrbitControls enabled={cameraEnabled} />

              <demoContext.Provider
                value={{
                  setDebug,
                  setPaused,
                  setCameraEnabled,
                }}
              >
                <Routes>
                  {Object.keys(routes).map((key) => (
                    <Route path={key} key={key} element={routes[key]} />
                  ))}
                </Routes>
              </demoContext.Provider>

              <Floor />

              {perf && <Perf />}
            </Physics>
          </StrictMode>
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
            {key.replace(/-/g, ' ') || 'Plinko'}
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
        border: '2px solid blue',
        textTransform: 'capitalize',
        borderRadius: 4,
        padding: 4,
        background: isActive ? 'blue' : 'transparent',
        textDecoration: 'none',
        color: isActive ? 'white' : 'blue',
      })}
    />
  );
};
