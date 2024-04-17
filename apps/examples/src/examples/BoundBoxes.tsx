import {
  useConstraint,
  RigidBody,
  //useSetInterval,
  //Raw,
  //useJolt,
  //BodyState,
} from '@react-three/jolt';
import {
  //useEffect,
  useRef,
} from 'react';
//import * as THREE from 'three';

/*const rotateQuaternion = (
  quaternion: THREE.Quaternion,
  axis: string,
  rotation: number
): THREE.Quaternion => {
  const euler = new THREE.Euler();
  euler.setFromQuaternion(quaternion);

  switch (axis) {
    case 'x':
      euler.x += THREE.MathUtils.degToRad(rotation);
      break;
    case 'y':
      euler.y += THREE.MathUtils.degToRad(rotation);
      break;
    case 'z':
      euler.z += THREE.MathUtils.degToRad(rotation);
      break;
    default:
      console.error('Invalid axis specified');
      break;
  }

  const newQuaternion = new THREE.Quaternion();
  newQuaternion.setFromEuler(euler);

  return newQuaternion;
};
*/

export function BoundBoxes() {
  const body1Ref = useRef(null);
  const body2Ref = useRef(null);
  const body3Ref = useRef(null);
  const body4Ref = useRef(null);
  const body5Ref = useRef(null);
  const body6Ref = useRef(null);
  const body7Ref = useRef(null);
  const body8Ref = useRef(null);
  //  const body9Ref = useRef<RigidBody>(null);
  // const body10Ref = useRef<RigidBody>(null);
  //const { physicsSystem } = useJolt();

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
  // motorized slider constraint to test rotation of parent
  //const sliderRef =
  useConstraint('slider', body7Ref, body8Ref, {
    motor: { target: 6 },
  });

  //const intervals = useSetInterval();

  //let current = 1;
  /*
  useEffect(() => {
    intervals.setInterval(() => {
      //rotate the slider core
      // get the current rotation
      //@ts-ignore
      const baseQuat = body7Ref.current!.rotation;
      const newQuat = rotateQuaternion(baseQuat, 'x', 15);
      //@ts-ignore
      body7Ref.current!.rotation = newQuat;
      console.log('rotating', newQuat);

      //@ts-ignore
      sliderRef.current.SetTargetPosition(current++);
      console.log('setting target position', current);
      //@ts-ignore
      physicsSystem.bodyInterface.ActivateBody(body8Ref.current.body.GetID());
    }, 3000);
  }, []);
  */

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
      <RigidBody
        ref={body7Ref}
        position={[-15, 1, 20]}
        type={'static'}
        mass={1}
      >
        <mesh>
          <sphereGeometry args={[1, 8, 8]} />
          <meshStandardMaterial color="#320A28" />
        </mesh>
      </RigidBody>
      <RigidBody ref={body8Ref} position={[-15, 3, 24]} mass={1}>
        <mesh>
          <boxGeometry args={[1, 1, 2]} />
          <meshStandardMaterial color="#8E443D" />
        </mesh>
      </RigidBody>
    </>
  );
}
