// Per-surface friction on a heightfield (issue #46), against the real jolt-physics module.
//
// Jolt's `PhysicsMaterial` carries no friction of its own (its JS binding is a constructor and
// three ref-count methods), so the whole feature is: put one material per surface in the shape's
// `PhysicsMaterialList`, index into it per quad with `mMaterialIndices`, and resolve the material
// back to a friction value inside the contact listener, where `ContactSettings` is still live.
// These tests drive that end to end - a box really does stop sooner on the rough half - and pin
// down the ownership rules (the shape frees the materials; we free the list).
import * as THREE from 'three';
import { assert, beforeAll, describe, expect, test } from 'vitest';
import {
    heightfieldMaterialIndices,
    heightfieldToGeometry,
    SurfaceMaterialTable
} from '../src/heightField';
import { initJolt, Raw } from '../src/raw';
import { PhysicsSystem } from '../src/systems/physics-system';
import {
    createShapeFromSettings,
    createShapeSettings,
    type HeightfieldShapeDescriptor,
    releaseShape
} from '../src/systems/shape-system';
import { installAllocTracker } from './jolt-alloc';

const SIZE = 32;
const flatSamples = new Float32Array(SIZE * SIZE); // a dead flat field, so only friction matters

// low friction on the -x half, high friction on the +x half
const ICE = 0;
const GRIP = 1;
const materials = [
    { name: 'ice', friction: 0.01, restitution: 0 },
    { name: 'grip', friction: 2, restitution: 0 }
];
const materialIndices = heightfieldMaterialIndices(SIZE, (x) => (x < 0 ? ICE : GRIP));

const flatField = () => new THREE.Mesh(heightfieldToGeometry(flatSamples, SIZE, [1, 1, 1]));

beforeAll(async () => {
    await initJolt();
});

describe('per-quad friction', () => {
    test('a box sliding on the high-friction half stops sooner than on the ice half', () => {
        const ps = new PhysicsSystem('heightfield-materials');
        ps.bodySystem.addHeightfield(flatField(), { materials, materialIndices, restitution: 0 });

        // two identical boxes, one on each half, both shoved along +z at the same speed
        const slide = (x: number) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            mesh.position.set(x, 0.55, -8);
            const body = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
            body.restitution = 0;
            return body;
        };
        const onIce = slide(-6);
        const onGrip = slide(6);

        // settle onto the surface before the shove, so both start from the same contact state
        for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
        const iceStart = onIce.position.z;
        const gripStart = onGrip.position.z;
        onIce.velocity = new THREE.Vector3(0, 0, 12);
        onGrip.velocity = new THREE.Vector3(0, 0, 12);

        for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);

        const iceDistance = onIce.position.z - iceStart;
        const gripDistance = onGrip.position.z - gripStart;
        assert.isAbove(iceDistance, 0, 'the box on ice never moved');
        assert.isBelow(
            gripDistance,
            iceDistance * 0.75,
            `high friction did not slow the box down (ice ${iceDistance.toFixed(2)}, ` +
                `grip ${gripDistance.toFixed(2)})`
        );
        // both stayed on their own half, so each only ever touched one material
        assert.isBelow(onIce.position.x, 0);
        assert.isAbove(onGrip.position.x, 0);

        ps.destroy();
    });

    test('a single material applies everywhere, no index map needed', () => {
        const ps = new PhysicsSystem('heightfield-one-material');
        const handle = ps.bodySystem.addHeightfield(flatField(), {
            materials: [{ name: 'ice', friction: 0.01 }]
        });
        const field = ps.bodySystem.getBody(handle)!;
        assert.isDefined(field.surfaceMaterials);

        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(-6, 0.55, -8);
        const box = ps.bodySystem.getBody(ps.bodySystem.addBody(mesh))!;
        box.restitution = 0;
        for (let i = 0; i < 30; i++) ps.onUpdate(1 / 60);
        const start = box.position.z;
        box.velocity = new THREE.Vector3(0, 0, 12);
        for (let i = 0; i < 120; i++) ps.onUpdate(1 / 60);
        // frictionless-ish: it keeps going a long way
        assert.isAbove(box.position.z - start, 8);

        ps.destroy();
    });

    test('friction/restitution props apply to the whole body', () => {
        const ps = new PhysicsSystem('heightfield-body-props');
        const handle = ps.bodySystem.addHeightfield(flatField(), {
            friction: 0.9,
            restitution: 0.42
        });
        const field = ps.bodySystem.getBody(handle)!;
        assert.closeTo(field.friction, 0.9, 1e-5);
        assert.closeTo(field.restitution, 0.42, 1e-5);
        // no materials given -> no material table and no per-contact work at all
        assert.isUndefined(field.surfaceMaterials);
        ps.destroy();
    });

    test('more materials than indices is refused before anything is built', () => {
        const descriptor: HeightfieldShapeDescriptor = {
            type: 'heightfield',
            heights: flatSamples,
            sampleCount: SIZE,
            scale: [1, 1, 1],
            materials,
            materialIndices: new Uint8Array(4)
        };
        expect(() => createShapeSettings(descriptor)).toThrow(/one material index per quad/);
    });

    test('a material index outside the material list is refused', () => {
        const descriptor: HeightfieldShapeDescriptor = {
            type: 'heightfield',
            heights: flatSamples,
            sampleCount: SIZE,
            scale: [1, 1, 1],
            materials,
            materialIndices: new Uint8Array((SIZE - 1) * (SIZE - 1)).fill(7)
        };
        expect(() => createShapeSettings(descriptor)).toThrow(/outside the 2 materials/);
    });
});

