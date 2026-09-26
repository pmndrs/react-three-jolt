// Demo: contact events (issue #282 / #304, mirrors upstream Examples/contact_listener.html).
//
// A capped, continuously recycled stream of boxes and balls rains onto three pads, each wired
// through a different part of the contact API: the left pad reacts with the plain
// `onCollisionEnter` / `onCollisionExit` props, the right pad subscribes imperatively with
// `useBodyEvent`, and the middle pad's `onContactValidate` rejects every contact so its stream
// falls straight through to the floor below. Every pad flashes colour + scale on contact (decaying
// in `useFrame`), keeps a running counter, and the two solid pads drop a small burst marker at the
// contact point read straight off the `collisionEnter` payload (`points` / `normal`).
import { Environment, Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import {
    type BodyState,
    type CollisionEnterPayload,
    Physics,
    RigidBody,
    useBodyEvent
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const OFF_COLOR = new THREE.Color('#495867');
const REST_COLOR = new THREE.Color('#6a7b8c');
const ON_COLOR = new THREE.Color('#ef8354');
const VALIDATE_COLOR = new THREE.Color('#8338ec');
const PAD_SIZE: [number, number, number] = [3, 0.6, 3];
const PAD_Y = 1.8;
const DROP_Y = 9;
/** How many falling items are alive (and recycled) per pad - the whole stream is capped at 3x this. */
const ITEMS_PER_PAD = 4;
/** How long an item free-falls / rests before being teleported back to the top of its pad. */
const RESPAWN_SECONDS = 2.2;
const FLASH_DECAY = 3.2;
const MAX_BURSTS = 8;
const BURST_LIFE = 0.35;

type SpawnBurst = (position: THREE.Vector3, normal: THREE.Vector3) => void;
/** Lets a pad drop a burst marker without every pad re-implementing the pool. */
const BurstContext = createContext<SpawnBurst>(() => {});

export function ContactEvents() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    const [bursts, setBursts] = useState<BurstRecord[]>([]);
    const nextBurstId = useRef(0);

    const spawnBurst = useCallback<SpawnBurst>((position, normal) => {
        setBursts((prev) => {
            const next = [
                ...prev,
                {
                    id: nextBurstId.current++,
                    position: position.clone(),
                    normal: normal.clone(),
                    born: performance.now()
                }
            ];
            // keep the pool bounded even if bursts land faster than they fade
            return next.length > MAX_BURSTS ? next.slice(next.length - MAX_BURSTS) : next;
        });
    }, []);
    const removeBurst = useCallback((id: number) => {
        setBursts((prev) => prev.filter((b) => b.id !== id));
    }, []);

    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
            gravity={20}
        >
            <JoltMemoryRegistrar />
            <Floor position={[0, 0, 0]} size={30}>
                <meshStandardMaterial color="#2b2d42" />
            </Floor>

            <BurstContext.Provider value={spawnBurst}>
                <PropPad x={-6} label={'onCollisionEnter\n/ onCollisionExit'} />
                <ValidatePad x={0} label={'onContactValidate\n→ rejects, falls through'} />
                <HookPad x={6} label={'useBodyEvent\n(collisionEnter/Exit)'} />
            </BurstContext.Provider>

            {[-6, 0, 6].flatMap((padX) =>
                Array.from({ length: ITEMS_PER_PAD }, (_, i) => (
                    <StreamItem key={`${padX}-${i}`} padX={padX} index={i} />
                ))
            )}

            {bursts.map((burst) => (
                <BurstMarker key={burst.id} record={burst} onDone={removeBurst} />
            ))}

            <directionalLight
                castShadow
                position={[10, 14, 12]}
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

/** One slot in the falling stream: free-falls, then teleports back to the top of its pad. */
function StreamItem({ padX, index }: { padX: number; index: number }) {
    const ref = useRef<BodyState | null>(null);
    // staggered phase so a pad's items do not all drop in lockstep
    const timerRef = useRef((index / ITEMS_PER_PAD) * RESPAWN_SECONDS + Math.random() * 0.3);
    const isBox = index % 2 === 0;

    useFrame((_state, deltaTime) => {
        const body = ref.current;
        if (!body) return;
        timerRef.current -= deltaTime;
        // the y check is a safety net; the timer is what actually keeps the stream moving
        if (timerRef.current > 0 && body.position.y > -5) return;
        timerRef.current = RESPAWN_SECONDS + (Math.random() - 0.5) * 0.6;
        body.position = new THREE.Vector3(
            padX + (Math.random() - 0.5) * 1.2,
            DROP_Y + Math.random() * 2,
            (Math.random() - 0.5) * 1.2
        );
        body.velocity = new THREE.Vector3(0, 0, 0);
        body.angularVelocity = new THREE.Vector3(0, 0, 0);
    });

    return (
        <RigidBody ref={ref} position={[padX, DROP_Y, 0]} restitution={0.35} friction={0.6}>
            <mesh castShadow>
                {isBox ? (
                    <boxGeometry args={[1, 1, 1]} />
                ) : (
                    <sphereGeometry args={[0.55, 16, 16]} />
                )}
                <meshStandardMaterial color="#e0e1dd" />
            </mesh>
        </RigidBody>
    );
}

function PadLabel({
    x,
    text,
    count,
    countLabel
}: {
    x: number;
    text: string;
    count: number;
    countLabel: string;
}) {
    return (
        <Html position={[x, PAD_Y + 2.4, 0]} center distanceFactor={12}>
            <div
                style={{
                    color: 'white',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    textAlign: 'center',
                    whiteSpace: 'pre-line',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    pointerEvents: 'none'
                }}
            >
                {text}
                {'\n'}
                <span style={{ opacity: 0.75 }}>
                    {countLabel}: {count}
                </span>
            </div>
        </Html>
    );
}

/** Shared pad visual: a colour + scale pulse that decays every frame, plus a steady "resting" tint. */
function usePadVisual(offColor: THREE.Color) {
    const meshRef = useRef<THREE.Mesh>(null);
    const materialRef = useRef<THREE.MeshStandardMaterial>(null);
    const flashRef = useRef(0);
    const touchingRef = useRef(false);

    useFrame((_state, deltaTime) => {
        flashRef.current = Math.max(0, flashRef.current - deltaTime * FLASH_DECAY);
        const material = materialRef.current;
        const mesh = meshRef.current;
        if (!material || !mesh) return;
        const base = touchingRef.current ? REST_COLOR : offColor;
        material.color.copy(base).lerp(ON_COLOR, flashRef.current);
        const s = 1 + flashRef.current * 0.18;
        mesh.scale.set(s, 1 + flashRef.current * 0.35, s);
    });

    return {
        meshRef,
        materialRef,
        pulse: () => {
            flashRef.current = 1;
        },
        setTouching: (value: boolean) => {
            touchingRef.current = value;
        }
    };
}

/** Left pad: the ordinary `<RigidBody onCollisionEnter onCollisionExit>` props. */
function PropPad({ x, label }: { x: number; label: string }) {
    const [hits, setHits] = useState(0);
    const { meshRef, materialRef, pulse, setTouching } = usePadVisual(OFF_COLOR);
    const spawnBurst = useContext(BurstContext);

    const handleEnter = (e: CollisionEnterPayload) => {
        setTouching(true);
        pulse();
        setHits((h) => h + 1);
        if (e.pointCount > 0) spawnBurst(e.points[0], e.normal);
    };

    return (
        <>
            <PadLabel x={x} text={label} count={hits} countLabel="hits" />
            <RigidBody
                type="static"
                position={[x, PAD_Y, 0]}
                onCollisionEnter={handleEnter}
                onCollisionExit={() => setTouching(false)}
            >
                <mesh ref={meshRef} receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial ref={materialRef} color={OFF_COLOR} />
                </mesh>
            </RigidBody>
        </>
    );
}

/** Right pad: the same enter/exit toggle, subscribed imperatively via `useBodyEvent`. */
function HookPad({ x, label }: { x: number; label: string }) {
    const ref = useRef<BodyState | null>(null);
    // `ref.current` is set inside RigidBody's own mount effect; reading it back in an effect of
    // our own (which runs after a child's, in the same commit) turns it into reactive state so
    // `useBodyEvent` has an actual BodyState instance to key its subscription on.
    const [body, setBody] = useState<BodyState | undefined>();
    useEffect(() => {
        setBody(ref.current ?? undefined);
    }, []);

    const [hits, setHits] = useState(0);
    const { meshRef, materialRef, pulse, setTouching } = usePadVisual(OFF_COLOR);
    const spawnBurst = useContext(BurstContext);

    useBodyEvent(body, 'collisionEnter', (e) => {
        setTouching(true);
        pulse();
        setHits((h) => h + 1);
        if (e.pointCount > 0) spawnBurst(e.points[0], e.normal);
    });
    useBodyEvent(body, 'collisionExit', () => setTouching(false));

    return (
        <>
            <PadLabel x={x} text={label} count={hits} countLabel="hits" />
            <RigidBody ref={ref} type="static" position={[x, PAD_Y, 0]}>
                <mesh ref={meshRef} receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial ref={materialRef} color={OFF_COLOR} />
                </mesh>
            </RigidBody>
        </>
    );
}

/**
 * Middle pad: `onContactValidate` runs synchronously inside the physics step and its return
 * value is Jolt's answer - returning `false` unconditionally rejects every contact, so nothing
 * ever rests on this pad and the stream falls straight through to the floor below.
 * `ValidatePayload` carries no contact point (the manifold is rejected before one exists), so
 * this pad flashes and counts the *rejections* rather than dropping a burst marker.
 */
function ValidatePad({ x, label }: { x: number; label: string }) {
    const [rejections, setRejections] = useState(0);
    const { meshRef, materialRef, pulse } = usePadVisual(VALIDATE_COLOR);

    return (
        <>
            <PadLabel x={x} text={label} count={rejections} countLabel="rejected" />
            <RigidBody
                type="static"
                position={[x, PAD_Y, 0]}
                onContactValidate={() => {
                    pulse();
                    setRejections((r) => r + 1);
                    return false;
                }}
            >
                <mesh ref={meshRef} receiveShadow>
                    <boxGeometry args={PAD_SIZE} />
                    <meshStandardMaterial
                        ref={materialRef}
                        color={VALIDATE_COLOR}
                        transparent
                        opacity={0.45}
                    />
                </mesh>
            </RigidBody>
        </>
    );
}

interface BurstRecord {
    id: number;
    position: THREE.Vector3;
    normal: THREE.Vector3;
    born: number;
}

/** A short lived ring at the contact point, oriented to the collision normal, that expands and fades. */
function BurstMarker({ record, onDone }: { record: BurstRecord; onDone: (id: number) => void }) {
    const meshRef = useRef<THREE.Mesh>(null);
    const materialRef = useRef<THREE.MeshBasicMaterial>(null);
    const orientation = useMemo(
        () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), record.normal),
        [record.normal]
    );

    useFrame(() => {
        const age = (performance.now() - record.born) / 1000;
        if (age >= BURST_LIFE) {
            onDone(record.id);
            return;
        }
        const t = age / BURST_LIFE;
        meshRef.current?.scale.setScalar(0.15 + t * 0.9);
        if (materialRef.current) materialRef.current.opacity = 1 - t;
    });

    return (
        <mesh ref={meshRef} position={record.position} quaternion={orientation}>
            <ringGeometry args={[0.18, 0.28, 20]} />
            <meshBasicMaterial ref={materialRef} color="#ffd166" transparent depthWrite={false} />
        </mesh>
    );
}
