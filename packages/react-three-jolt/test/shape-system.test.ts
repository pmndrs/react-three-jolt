// Shape generation, against the real WASM module.
//
// Every one of these builds a shape from a three.js geometry, checks Jolt actually produced the
// subtype we asked for, and checks the *net live allocation delta* is zero. Jolt objects are not
// garbage collected: `new Raw.module.X()` allocates on the WASM heap and only
// `Raw.module.destroy(x)` frees it, so counting constructor calls against destroy calls is an
// exact live count for everything this code path allocates.
//
// This is the regression net for the mesh/convex hull leaks: `push_back` copies its argument, so
// the old code's fresh `Vec3`/`Float3`/`IndexedTriangle` per element leaked one WASM object per
// vertex and per triangle (3078 live objects for the 1984-triangle sphere below).

import * as THREE from 'three';
import { afterEach, assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import {
    type AutoShape,
    createMeshForShape,
    createMeshFromShape,
    createShapeFromSettings,
    generateCompoundShapeSettings,
    generateHeightfieldShapeFromThree,
    generateShapeSettings,
    getShapeSettingsFromGeometry,
    getShapeSettingsFromObject,
    releaseShape
} from '../src/systems/shape-system';
import { createMeshFloor } from '../src/utils/meshTools';

//* Allocation tracking =====================================
// Wraps every binder class on the module (they are the ones with a `__destroy__` on their
// prototype) in a Proxy that counts `new`, and wraps `Raw.module.destroy` to count frees.
type AllocationSpy = {
    /** live allocations since the spy started, per class, zero entries omitted */
    counts: () => Record<string, number>;
    /** total live allocations since the spy started */
    total: () => number;
    stop: () => void;
};

const spyOnAllocations = (): AllocationSpy => {
    const jolt = Raw.module as any;
    const originals = new Map<string, any>();
    const nameByClass = new Map<any, string>();
    const live = new Map<string, number>();
    const bump = (name: string, delta: number) => live.set(name, (live.get(name) ?? 0) + delta);

    for (const name of Object.keys(jolt)) {
        let value: any;
        try {
            value = jolt[name];
        } catch {
            continue;
        }
        if (typeof value !== 'function') continue;
        if (!value.prototype || typeof value.prototype.__destroy__ !== 'function') continue;
        try {
            jolt[name] = new Proxy(value, {
                construct(target, args) {
                    bump(name, 1);
                    // construct with the real class as newTarget: the binder registers the
                    // instance in its own per-class cache and we must not change that
                    return Reflect.construct(target, args, target);
                }
            });
        } catch {
            continue;
        }
        originals.set(name, value);
        nameByClass.set(value, name);
    }

    const originalDestroy = jolt.destroy;
    jolt.destroy = (object: any) => {
        const name = nameByClass.get(jolt.getClass(object));
        if (name) bump(name, -1);
        return originalDestroy.call(jolt, object);
    };

    return {
        counts: () => {
            const result: Record<string, number> = {};
            for (const [name, count] of live) if (count !== 0) result[name] = count;
            return result;
        },
        total: () => {
            let total = 0;
            for (const count of live.values()) total += count;
            return total;
        },
        stop: () => {
            for (const [name, value] of originals) jolt[name] = value;
            jolt.destroy = originalDestroy;
        }
    };
};

let spy: AllocationSpy | undefined;
const startSpy = () => {
    spy = spyOnAllocations();
    return spy;
};

afterEach(() => {
    spy?.stop();
    spy = undefined;
});

beforeAll(async () => {
    await initJolt();
});

//* Per shape type ==========================================
// [name, how to build the settings, expected subtype]
const geometryCases: [string, () => THREE.BufferGeometry, AutoShape | undefined, string][] = [
    ['box from BoxGeometry', () => new THREE.BoxGeometry(1, 2, 3), undefined, 'Box'],
    ['box, forced', () => new THREE.TorusKnotGeometry(1, 0.3, 32, 8), 'box', 'Box'],
    ['sphere from SphereGeometry', () => new THREE.SphereGeometry(2, 8, 8), undefined, 'Sphere'],
    ['capsule from CapsuleGeometry', () => new THREE.CapsuleGeometry(0.5, 1), undefined, 'Capsule'],
    [
        'cylinder from CylinderGeometry',
        () => new THREE.CylinderGeometry(0.5, 0.5, 2),
        undefined,
        'Cylinder'
    ],
    ['convex hull, inferred', () => new THREE.IcosahedronGeometry(1, 1), undefined, 'ConvexHull'],
    ['convex hull, forced', () => new THREE.SphereGeometry(1, 16, 16), 'convex', 'ConvexHull'],
    ['trimesh', () => new THREE.SphereGeometry(1, 16, 16), 'trimesh', 'Mesh'],
    [
        'trimesh, non indexed',
        () => new THREE.SphereGeometry(1, 8, 8).toNonIndexed(),
        'trimesh',
        'Mesh'
    ]
];

describe('getShapeSettingsFromGeometry', () => {
    for (const [name, makeGeometry, shapeType, subType] of geometryCases) {
        test(`${name} creates a ${subType} shape and leaks nothing`, () => {
            const geometry = makeGeometry();
            const allocations = startSpy();

            const settings = getShapeSettingsFromGeometry(geometry, shapeType);
            const shape = createShapeFromSettings(settings!.shapeSettings!);

            assert.equal(
                shape.GetSubType(),
                (Raw.module as any)[`EShapeSubType_${subType}`],
                `expected a ${subType} shape`
            );
            // we hold exactly one reference: the settings and jolt's static ShapeResult
            // temporary have both let go
            assert.equal(shape.GetRefCount(), 1, 'shape is not retained exactly once');

            // everything allocated on the way to the shape has been freed again
            expect(allocations.counts()).toEqual({});

            releaseShape(shape);
            assert.equal(allocations.total(), 0);
        });
    }
});

describe('generateShapeSettings', () => {
    const cases: [string, () => any, string][] = [
        ['box', () => generateShapeSettings('box', { size: [1, 2, 3] }), 'Box'],
        ['sphere', () => generateShapeSettings('sphere', { radius: 2 }), 'Sphere'],
        ['capsule', () => generateShapeSettings('capsule', { radius: 0.5, height: 2 }), 'Capsule'],
        [
            'taperedCapsule',
            () => generateShapeSettings('taperedCapsule', { radius: 1, height: 2, topRadius: 0.5 }),
            'TaperedCapsule'
        ],
        [
            'cylinder',
            () => generateShapeSettings('cylinder', { radius: 0.5, height: 2 }),
            'Cylinder'
        ],
        [
            'convex from points',
            () =>
                generateShapeSettings('convex', {
                    points: [
                        new THREE.Vector3(0, 0, 0),
                        new THREE.Vector3(1, 0, 0),
                        new THREE.Vector3(0, 1, 0),
                        new THREE.Vector3(0, 0, 1)
                    ]
                }),
            'ConvexHull'
        ],
        [
            'convex from geometry',
            () => generateShapeSettings('convex', { geometry: new THREE.IcosahedronGeometry(1) }),
            'ConvexHull'
        ],
        [
            'trimesh from vertices and indices',
            () =>
                generateShapeSettings('trimesh', {
                    vertices: [
                        new THREE.Vector3(0, 0, 0),
                        new THREE.Vector3(1, 0, 0),
                        new THREE.Vector3(0, 1, 0),
                        new THREE.Vector3(0, 0, 1)
                    ],
                    indices: [
                        [0, 2, 1],
                        [0, 1, 3],
                        [0, 3, 2],
                        [1, 2, 3]
                    ]
                }),
            'Mesh'
        ],
        [
            'trimesh from geometry',
            () => generateShapeSettings('trimesh', { geometry: new THREE.SphereGeometry(1, 8, 8) }),
            'Mesh'
        ]
    ];

    for (const [name, makeSettings, subType] of cases) {
        test(`${name} creates a ${subType} shape and leaks nothing`, () => {
            const allocations = startSpy();

            const shape = createShapeFromSettings(makeSettings());

            assert.equal(shape.GetSubType(), (Raw.module as any)[`EShapeSubType_${subType}`]);
            assert.equal(shape.GetRefCount(), 1);
            expect(allocations.counts()).toEqual({});

            releaseShape(shape);
            assert.equal(allocations.total(), 0);
        });
    }
});

describe('compound shapes', () => {
    test('an Object3D with several meshes becomes a StaticCompound and leaks nothing', () => {
        const group = new THREE.Group();
        for (let i = 0; i < 3; i++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            mesh.position.set(i, i * 2, i * 3);
            mesh.quaternion.setFromEuler(new THREE.Euler(i, 0, 0));
            group.add(mesh);
        }

        const allocations = startSpy();
        const settings = getShapeSettingsFromObject(group);
        // destroying the compound settings frees the sub settings it holds references on
        const shape = createShapeFromSettings(settings);

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        assert.equal(shape.GetRefCount(), 1);
        // The three sub settings are owned by the compound: AddShape takes a reference and the
        // compound's C++ destructor releases (and so frees) them. That free happens inside WASM
        // rather than through Module.destroy, so the spy cannot see it - what it can see is that
        // nothing else survives, in particular no per-mesh Vec3/Quat.
        expect(allocations.counts()).toEqual({ BoxShapeSettings: 3 });

        releaseShape(shape);
    });

    test('an Object3D with a single mesh returns that shape directly and leaks nothing', () => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(1, 2, 3);

        const allocations = startSpy();
        const settings = getShapeSettingsFromObject(mesh);
        const shape = createShapeFromSettings(settings);

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Box);
        // the early return used to leak the Vec3 and Quat built for the (unused) compound
        expect(allocations.counts()).toEqual({});

        releaseShape(shape);
        assert.equal(allocations.total(), 0);
    });

    test('generateCompoundShapeSettings leaks nothing', () => {
        const allocations = startSpy();
        const settings = generateCompoundShapeSettings([
            {
                shapeSettings: generateShapeSettings('sphere', { radius: 1 }),
                position: new THREE.Vector3(0, 1, 0),
                quaternion: new THREE.Quaternion()
            },
            {
                shapeSettings: generateShapeSettings('box', { size: [1, 1, 1] }),
                position: new THREE.Vector3(0, -1, 0),
                quaternion: new THREE.Quaternion()
            }
        ]);
        const shape = createShapeFromSettings(settings);

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        // as above: the sub settings are released (and freed) by the compound, the per-shape
        // Vec3/Quat are not left behind
        expect(allocations.counts()).toEqual({ SphereShapeSettings: 1, BoxShapeSettings: 1 });

        releaseShape(shape);
    });
});