describe('material ownership', () => {
    test('the shape keeps the materials alive and frees them with itself', () => {
        const table = new SurfaceMaterialTable(materials);
        const descriptor: HeightfieldShapeDescriptor = {
            type: 'heightfield',
            heights: flatSamples,
            sampleCount: SIZE,
            scale: [1, 1, 1],
            materials: table,
            materialIndices
        };
        const shape = createShapeFromSettings(createShapeSettings(descriptor));
        // the shape can hand the materials back for any sub-shape, which is what the contact
        // listener resolves friction through
        const first = table.resolve(shape, 0);
        assert.isDefined(first);
        assert.include(['ice', 'grip'], first!.name);
        // and both surfaces really are in there
        const names = new Set<string>();
        for (let subShape = 0; subShape < 64; subShape++)
            names.add(table.resolve(shape, subShape)?.name ?? '?');
        assert.isTrue(names.has('ice') && names.has('grip'), `only saw ${[...names]}`);

        releaseShape(shape);
        table.dispose();
        // dispose() frees the scratch SubShapeID and drops the pointer map; the PhysicsMaterials
        // are gone with the shape, so nothing here may destroy them
        assert.isUndefined(table.resolve(shape, 0));
    });

    test('more than 256 materials is refused (jolt indexes them with a uint8)', () => {
        expect(() => new SurfaceMaterialTable(new Array(257).fill({ friction: 1 }))).toThrow(
            /at most 256/
        );
    });

    test('adding and removing a heightfield with materials is allocation net-zero', () => {
        const ps = new PhysicsSystem('heightfield-alloc');
        // warm up: the first add builds jolt's broadphase/scratch singletons, and
        // installAllocTracker swaps Raw.module's identity, which rebuilds ours once
        ps.bodySystem.removeBody(
            ps.bodySystem.addHeightfield(flatField(), { materials, materialIndices }),
            true
        );

        // `PhysicsMaterial` is deliberately NOT tracked: the shape owns the materials (the list
        // takes a reference, the settings copy it, the shape copies it again) and frees them in
        // C++ when it is released, without ever going through `jolt.destroy`. Everything else
        // here is ours and must net out to zero.
        const alloc = installAllocTracker(Raw, {
            types: [
                'Vec3',
                'RVec3',
                'Quat',
                'SubShapeID',
                'PhysicsMaterialList',
                'HeightFieldShapeSettings',
                'BodyCreationSettings',
                'ShapeRefC'
            ]
        });
        try {
            // warm again under the tracked module so the swap's one-off rebuilds don't count
            ps.bodySystem.removeBody(
                ps.bodySystem.addHeightfield(flatField(), { materials, materialIndices }),
                true
            );
            const before = alloc.live();
            for (let i = 0; i < 3; i++) {
                const handle = ps.bodySystem.addHeightfield(flatField(), {
                    materials,
                    materialIndices
                });
                ps.onUpdate(1 / 60);
                ps.bodySystem.removeBody(handle, true);
            }
            assert.equal(
                alloc.live(),
                before,
                `leaked ${alloc.live() - before}: ${JSON.stringify(alloc.liveByType())}`
            );
        } finally {
            alloc.uninstall();
        }
        ps.destroy();
    });
});
