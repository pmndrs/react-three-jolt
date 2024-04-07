import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Placeholder } from '@react-three/jolt';

const App = () => {
  return (
    <Canvas>
      <Placeholder />

      <OrbitControls />
    </Canvas>
  );
};

export default App;
