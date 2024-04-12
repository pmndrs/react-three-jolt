import { RigidBody, Floor } from '@react-three/jolt';
import { useEffect, useState } from 'react';

enum ShapeType {
  BOX = 'box',
  SPHERE = 'sphere',
  CYLINDER = 'cylinder',
  CONE = 'cone',
  TERTRAHEDRON = 'tetrahedron',
  OCTOHEDRON = 'octahedron',
}

interface Shape {
  position: number[];
  type: ShapeType;
  color: number;
}

const getGeometry = (type: ShapeType) => {
  switch (type) {
    case ShapeType.BOX:
      return <boxGeometry args={[1, 1, 1]} />;
    case ShapeType.SPHERE:
      return <sphereGeometry args={[0.5, 32, 32]} />;
    case ShapeType.CYLINDER:
      return <cylinderGeometry args={[0.5, 0.5, 1, 32]} />;
    case ShapeType.CONE:
      return <coneGeometry args={[0.5, 1, 32]} />;
    case ShapeType.TERTRAHEDRON:
      return <tetrahedronGeometry args={[0.5]} />;
    case ShapeType.OCTOHEDRON:
      return <octahedronGeometry args={[0.5]} />;
  }
};

const ShapeFountain = () => {
  const [shapes, setShapes] = useState<Shape[]>([]);

  const spawnShape = () => {
    setShapes((prev) => [
      ...prev,
      {
        // random position on the xz plane, 5 units above the floor
        position: [Math.random() * 5 - 2, 5, Math.random() * 4 - 2],
        // random shape type
        type: Object.values(ShapeType)[
          Math.floor(Math.random() * Object.values(ShapeType).length)
        ],
        // random hex color
        color: Math.random() * 0xffffff,
      },
    ]);
  };

  // every 200ms spawn a shape, also spawn a shape on click
  useEffect(() => {
    const interval = setInterval(spawnShape, 200);
    window.addEventListener('click', spawnShape);
    return () => {
      clearInterval(interval);
      window.removeEventListener('click', spawnShape);
    };
  }, [spawnShape]);

  return (
    <>
      <Floor />
      {shapes?.map(({ position, type, color }, i) => (
        <RigidBody key={i} position={position} type="trimesh">
          <mesh>
            {getGeometry(type)}
            <meshStandardMaterial color={color} />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
};

export default ShapeFountain;