describe('heightfield', () => {
    test('a PlaneGeometry becomes a HeightField shape and leaks nothing', () => {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(64, 64, 63, 63));
        plane.rotation.x = -Math.PI / 2;

        const allocations = startSpy();
        // mHeightSamples is an ArrayFloat owned by the settings, not a raw _malloc: destroying
        // the settings (which createShapeFromSettings does) frees the samples with it
        const settings = generateHeightfieldShapeFromThree(plane);
        const shape = createShapeFromSettings(settings);

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_HeightField);
        assert.equal(shape.GetRefCount(), 1);
        expect(allocations.counts()).toEqual({});

        releaseShape(shape);
        assert.equal(allocations.total(), 0);
    });
});

describe('allocation scaling', () => {
    // The regression guard: before this fix, a mesh shape allocated (and leaked) one Float3 per
    // vertex and one IndexedTriangle per triangle, plus the three lists, the material and the
    // settings - 3078 live WASM objects for this geometry. It must not scale with the geometry.
    test('a 2k triangle mesh shape does not allocate per vertex', () => {
        const geometry = new THREE.SphereGeometry(1, 32, 32);
        const triangles = geometry.index!.count / 3;
        const vertices = geometry.attributes.position.count;
        assert.isAbove(triangles, 1900, 'expected a ~2k triangle sphere');

        const allocations = startSpy();
        const settings = getShapeSettingsFromGeometry(geometry, 'trimesh');

        // peak, before anything is handed back: the three lists + the two scratch objects are
        // already freed, only the settings themselves are still alive
        const peak = allocations.total();
        assert.isAtMost(
            peak,
            4,
            `mesh shape settings allocated ${peak} objects for ${vertices} vertices / ${triangles} triangles`
        );

        const shape = createShapeFromSettings(settings!.shapeSettings!);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Mesh);
        assert.equal(allocations.total(), 0);
        releaseShape(shape);
    });

    test('a 2k point convex hull does not allocate per point', () => {
        const geometry = new THREE.SphereGeometry(1, 32, 32);
        const allocations = startSpy();
        const settings = getShapeSettingsFromGeometry(geometry, 'convex');

        const peak = allocations.total();
        assert.isAtMost(peak, 4, `convex hull settings allocated ${peak} objects`);

        const shape = createShapeFromSettings(settings!.shapeSettings!);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_ConvexHull);
        assert.equal(allocations.total(), 0);
        releaseShape(shape);
    });
});

