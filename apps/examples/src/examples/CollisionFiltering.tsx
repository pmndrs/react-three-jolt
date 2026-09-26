// Collision-group filtering (issues #284, #302), mirrors JoltPhysics.js's
// alternative_collision_filtering example the idiomatic react-three-jolt way:
// `<RigidBody group subGroup>` + `bodySystem.{disable,enable}Collision` decide which BODIES may
// touch, independent of the broad object-layer category.
//
// Sharp edges that #302 tripped over, twice: Jolt hardcodes "two bodies with the SAME sub group id
// never collide" - it is not a table entry and disableCollision/enableCollision cannot touch it.
// So every shelf AND every falling box needs its OWN sub group id: shelves never share one with
// each other, and boxes never share one with each other either (or two boxes of the "same colour"
// could never stack on one another). disableCollision then turns off just the pairs that
// shouldn't touch - here, each box against the two shelves whose colour doesn't match it.
//
// Three coloured shelves stack above a catch-all floor; each shelf only catches falling boxes of
// its own colour, the others fall straight through onto a lower shelf (or the floor, for the
// bottom shelf). Toggle filtering off and every shelf accepts every colour, so everything stops at
// the first (topmost, blue) shelf it reaches instead of sorting by colour.
//
// A small, FIXED pool of boxes per colour (not one spawned per wave - see #302 follow-up) cycles
// through the pool every few seconds, teleporting one already-landed box per colour back to the
// top so the sorting keeps visibly happening without the subGroup count growing forever.
import { Environment } from '@react-three/drei';
import { type BodyState, Physics, RigidBody, useJolt } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

const SHELVES = [
    { name: 'red', color: '#e63946', subGroup: 1, y: 3 },
    { name: 'green', color: '#2a9d8f', subGroup: 2, y: 6 },
    { name: 'blue', color: '#457b9d', subGroup: 3, y: 9 }
] as const;
const POOL_SIZE = 5; // boxes per colour - fixed forever, so the sub group count never grows
const BOX_ID_OFFSET = 10; // box subGroup = 10 + colourIndex * POOL_SIZE + slot + 1, always unique
const SLOT_SPACING = 1.1;
// a small cross so the 5 boxes of one colour don't spawn stacked on the same x/z column
const SLOT_OFFSETS: [number, number][] = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
];
const RECYCLE_INTERVAL = 4000; // ms between teleporting one box per colour back to the top

function boxSubGroup(colourIndex: number, slot: number) {
    return BOX_ID_OFFSET + colourIndex * POOL_SIZE + slot + 1;
}
function spawnPosition(shelf: (typeof SHELVES)[number], slot: number): [number, number, number] {
    const [ox, oz] = SLOT_OFFSETS[slot];
    return [ox * SLOT_SPACING, 14 + shelf.subGroup, oz * SLOT_SPACING];
}

export function CollisionFiltering() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
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
            <Inner />
            <directionalLight castShadow position={[10, 18, 10]} shadow-bias={-0.0001} />
            <Environment preset="apartment" />
        </Physics>
    );
}

function Inner() {
    const { bodySystem } = useJolt();
    const { filterByColor } = useControls('Collision Filtering', {
        filterByColor: { value: true, label: 'Shelves filter by colour' }
    });
    // [colourIndex][slot] -> the pooled box's BodyState, so the recycler can teleport it
    const boxRefs = useRef<(BodyState | null | undefined)[][]>(SHELVES.map(() => Array(POOL_SIZE)));

    // Every box against every shelf whose colour it does NOT match gets disabled - a box always
    // collides with its own shelf (they never share a sub group id) and with the other boxes in
    // its own pool (same reason), so neither of those needs to be touched here.
    useEffect(() => {
        for (const shelf of SHELVES) {
            for (let colourIndex = 0; colourIndex < SHELVES.length; colourIndex++) {
                if (SHELVES[colourIndex] === shelf) continue;
                for (let slot = 0; slot < POOL_SIZE; slot++) {
                    const box = boxSubGroup(colourIndex, slot);
                    if (filterByColor) bodySystem.disableCollision(shelf.subGroup, box);
                    else bodySystem.enableCollision(shelf.subGroup, box);
                }
            }
        }
    }, [filterByColor, bodySystem]);

    // Keep the sorting visible forever without ever creating a new body: round-robin through the
    // pool, teleporting one already-settled box per colour back to its spawn height each tick.
    useEffect(() => {
        let tick = 0;
        const id = setInterval(() => {
            const slot = tick % POOL_SIZE;
            tick++;
            SHELVES.forEach((shelf, colourIndex) => {
                const box = boxRefs.current[colourIndex][slot];
                if (!box) return;
                box.position = new THREE.Vector3(...spawnPosition(shelf, slot));
                box.velocity = new THREE.Vector3();
                box.angularVelocity = new THREE.Vector3();
            });
        }, RECYCLE_INTERVAL);
        return () => clearInterval(id);
    }, []);

    return (
        <>
            <Floor position={[0, 0, 0]} size={30}>
                <meshStandardMaterial color="#1d3557" />
            </Floor>
            {SHELVES.map((shelf) => (
                <RigidBody
                    key={shelf.subGroup}
                    type="static"
                    position={[0, shelf.y, 0]}
                    group={0}
                    subGroup={shelf.subGroup}
                >
                    <mesh receiveShadow>
                        <boxGeometry args={[5, 0.5, 5]} />
                        <meshStandardMaterial color={shelf.color} />
                    </mesh>
                </RigidBody>
            ))}
            {/* remounted whenever the toggle flips, so the whole pool immediately shows the
                current filtering rule instead of leaving already-settled boxes in place */}
            <group key={String(filterByColor)}>
                {SHELVES.map((shelf, colourIndex) => (
                    <BoxPool
                        key={shelf.subGroup}
                        shelf={shelf}
                        colourIndex={colourIndex}
                        onRef={(slot, state) => {
                            boxRefs.current[colourIndex][slot] = state;
                        }}
                    />
                ))}
            </group>
        </>
    );
}

function BoxPool({
    shelf,
    colourIndex,
    onRef
}: {
    shelf: (typeof SHELVES)[number];
    colourIndex: number;
    onRef: (slot: number, state: BodyState | null | undefined) => void;
}) {
    const positions = useMemo(
        () => Array.from({ length: POOL_SIZE }, (_, slot) => spawnPosition(shelf, slot)),
        [shelf]
    );

    return (
        <>
            {positions.map((position, slot) => (
                <RigidBody
                    key={slot}
                    ref={(state) => onRef(slot, state)}
                    position={position}
                    group={0}
                    subGroup={boxSubGroup(colourIndex, slot)}
                >
                    <mesh castShadow>
                        <boxGeometry args={[0.5, 0.5, 0.5]} />
                        <meshStandardMaterial color={shelf.color} />
                    </mesh>
                </RigidBody>
            ))}
        </>
    );
}
