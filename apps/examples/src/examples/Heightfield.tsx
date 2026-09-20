import { Environment } from '@react-three/drei';
import {
    type CollisionEnterPayload,
    type CollisionExitPayload,
    Heightfield,
    Physics,
    RigidBody
} from '@react-three/jolt';
import { useDemo } from '../App';

export function HeightfieldDemo() {
    const { debug, paused, interpolate, physicsKey } = useDemo();

    // contact listeners. The handler now gets one payload object; `target` is the body the
    // handler is registered on, `other` is what it hit. Don't retain the payload - it is
    // pooled and reused (see docs/events.md).
    const onCollisionEnter = (event: CollisionEnterPayload) => {
        console.log(
            Date.now(),
            ': contact enter',
            event.target.handle,
            event.other.handle,
            event.contactCount,
            event.normal.y.toFixed(2)
        );
    };

    const onCollisionExit = (event: CollisionExitPayload) => {
        console.log(Date.now(), ': contact exit', event.target.handle, event.other.handle);
    };

    // body settings so shapes bounce

    const defaultBodySettings = {
        mRestitution: 0.1
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
        [0, 100, -10]
    ];
    return (
        <Physics
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
            defaultBodySettings={defaultBodySettings}
        >
            {ballPositions.map((position, index) => (
                <RigidBody
                    key={index}
                    position={position}
                    onCollisionEnter={onCollisionEnter}
                    onCollisionExit={onCollisionExit}
                >
                    <mesh shape={'sphere'}>
                        <sphereGeometry args={[1, 32, 32]} />
                        <meshStandardMaterial color="#E5D0E3" />
                    </mesh>
                </RigidBody>
            ))}
            <Heightfield url="heightmaps/wp1024.png" size={512} />
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
        </Physics>
    );
}
