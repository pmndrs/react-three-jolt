import { useConstraint, RigidBody } from '@react-three/jolt';
import { useRef } from 'react';

export function BoundBoxes() {
  const body1Ref = useRef(null);
  const body2Ref = useRef(null);
  const body3Ref = useRef(null);
  const body4Ref = useRef(null);
  const body5Ref = useRef(null);
  const body6Ref = useRef(null);
  //const body7Ref = useRef<RigidBody>(null);
  // const body8Ref = useRef<RigidBody>(null);
  //  const body9Ref = useRef<RigidBody>(null);
  // const body10Ref = useRef<RigidBody>(null);

  useConstraint('slider', body1Ref, body2Ref, {
    min: 6,
    max: 15,
  });
  useConstraint('distance', body3Ref, body4Ref, {
    min: 10,
    max: 30,
  });
  // distance constraint test for the rigging system
  useConstraint('distance', body6Ref, body5Ref, {
    min: 0,
    max: 2,
  });

  return (
    <>
      <RigidBody ref={body1Ref} position={[10, 15, 0]} mass={1}>
        <mesh>
          <boxGeometry args={[4, 4, 4]} />
          <meshStandardMaterial color="#7F055F" />
        </mesh>
      </RigidBody>
      <RigidBody position={[12, 5, 5]} ref={body2Ref} mass={2}>
        <mesh>
          <sphereGeometry args={[4, 32, 32]} />
          <meshStandardMaterial color="#FF9505" />
        </mesh>
      </RigidBody>
      <RigidBody ref={body3Ref} position={[15, 2, 10]} mass={1}>
        <mesh>
          <boxGeometry args={[4, 4, 4]} />
          <meshStandardMaterial color="#EC4E20" />
        </mesh>
      </RigidBody>
      <RigidBody ref={body4Ref} position={[15, 2, 15]} mass={1}>
        <mesh>
          <boxGeometry args={[4, 4, 4]} />
          <meshStandardMaterial color="#45F0DF" />
        </mesh>
      </RigidBody>
      <RigidBody ref={body5Ref} type={'rig'} position={[15, 2, 20]} mass={1}>
        <mesh>
          <sphereGeometry args={[4, 8, 8]} />
          <meshStandardMaterial wireframe color="#ff521b" />
        </mesh>
      </RigidBody>
      <RigidBody ref={body6Ref} position={[15, 2, 20]} mass={1}>
        <mesh>
          <sphereGeometry args={[1, 8, 8]} />
          <meshStandardMaterial color="#69DDFF" />
        </mesh>
      </RigidBody>
    </>
  );
}
