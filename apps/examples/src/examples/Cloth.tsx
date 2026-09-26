// Demo for <Cloth> (issue #244): a banner pinned along its top edge, hanging from a static rod,
// with wind (a per-substep body.AddForce, out of the cloth's own plane) making it billow.
import { Environment } from '@react-three/drei';
import {
    Cloth,
    joltScratch,
    Physics,
    RigidBody,
    type SoftBodyState,
    useBeforePhysicsStep
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { folder, useControls } from 'leva';
import { type RefObject, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

// * pinned at the top, flag/banner controls -------------------------------------

const BANNER_WIDTH = 5;
const BANNER_HEIGHT = 4;
const ROD_Y = 9;
const ROD_LENGTH = BANNER_WIDTH + 1;

/**
 * Wind is a force applied every physics *substep* (`useBeforePhysicsStep`, not `useFrame` - see
 * `components/Attractor.tsx`'s own comment on why), directly on the soft body's `Jolt.Body` -
 * `body.AddForce` does affect soft bodies (verified in `test/cloth.test.ts`), it just needs to
 * push mostly *out of the cloth's own rest plane* to do anything visible: a sheet pinned rigidly
 * along a straight edge can only bend out of plane, not shear within it (see
 * `docs/api/soft-bodies.mdx`'s wind note).
 */
function Wind({
    target,
    strength,
    gustiness
}: {
    target: RefObject<SoftBodyState | undefined>;
    strength: number;
    gustiness: number;
}) {
    const time = useRef(0);
    const force = useRef(new THREE.Vector3());
    useBeforePhysicsStep((deltaTime) => {
        const state = target.current;
        if (!state || state.disposed) return;
        time.current += deltaTime;
        // a slow primary gust plus a faster ripple, so the banner doesn't just snap flat - purely
        // cosmetic, no physical meaning to the frequencies chosen
        const gust =
            1 +
            gustiness * (0.6 * Math.sin(time.current * 1.7) + 0.4 * Math.sin(time.current * 5.3));
        force.current.set(strength * 0.15, 0, strength * Math.max(gust, 0));
        // `joltScratch.vec3` converts the shared THREE.Vector3 into a shared `Jolt.Vec3` for this
        // call only - AddForce takes it by value and copies it, so the scratch object is safe to
        // reuse every substep with zero allocation (see utils/general.ts's own rules on it).
        state.body.AddForce(joltScratch.vec3(force.current));
    });
    return null;
}

function Banner({
    windStrength,
    gustiness,
    pinned
}: {
    windStrength: number;
    gustiness: number;
    pinned: 'top' | 'corners';
}) {
    const clothRef = useRef<SoftBodyState>(undefined);

    return (
        <>
            {/* flagpole + rod the banner hangs from */}
            <RigidBody type="static" position={[-BANNER_WIDTH / 2 - 0.5, ROD_Y / 2, 0]}>
                <mesh castShadow>
                    <boxGeometry args={[0.3, ROD_Y, 0.3]} />
                    <meshStandardMaterial color="#3d405b" />
                </mesh>
            </RigidBody>
            <RigidBody type="static" position={[0, ROD_Y, 0]}>
                <mesh castShadow>
                    <cylinderGeometry args={[0.12, 0.12, ROD_LENGTH, 12]} />
                    <meshStandardMaterial color="#222222" />
                </mesh>
            </RigidBody>

            <Cloth
                ref={clothRef}
                width={BANNER_WIDTH}
                height={BANNER_HEIGHT}
                segmentsX={16}
                segmentsY={12}
                pinned={pinned}
                compliance={0.00005}
                shearCompliance={0.00005}
                position={[0, ROD_Y - BANNER_HEIGHT / 2, 0]}
                friction={0.4}
                linearDamping={0.15}
            >
                <meshStandardMaterial color="#e63946" side={THREE.DoubleSide} />
            </Cloth>

            <Wind target={clothRef} strength={windStrength} gustiness={gustiness} />
        </>
    );
}

export function ClothDemo() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();

    const { windStrength, gustiness, pinned } = useControls('Wind', {
        wind: folder({
            windStrength: { value: 900, min: 0, max: 3000, step: 50, label: 'strength' },
            gustiness: { value: 0.6, min: 0, max: 1, step: 0.05, label: 'gustiness' }
        }),
        pinned: {
            value: 'top',
            options: ['top', 'corners'],
            label: 'pinned'
        }
    });

    return (
        <Physics
            module={module}
            paused={paused}
            key={`${physicsKey}-${pinned}`}
            interpolate={interpolate}
            debug={debug}
            gravity={9.81}
        >
            <Banner
                windStrength={windStrength}
                gustiness={gustiness}
                pinned={pinned as 'top' | 'corners'}
            />
            <Floor position={[0, 0, 0]} size={60}>
                <meshStandardMaterial />
            </Floor>
            <directionalLight
                castShadow
                position={[10, 20, 15]}
                shadow-camera-bottom={-20}
                shadow-camera-top={20}
                shadow-camera-left={-20}
                shadow-camera-right={20}
                shadow-mapSize-width={1024}
                shadow-bias={-0.0001}
            />
            <Environment preset="apartment" />
        </Physics>
    );
}
