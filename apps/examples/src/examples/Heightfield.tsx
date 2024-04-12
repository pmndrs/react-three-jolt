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
    mRestitution: 0,
  };
  const ballPositions = [
    [0, 100, 0],

    [10, 100, 10],
    [20, 100, 20],
    [30, 100, 30],
    [40, 100, 40],
    [50, 100, 50],
    [60, 100, 60],
    [70, 100, 70],

    // negative
    [-70, 100, -70],
    [-60, 100, -60],
    [-50, 100, -50],
    [-40, 100, -40],
    [-30, 100, -30],
    [-20, 100, -20],
    [-10, 100, -10],

    [-10, 100, 10],
    [-20, 100, 20],
    [-30, 100, 30],
    [-40, 100, 40],
    [-50, 100, 50],
    [-60, 100, 60],
    [-70, 100, 70],
    [10, 100, -10],
    [20, 100, -20],
    [30, 100, -30],
    [40, 100, -40],
    [50, 100, -50],
    [60, 100, -60],
    [70, 100, -70],

    // center
    [0, 100, 10],
    [0, 100, 20],
    [0, 100, 30],
    [0, 100, 40],
    [0, 100, 50],
    [0, 100, 60],
    [0, 100, 70],
    //negative
    [0, 100, -70],
    [0, 100, -60],
    [0, 100, -50],
    [0, 100, -40],
    [0, 100, -30],
    [0, 100, -20],
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
