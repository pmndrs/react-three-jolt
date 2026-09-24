// Demo for issue #247: PhysicsSystem.saveState()/restoreState() and the useRewind() ring buffer.
//
// A heap of boxes falls and settles; `useRewind` records one snapshot per physics step into a
// 5 second ring buffer. Drag the "seconds back" slider and release it to jump the whole world
// back to that recorded moment - use the global "Paused" button (bottom of the page) to freeze
// time first if you want to scrub without the heap continuing to fall underneath you. Releasing
// the slider drops (and frees) every snapshot recorded after the one you jumped to, exactly like
// a real rewind: once you resume, that discarded future never happened.

import { Environment } from '@react-three/drei';
import { Physics, RigidBody, useRewind } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { button, useControls } from 'leva';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// 300 steps at the world's fixed 60Hz timestep = 5 seconds of scrub-back history.
const REWIND_FRAMES = 300;
const REWIND_SECONDS = REWIND_FRAMES / 60;

export function Rewind() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const defaultBodySettings = { mRestitution: 0.3 };

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={20}
            defaultBodySettings={defaultBodySettings}
        >
            <JoltMemoryRegistrar />
            <RewindScene />
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

const LANES = 5;
const ROWS = 6;

function RewindScene() {
    const rewind = useRewind({ frames: REWIND_FRAMES, interval: 1 });

    // `onEditEnd` only, no `onChange`: dragging the slider just previews a value in leva's own
    // store, and the actual rewind (which destroys every snapshot recorded after the one
    // restored to) only happens once you let go - an `onChange` would call `rewind()` on every
    // pointer-move tick, shrinking the buffer far more than the gesture intended.
    const [, set] = useControls('Rewind', () => ({
        'seconds back': {
            value: 0,
            min: 0,
            max: REWIND_SECONDS,
            step: 1 / 60,
            onEditEnd: (value: number) => {
                const steps = Math.round(value * 60);
                if (steps > 0) rewind.rewind(steps);
                // snap the slider back to "now" - the frame just jumped to is the new tip
                set({ 'seconds back': 0 });
            }
        },
        'clear history': button(() => rewind.clear())
    }));

    return (
        <>
            <Floor position={[0, 0, 0]} size={100}>
                <meshStandardMaterial />
            </Floor>
            {Array.from({ length: LANES * ROWS }, (_, i) => {
                const lane = i % LANES;
                const row = Math.floor(i / LANES);
                return (
                    <RigidBody
                        key={i}
                        position={[
                            (lane - (LANES - 1) / 2) * 1.5,
                            5 + row * 1.2,
                            (row % 2) * 0.4 - 0.2
                        ]}
                    >
                        <mesh castShadow receiveShadow>
                            <boxGeometry args={[1, 1, 1]} />
                            <meshStandardMaterial
                                color={new THREE.Color().setHSL(i / (LANES * ROWS), 0.6, 0.55)}
                            />
                        </mesh>
                    </RigidBody>
                );
            })}
        </>
    );
}
