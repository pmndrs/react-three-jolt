// Collision-group filtering (issue #284), mirrors JoltPhysics.js's
// `alternative_collision_filtering` (+ `_raycast`) examples the idiomatic react-three-jolt way.
//
//  - Contacts: `<RigidBody group subGroup>` + `bodySystem.{disable,enable}Collision` decide which
//    BODIES may touch, independent of the broad object-layer category. Bodies only consult this
//    filter when they share a `group`; a disabled `subGroup` pair then skips the contact.
//  - Queries: a `Raycaster`'s `bodyFilter` is a plain, swappable public field (see useRaycaster) -
//    the same rule can be applied to a ray with a custom `Jolt.BodyFilterJS`.
//
// Three coloured shelves stack above a catch-all floor; each shelf only catches falling boxes of
// its own colour, the others fall straight through. Toggle filtering off to watch every colour
// land on every shelf instead, and pick a raycast filter to see the label below change with it.
import { Environment, Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import {
    Physics,
    Raw,
    type Raycaster,
    RigidBody,
    useJolt,
    useRaycaster,
    wrapPointer
} from '@react-three/jolt';
import { Floor } from '@react-three/jolt/addons';
import { useControls } from 'leva';
import { useEffect, useMemo, useState } from 'react';
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
const GRID = 4; // GRID x GRID boxes rain down onto each shelf
const SPACING = 1.1;
// kept outside the falling grid's footprint (+/-1.65) but inside every shelf (half extent 2.5),
// so the probe ray below always meets bare shelf, never a resting box.
const PROBE_X = 2.1;
const PROBE_Z = 2.1;

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
    const { filterByColor, raycastFilter } = useControls('Collision Filtering', {
        filterByColor: { value: true, label: 'Shelves filter by colour' },
        raycastFilter: { value: 'red', options: ['red', 'green', 'blue', 'unfiltered'] }
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
            <FilteredRaycast filter={raycastFilter} />
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

const SUBGROUP_BY_FILTER: Record<string, number | null> = {
    red: 1,
    green: 2,
    blue: 3,
    unfiltered: null
};
// The ray always travels the same vertical column; only what it's allowed to "see" changes.
const shelfNameAt = (y: number) =>
    y > 7.5 ? 'blue' : y > 4.5 ? 'green' : y > 1.5 ? 'red' : 'ground';

/** A ray cast straight down through all three shelves, restricted by a custom BodyFilterJS built
 * from the leva selection - `raycaster.bodyFilter` is a plain public field, replacing it is the
 * documented way to customise a query's filtering (see useMouseRaycaster's MouseRaycasterFilter). */
function FilteredRaycast({ filter }: { filter: string }) {
    const raycaster: Raycaster = useRaycaster();
    const { scene } = useThree();
    const [label, setLabel] = useState('');

    // Installed once per raycaster instance. `ShouldCollideLocked` reads the module-level map by
    // closing over `filter` fresh each time this effect reruns, so no extra ref bookkeeping.
    useEffect(() => {
        raycaster.origin = [PROBE_X, 12, PROBE_Z];
        raycaster.direction = [0, -14, 0];

        const targetSubGroup = SUBGROUP_BY_FILTER[filter];
        const bodyFilter = new Raw.module.BodyFilterJS();
        bodyFilter.ShouldCollide = () => true;
        bodyFilter.ShouldCollideLocked = (bodyPtr: number) => {
            if (targetSubGroup === null) return true;
            const body = wrapPointer(bodyPtr, Raw.module.Body);
            return body.GetCollisionGroup().GetSubGroupID() === targetSubGroup;
        };
        Raw.module.destroy(raycaster.bodyFilter);
        raycaster.bodyFilter = bodyFilter;

        raycaster.initDebugging(scene);
        raycaster.isDebugging = true;
        raycaster.drawMarkers = true;

        // 'closest' is the default collector (never reset below), so this is always a single
        // hit or undefined - the array branch only exists to satisfy cast()'s general signature.
        const result = raycaster.cast();
        const hit = Array.isArray(result) ? result[0] : result;
        setLabel(
            hit
                ? `ray (${filter}) -> ${shelfNameAt(hit.position.y)} shelf`
                : `ray (${filter}) -> no hit`
        );
    }, [raycaster, scene, filter]);

    return (
        <Html position={[PROBE_X, 13, PROBE_Z]} center distanceFactor={20} zIndexRange={[0, 0]}>
            <div
                style={{
                    color: 'white',
                    fontFamily: 'sans-serif',
                    fontSize: 14,
                    fontWeight: 'bold',
                    textShadow: '0 0 4px black, 0 0 4px black',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none'
                }}
            >
                {label}
            </div>
        </Html>
    );
}
