import { RigidBody, Heightfield, useConst, useJolt } from '@react-three/jolt';

export function HeightfieldDemo() {
  // contact listeners
  const onContactAdded = (
    body1: number,
    body2: number,
    numListeners?: number,
    context: 'string'
  ) => {
    if (context == 'new')
      console.log(
        Date.now(),
        ': NEW Contact Added',
        body1,
        body2,
        numListeners,
        context
      );
    /*else
            console.log(
                Date.now(),
                ':Contact Added to Existing',
                body1,
                body2,
                numListeners,
                context,
            );
            */
  };

  const onContactRemoved = (
    body1: number,
    body2: number,
    numListeners?: number,
    context: string
  ) => {
    if (context == 'final')
      console.log(
        Date.now(),
        ': FINAL Contact Removed',
        body1,
        body2,
        numListeners,
        context
      );
    /*else
            console.log(
                Date.now(),
                ': Existing Contact Removed',
                body1,
                body2,
                numListeners,
                context,
            );
            */
  };

  // body settings so shapes bounce
  const { bodySystem } = useJolt();
  bodySystem.defaultBodySettings = {
    mRestitution: 0.1,
  };
  const ballPositions = [
    [0, 100, 0],

    [10, 100, 10],
    [20, 97, 20],
    [30, 91, 30],
    [40, 93, 40],
    [50, 88, 50],
    [60, 96, 60],
    [70, 93, 70],

    // negative
    [-70, 91, -70],
    [-60, 99, -60],
    [-50, 94, -50],
    [-40, 87, -40],
    [-30, 92, -30],
    [-20, 100, -20],
    [-10, 96, -10],

    [-10, 100, 10],
    [-20, 93, 20],
    [-30, 88, 30],
    [-40, 92, 40],
    [-50, 94, 50],
    [-60, 96, 60],
    [-70, 98, 70],
    [10, 91, -10],
    [20, 100, -20],
    [30, 100, -30],
    [40, 94, -40],
    [50, 96, -50],
    [60, 97, -60],
    [70, 91, -70],

    // center
    [0, 100, 10],
    [0, 95, 20],
    [0, 90, 30],
    [0, 92, 40],
    [0, 99, 50],
    [0, 91, 60],
    [0, 88, 70],
    //negative
    [0, 100, -70],
    [0, 93, -60],
    [0, 97, -50],
    [0, 92, -40],
    [0, 88, -30],
    [0, 92, -20],
    [0, 100, -10],
  ];
  return (
    <>
      {ballPositions.map((position, index) => (
        <RigidBody
          key={index}
          position={position}
          onContactAdded={onContactAdded}
          onContactRemoved={onContactRemoved}
        >
          <mesh shape={'sphere'}>
            <sphereGeometry args={[1, 32, 32]} />
            <meshStandardMaterial color="#E5D0E3" />
          </mesh>
        </RigidBody>
      ))}
      <Heightfield url="heightmaps/wp1024.png" size={512} />
      {/* <Floor size="150" position={[0, 0, 0]} /> */}
    </>
  );
}
