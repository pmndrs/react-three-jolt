// Collision-group filtering (issue #284), mirrors JoltPhysics.js's alternative_collision_filtering
// example the idiomatic react-three-jolt way: `<RigidBody group subGroup>` +
// `bodySystem.{disable,enable}Collision` decide which BODIES may touch, independent of the broad
// object-layer category. Bodies only consult this filter when they share a `group`; a disabled
// `subGroup` pair then skips the contact. One side effect worth knowing: since every colour below
// shares the SAME group, disabling a colour's shelf pair also stops it colliding with the other
// colours' falling boxes, not just their shelves.
//
// Three coloured shelves stack above a catch-all floor; each shelf only catches falling boxes of
// its own colour, the others fall straight through. Toggle filtering off to watch every colour
// land on every shelf instead.
import { Environment } from '@react-three/drei';
import { Physics, RigidBody, useJolt } from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo } from 'react';
import { useDemo } from '../App';
import { JoltMemoryRegistrar } from '../JoltMemoryReadout';

// Every shelf/box below shares `group={0}` (the default) and gets a colour-specific `subGroup` -
// the filter only ever compares sub groups between bodies that already share a group id.
const SHELVES = [
    { name: 'red', color: '#e63946', subGroup: 1, y: 3 },
    { name: 'green', color: '#2a9d8f', subGroup: 2, y: 6 },
    { name: 'blue', color: '#457b9d', subGroup: 3, y: 9 }
] as const;
const CROSS_PAIRS: [number, number][] = [
    [1, 2],
    [1, 3],
    [2, 3]
];
const GRID = 3; // GRID x GRID boxes rain down onto each shelf
const SPACING = 1.1;

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

    // Cross-colour pairs off: a colour's OWN shelf still catches it (same sub group, never
    // filterable), every other shelf lets it fall through. Flipping this re-enables all three
    // pairs, so every colour starts colliding with every shelf again.
    useEffect(() => {
        for (const [a, b] of CROSS_PAIRS) {
            if (filterByColor) bodySystem.disableCollision(a, b);
            else bodySystem.enableCollision(a, b);
        }
    }, [filterByColor, bodySystem]);

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
                    <FallingBoxes key={shelf.subGroup} shelf={shelf} />
                ))}
            </group>
        </>
    );
}

function FallingBoxes({ shelf }: { shelf: (typeof SHELVES)[number] }) {
    const positions = useMemo(() => {
        const offset = ((GRID - 1) * SPACING) / 2;
        const list: [number, number, number][] = [];
        for (let x = 0; x < GRID; x++)
            for (let z = 0; z < GRID; z++)
                list.push([x * SPACING - offset, 14 + shelf.subGroup, z * SPACING - offset]);
        return list;
    }, [shelf.subGroup]);

    return (
        <>
            {positions.map((position, i) => (
                <RigidBody key={i} position={position} group={0} subGroup={shelf.subGroup}>
                    <mesh castShadow>
                        <boxGeometry args={[0.5, 0.5, 0.5]} />
                        <meshStandardMaterial color={shelf.color} />
                    </mesh>
                </RigidBody>
            ))}
        </>
    );
}