describe('error handling', () => {
    test('a failed Create() throws and still frees the settings', () => {
        const allocations = startSpy();
        // a hull needs at least three points
        const settings = generateShapeSettings('convex', { points: [] });
        expect(() => createShapeFromSettings(settings)).toThrow(/could not create the shape/i);
        assert.equal(allocations.total(), 0, 'the error path leaked the settings');
    });
});

describe('shape to three mesh', () => {
    test('createMeshFromShape is the same function as createMeshForShape', () => {
        assert.strictEqual(createMeshForShape, createMeshFromShape);
    });

    test('a shape round trips to a three geometry without leaking', () => {
        const shape = createShapeFromSettings(
            getShapeSettingsFromGeometry(new THREE.BoxGeometry(1, 1, 1))!.shapeSettings!
        );

        const allocations = startSpy();
        const geometry = createMeshFromShape(shape);
        assert.isAbove(geometry.attributes.position.count, 0);
        // the AABox/Quat/Vec3 statics the binder hands back are not allocations; the Vec3 and
        // the ShapeGetTriangles that are get destroyed
        expect(allocations.counts()).toEqual({});

        releaseShape(shape);
    });

    test('createMeshFloor returns body settings that own the shape, and nothing else', () => {
        const allocations = startSpy();
        const bodySettings = createMeshFloor(4, 1, 4, 0, 0, 0);
        // only the BodyCreationSettings survives - the caller owns it
        expect(allocations.counts()).toEqual({ BodyCreationSettings: 1 });
        assert.equal(bodySettings.GetShape().GetSubType(), Raw.module.EShapeSubType_Mesh);

        Raw.module.destroy(bodySettings);
        assert.equal(allocations.total(), 0);
    });
});
