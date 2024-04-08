import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Experience } from './Experience';

const App = () => {
  return (
    <Canvas>
      <Experience />

      <OrbitControls />
    </Canvas>
  );
};

export default App;
