// Heightfields, three ways (issues #45/#46):
//   - "noise": terrain generated on the CPU from the ported psrddnoise, no image involved
//   - "materials": a flat field split into an ice half and a grippy half, per-quad friction
//   - "image": the original heightmap png
import { Environment } from '@react-three/drei';
import {
    type CollisionEnterPayload,
    type CollisionExitPayload,
    generateHeightfield,
    Heightfield,
    Physics,
    RigidBody
} from '@react-three/jolt';
import { useControls } from 'leva';
import { useMemo } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// low friction on the -x half, grippy on the +x half. `materialIndex` is called once per quad
// with the quad's centre in the same field-local coordinates the height generator sees.
const SURFACES = [
    { name: 'ice', friction: 0.02, restitution: 0 },
    { name: 'grip', friction: 1.5, restitution: 0 }
];
const iceOnTheLeft = (x: number) => (x < 0 ? 0 : 1);

export function HeightfieldDemo() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

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

    const { source, size, noise, octaves, amplitude, frequency, seed, spacing } = useControls(
        'Heightfield',
        {
            source: { value: 'noise', options: ['noise', 'materials', 'image'] },
            size: { value: 128, options: [32, 64, 128, 256] },
            noise: { value: 'psrd', options: ['psrd', 'simplex'] },
            octaves: { value: 4, min: 1, max: 8, step: 1 },
            amplitude: { value: 20, min: 1, max: 80, step: 1 },
            frequency: { value: 0.01, min: 0.001, max: 0.1, step: 0.001 },
            spacing: { value: 2, min: 0.5, max: 8, step: 0.5 },
            seed: { value: 1, min: 0, max: 999, step: 1 }
        }
    );

    // Generation is synchronous, so it belongs in a memo: a 256x256 field with 8 octaves is
    // ~500k noise samples. Anything much larger should be generated once, off the render path,
    // and handed to <Heightfield samples={...}> as a plain Float32Array.
    const generated = useMemo(
        () =>
            source === 'noise'
                ? generateHeightfield({
                      size,
                      noise: noise as 'psrd' | 'simplex',
                      octaves,
                      frequency,
                      amplitude: 1,
                      spacing,
                      seed
                  }).samples
                : undefined,
        [source, size, noise, octaves, frequency, spacing, seed]
    );

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
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={22}
            defaultBodySettings={defaultBodySettings}
        >
            <JoltMemoryRegistrar />
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

            {source === 'noise' && (
                <Heightfield
                    samples={generated}
                    size={size}
                    scale={[spacing, amplitude, spacing]}
                />
            )}

            {/* one flat field, two surfaces: balls skate on the left half and stick on the right */}
            {source === 'materials' && (
                <Heightfield
                    generator={() => 0}
                    size={size}
                    scale={[spacing, 1, spacing]}
                    materials={SURFACES}
                    materialIndex={iceOnTheLeft}
                    color="#2D5F8F"
                />
            )}

            {source === 'image' && <Heightfield url="heightmaps/wp1024.png" size={512} />}
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
