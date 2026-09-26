// Collision-group filtering (issues #284, #302), mirrors JoltPhysics.js's
// alternative_collision_filtering example the idiomatic react-three-jolt way:
// `<RigidBody group subGroup>` + `bodySystem.{disable,enable}Collision` decide which BODIES may
// touch, independent of the broad object-layer category.
//
// Sharp edge that #302 tripped over: Jolt hardcodes "two bodies with the SAME sub group id never
// collide" - it is not a table entry and disableCollision/enableCollision cannot touch it. So
// each shelf AND each colour of falling box needs its OWN sub group id (never shared with the
// thing it should land on); disableCollision then turns off just the (different-id) pairs that
// shouldn't touch - here, every box/shelf pair whose colours don't match.
//
// Three coloured shelves stack above a catch-all floor; each shelf only catches falling boxes of
// its own colour, the others fall straight through. Toggle filtering off to watch every colour
// land on every shelf instead. A small mixed wave keeps dropping every few seconds so the sorting
// keeps happening without touching anything.
import { Environment } from '@react-three/drei';
import { Physics, RigidBody, useJolt } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useState } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Shelves get sub groups 1-3, boxes get 11-13 (shelf id + BOX_ID_OFFSET) - distinct ids so a box
// and its own shelf are free to collide; only the mismatched pairs get disabled below.
const BOX_ID_OFFSET = 10;
const SHELVES = [
    { name: 'red', color: '#e63946', subGroup: 1, y: 3 },
    { name: 'green', color: '#2a9d8f', subGroup: 2, y: 6 },
    { name: 'blue', color: '#457b9d', subGroup: 3, y: 9 }
] as const;
const GRID = 3; // GRID x GRID boxes rain down onto each shelf on the first wave
const SPACING = 1.1;
const WAVE_INTERVAL = 4000; // ms between the periodic mixed-colour drops
const MAX_WAVES = 6; // caps how many periodic waves stay live at once

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
    // each periodic wave gets a fresh id so its boxes get a fresh React key; capped so the scene
    // doesn't accumulate boxes forever
    const [waves, setWaves] = useState<number[]>([0]);

    // Every shelf/colour pair whose colours DON'T match gets disabled - the shelf still always
    // collides with its own colour (different, never-shared ids), so that pair is never touched.
    useEffect(() => {
        for (const shelf of SHELVES) {
            for (const other of SHELVES) {
                if (shelf === other) continue;
                const boxSubGroup = other.subGroup + BOX_ID_OFFSET;
                if (filterByColor) bodySystem.disableCollision(shelf.subGroup, boxSubGroup);
                else bodySystem.enableCollision(shelf.subGroup, boxSubGroup);
            }
        }
    }, [filterByColor, bodySystem]);

    useEffect(() => {
        const id = setInterval(() => {
            setWaves((prev) => {
                const next = [...prev, Date.now()];
                return next.length > MAX_WAVES ? next.slice(next.length - MAX_WAVES) : next;
            });
        }, WAVE_INTERVAL);
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
            {/* remounted whenever the toggle flips, so a fresh wave falls and immediately shows
                the current filtering rule instead of leaving already-settled boxes in place */}
            <group key={String(filterByColor)}>
                {SHELVES.map((shelf) => (
                    <FallingBoxes key={`${shelf.subGroup}-initial`} shelf={shelf} grid={GRID} />
                ))}
                {waves.map((wave, i) =>
                    i === 0 ? null : (
                        <group key={wave}>
                            {SHELVES.map((shelf) => (
                                <FallingBoxes key={shelf.subGroup} shelf={shelf} grid={1} />
                            ))}
                        </group>
                    )
                )}
            </group>
        </>
    );
}

function FallingBoxes({ shelf, grid }: { shelf: (typeof SHELVES)[number]; grid: number }) {
    const positions = useMemo(() => {
        const offset = ((grid - 1) * SPACING) / 2;
        const list: [number, number, number][] = [];
        for (let x = 0; x < grid; x++)
            for (let z = 0; z < grid; z++)
                list.push([x * SPACING - offset, 14 + shelf.subGroup, z * SPACING - offset]);
        return list;
    }, [shelf.subGroup, grid]);

    return (
        <>
            {positions.map((position, i) => (
                <RigidBody
                    key={i}
                    position={position}
                    group={0}
                    subGroup={shelf.subGroup + BOX_ID_OFFSET}
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
