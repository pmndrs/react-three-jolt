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

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { afterEach, assert, beforeAll, describe, expect, test } from 'vitest';
import { initJolt, Raw } from '../src/raw';
import {
    type AutoShape,
    addSubShape,
    createMeshForShape,
    createMeshFromShape,
    createShapeFromSettings,
    describeShape,
    describeShapeFromOptions,
    descriptorKey,
    generateCompoundShapeSettings,
    generateHeightfieldShapeFromThree,
    generateShape,
    generateShapeSettings,
    getShapeSettingsFromGeometry,
    getShapeSettingsFromObject,
    getSubShapeTransform,
    isMutableCompoundShape,
    modifySubShape,
    releaseShape,
    removeSubShape,
    type ShapeDescriptor,
    scaleShape,
    subShapeCount
} from '../src/systems/shape-system';
import { createMeshFloor } from '../src/utils/meshTools';
import { installAllocTracker } from './jolt-alloc';

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

//* The descriptor pipeline (issue #107) ====================
// `GetLocalBounds()` hands back a static AABox temporary: read it, never destroy it.
const localBounds = (shape: Jolt.Shape) => {
    const box = shape.GetLocalBounds();
    return {
        min: [box.mMin.GetX(), box.mMin.GetY(), box.mMin.GetZ()],
        max: [box.mMax.GetX(), box.mMax.GetY(), box.mMax.GetZ()]
    };
};

const expectBounds = (
    shape: Jolt.Shape,
    expected: { min: number[]; max: number[] },
    tolerance = 1e-3
) => {
    const bounds = localBounds(shape);
    for (let i = 0; i < 3; i++) {
        assert.closeTo(bounds.min[i], expected.min[i], tolerance, `min[${i}] of ${bounds.min}`);
        assert.closeTo(bounds.max[i], expected.max[i], tolerance, `max[${i}] of ${bounds.max}`);
    }
};

describe('describeShape round trips', () => {
    // [name, three source, forced type, expected subtype, expected local bounds]
    const cases: [
        string,
        () => THREE.Object3D | THREE.BufferGeometry,
        AutoShape | undefined,
        string,
        { min: number[]; max: number[] }
    ][] = [
        [
            'a box mesh',
            () => new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3)),
            undefined,
            'Box',
            { min: [-0.5, -1, -1.5], max: [0.5, 1, 1.5] }
        ],
        [
            'a sphere mesh',
            () => new THREE.Mesh(new THREE.SphereGeometry(2, 32, 32)),
            undefined,
            'Sphere',
            { min: [-2, -2, -2], max: [2, 2, 2] }
        ],
        [
            'a capsule mesh',
            () => new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1)),
            undefined,
            'Capsule',
            // jolt's half height excludes the caps: 1/2 + 0.5
            { min: [-0.5, -1, -0.5], max: [0.5, 1, 0.5] }
        ],
        [
            'a cylinder mesh',
            () => new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2)),
            undefined,
            'Cylinder',
            { min: [-0.5, -1, -0.5], max: [0.5, 1, 0.5] }
        ],
        [
            // a cone is a truncated cylinder: it used to become a radius-0 Cylinder (no shape)
            'a cone mesh',
            () => new THREE.Mesh(new THREE.ConeGeometry(1, 2)),
            undefined,
            'TaperedCylinder',
            // a tapered shape's local space is centred on its centre of mass, which for a cone
            // sits a quarter of the way up: the size is still 2 x 2 x 2
            { min: [-1, -0.5, -1], max: [1, 1.5, 1] }
        ],
        [
            'a bare geometry',
            () => new THREE.BoxGeometry(2, 2, 2),
            undefined,
            'Box',
            { min: [-1, -1, -1], max: [1, 1, 1] }
        ],
        [
            'a forced convex hull',
            () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)),
            'convex',
            'ConvexHull',
            { min: [-1, -1, -1], max: [1, 1, 1] }
        ],
        [
            'a forced trimesh',
            () => new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)),
            'trimesh',
            'Mesh',
            { min: [-1, -1, -1], max: [1, 1, 1] }
        ]
    ];

    for (const [name, makeSource, type, subType, bounds] of cases) {
        test(`${name} describes, generates a ${subType} and leaks nothing`, () => {
            const source = makeSource();
            const allocations = startSpy();

            const descriptor = describeShape(source, { type });
            // the descriptor is plain data: nothing has been allocated yet
            assert.equal(allocations.total(), 0, 'describeShape allocated on the wasm heap');

            const shape = generateShape(descriptor);
            assert.equal(
                shape.GetSubType(),
                (Raw.module as any)[`EShapeSubType_${subType}`],
                `expected a ${subType} shape`
            );
            assert.equal(shape.GetRefCount(), 1, 'generateShape must hand back one reference');
            expectBounds(shape, bounds, 0.02);
            expect(allocations.counts()).toEqual({});

            releaseShape(shape);
            assert.equal(allocations.total(), 0);
        });
    }

    test('a descriptor survives JSON and still builds the same shape', () => {
        const descriptor = describeShape(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3)));
        const revived: ShapeDescriptor = JSON.parse(JSON.stringify(descriptor));
        assert.equal(descriptorKey(revived), descriptorKey(descriptor));

        const shape = generateShape(revived);
        expectBounds(shape, { min: [-0.5, -1, -1.5], max: [0.5, 1, 1.5] }, 0.02);
        releaseShape(shape);
    });

    test('an object with several meshes describes a static compound', () => {
        const group = new THREE.Group();
        for (let i = 0; i < 3; i++) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
            mesh.position.set(i, 0, 0);
            group.add(mesh);
        }
        const descriptor = describeShape(group);
        assert.equal(descriptor.type, 'staticCompound');
        assert.equal((descriptor as any).children.length, 3);
        assert.deepEqual((descriptor as any).children[2].position, [2, 0, 0]);

        const shape = generateShape(descriptor);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        releaseShape(shape);
    });
});

// A tapered shape's local space is centred on its centre of mass, not on the middle of its
// height, so the bounds are shifted along y - the *size* is what the descriptor controls.
const boundsSize = (shape: Jolt.Shape) => {
    const { min, max } = localBounds(shape);
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
};

describe('tapered shapes', () => {
    test('a tapered cylinder descriptor generates a TaperedCylinder', () => {
        const allocations = startSpy();
        const shape = generateShape({
            type: 'taperedCylinder',
            height: 2,
            topRadius: 0.25,
            bottomRadius: 1
        });

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_TaperedCylinder);
        // 2 * the widest radius across x/z, the full height along y
        const size = boundsSize(shape);
        assert.closeTo(size[0], 2, 0.02);
        assert.closeTo(size[1], 2, 0.02);
        assert.closeTo(size[2], 2, 0.02);
        expect(allocations.counts()).toEqual({});

        releaseShape(shape);
        assert.equal(allocations.total(), 0);
    });

    test('a zero top radius (a cone) clamps the convex radius instead of failing', () => {
        const shape = generateShape({
            type: 'taperedCylinder',
            height: 1,
            topRadius: 0,
            bottomRadius: 0.5
        });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_TaperedCylinder);
        releaseShape(shape);
    });

    test('a tapered capsule descriptor generates a TaperedCapsule', () => {
        const shape = generateShape({
            type: 'taperedCapsule',
            height: 2,
            topRadius: 0.25,
            bottomRadius: 1
        });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_TaperedCapsule);
        // the cylindrical section plus both caps: 1 + 2 + 0.25
        const size = boundsSize(shape);
        assert.closeTo(size[0], 2, 0.02);
        assert.closeTo(size[1], 3.25, 0.02);
        releaseShape(shape);
    });

    test('a thin cylinder no longer trips over the default convex radius', () => {
        // the old code always passed a 0.5 convex radius, which jolt rejects on a 0.1 radius
        const shape = generateShape({ type: 'cylinder', radius: 0.1, height: 0.2 });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Cylinder);
        releaseShape(shape);
    });
});

describe('compound descriptors', () => {
    test('a compound with rotated children places them correctly and leaks nothing', () => {
        // a 2 x 0.5 x 0.5 bar turned a quarter turn around z, lifted by 1, and a sphere below it
        const quarterTurn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
        const descriptor: ShapeDescriptor = {
            type: 'staticCompound',
            children: [
                {
                    type: 'box',
                    size: [2, 0.5, 0.5],
                    position: [0, 1, 0],
                    rotation: [quarterTurn.x, quarterTurn.y, quarterTurn.z, quarterTurn.w]
                },
                { type: 'sphere', radius: 0.5, position: [0, -1, 0] }
            ]
        };

        const allocations = startSpy();
        const shape = generateShape(descriptor);

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        // the rotated bar is 0.5 wide and 2 tall now, so it reaches y = 2, and the sphere
        // reaches y = -1.5 and x/z = +-0.5
        expectBounds(shape, { min: [-0.5, -1.5, -0.5], max: [0.5, 2, 0.5] }, 0.05);
        // The sub settings are owned by the compound: AddShape takes a reference and the
        // compound's C++ destructor releases (and frees) them, inside wasm rather than through
        // Module.destroy, so the spy cannot see that free. What it can see is that the scratch
        // Vec3/Quat used for the children's transforms are not left behind.
        expect(allocations.counts()).toEqual({ BoxShapeSettings: 1, SphereShapeSettings: 1 });

        releaseShape(shape);
    });

    test('nested compounds work', () => {
        const shape = generateShape({
            type: 'staticCompound',
            children: [
                {
                    type: 'staticCompound',
                    position: [0, 2, 0],
                    children: [
                        { type: 'box', size: [1, 1, 1] },
                        { type: 'sphere', radius: 0.5, position: [1, 0, 0] }
                    ]
                },
                { type: 'box', size: [1, 1, 1] }
            ]
        });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        // a compound's local space is centred on its centre of mass (so are its children's),
        // which makes absolute bounds a poor assertion: check the tree instead, plus the size
        const compound = Raw.module.castObject(shape, Raw.module.StaticCompoundShape);
        assert.equal(compound.GetNumSubShapes(), 2);
        const subTypes = [0, 1].map((i) => compound.GetSubShape(i).mShape.GetSubType());
        assert.include(subTypes, Raw.module.EShapeSubType_StaticCompound, 'the nested compound');
        assert.include(subTypes, Raw.module.EShapeSubType_Box);
        // the inner compound sits 2 above the outer box, so the whole thing is ~3 tall
        assert.closeTo(boundsSize(shape)[1], 3, 0.1);
        releaseShape(shape);
    });
});

describe('scaled shapes', () => {
    test('scaleShape wraps a shape, takes a reference on it, and scales its bounds', () => {
        const base = generateShape({ type: 'box', size: [1, 1, 1] });
        assert.equal(base.GetRefCount(), 1);

        const allocations = startSpy();
        const scaled = scaleShape(base, [2, 3, 4]);

        assert.equal(scaled.GetSubType(), Raw.module.EShapeSubType_Scaled);
        // ScaledShape holds a RefConst on the inner shape
        assert.equal(base.GetRefCount(), 2, 'the scaled shape did not AddRef the inner shape');
        assert.equal(scaled.GetRefCount(), 1, 'the caller must own exactly one reference');
        expectBounds(scaled, { min: [-1, -1.5, -2], max: [1, 1.5, 2] }, 0.02);
        // the scale Vec3 is destroyed again; the ScaledShape itself is reference counted and
        // deletes itself inside wasm on the last Release, which Module.destroy never sees
        expect(allocations.counts()).toEqual({ ScaledShape: 1 });

        // dropping our reference on the wrapper gives the inner shape's reference back
        releaseShape(scaled);
        assert.equal(base.GetRefCount(), 1, 'the wrapper did not release the inner shape');
        releaseShape(base);
    });

    test('a scaled descriptor builds a ScaledShape in one go', () => {
        const allocations = startSpy();
        const shape = generateShape({
            type: 'scaled',
            scale: [2, 2, 2],
            child: { type: 'sphere', radius: 0.5 }
        });

        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Scaled);
        assert.equal(shape.GetRefCount(), 1);
        expectBounds(shape, { min: [-1, -1, -1], max: [1, 1, 1] }, 0.02);
        // the inner settings are owned (and freed inside wasm) by the scaled settings, which
        // createShapeFromSettings destroyed - the spy only sees the destroy it did not get
        expect(allocations.counts()).toEqual({ SphereShapeSettings: 1 });

        releaseShape(shape);
    });
});

describe('unknown descriptor types', () => {
    test('an unknown type explains itself', () => {
        const allocations = startSpy();
        expect(() => generateShape({ type: 'nonsense' } as unknown as ShapeDescriptor)).toThrow(
            /unknown shape descriptor type/
        );
        assert.equal(allocations.total(), 0);
    });

    test('a failing child inside a compound frees the half built compound', () => {
        const allocations = startSpy();
        expect(() =>
            generateShape({
                type: 'staticCompound',
                children: [
                    { type: 'box', size: [1, 1, 1] },
                    { type: 'nonsense' } as unknown as ShapeDescriptor
                ]
            })
        ).toThrow(/unknown shape descriptor type/);
        // the compound is destroyed on the error path, which releases (and frees, inside wasm)
        // the box settings it had already taken a reference on - the scratch Vec3/Quat are gone
        expect(allocations.counts()).toEqual({ BoxShapeSettings: 1 });
    });
});

//* Mutable compounds (issue #108) ==========================
describe('mutable compounds', () => {
    const mutable = (shape: Jolt.Shape) =>
        Raw.module.castObject(shape, Raw.module.MutableCompoundShape);

    test('a mutableCompound descriptor builds a MutableCompoundShape', () => {
        const shape = generateShape({
            type: 'mutableCompound',
            children: [
                { type: 'box', size: [1, 1, 1], position: [0, 1, 0] },
                { type: 'sphere', radius: 0.5, position: [0, -1, 0] }
            ]
        });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_MutableCompound);
        assert.equal(shape.GetRefCount(), 1);
        assert.equal(subShapeCount(shape), 2);
        releaseShape(shape);
    });

    test('a mutable compound with a single child is NOT collapsed into that child', () => {
        // a static compound is: jolt folds one child into a RotatedTranslatedShape, which would
        // make it impossible to add a second child later
        const shape = generateShape({
            type: 'mutableCompound',
            children: [{ type: 'box', size: [1, 1, 1], position: [0, 1, 0] }]
        });
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_MutableCompound);
        assert.equal(subShapeCount(shape), 1);
        releaseShape(shape);
    });

    test('addSubShape appends a child, grows the bounds, and hands ownership to the compound', () => {
        const shape = generateShape({
            type: 'mutableCompound',
            children: [{ type: 'box', size: [1, 1, 1] }]
        });
        const before = boundsSize(shape);

        const index = addSubShape(shape, { type: 'box', size: [1, 1, 1], position: [0, 3, 0] });
        assert.equal(index, 1, 'the new child is appended');
        assert.equal(subShapeCount(shape), 2);
        // 0.5 below the first box to 3.5 above the second one
        assert.closeTo(boundsSize(shape)[1], 4, 0.05);
        assert.isAbove(boundsSize(shape)[1], before[1]);
        // the compound owns the child: nothing outside holds a reference on it
        assert.equal(mutable(shape).GetSubShape(1).mShape.GetRefCount(), 1);

        releaseShape(shape);
    });

    test('removeSubShape drops a child and shrinks the bounds again', () => {
        const shape = generateShape({
            type: 'mutableCompound',
            children: [
                { type: 'box', size: [1, 1, 1] },
                { type: 'sphere', radius: 0.5, position: [0, 3, 0] }
            ]
        });
        assert.closeTo(boundsSize(shape)[1], 4, 0.05);

        removeSubShape(shape, 1);
        assert.equal(subShapeCount(shape), 1);
        assert.closeTo(boundsSize(shape)[1], 1, 0.05);

        releaseShape(shape);
    });

    test('modifySubShape moves a child without replacing it', () => {
        const shape = generateShape({
            type: 'mutableCompound',
            children: [
                { type: 'box', size: [1, 1, 1] },
                { type: 'box', size: [1, 1, 1], position: [0, 1, 0] }
            ]
        });
        const child = mutable(shape).GetSubShape(1).mShape;
        assert.closeTo(boundsSize(shape)[1], 2, 0.05);

        modifySubShape(shape, 1, { position: [0, 4, 0] });
        // same shape object, new placement
        assert.equal(mutable(shape).GetSubShape(1).mShape.GetSubType(), child.GetSubType());
        assert.closeTo(boundsSize(shape)[1], 5, 0.05);
        // the transform reads back in the space it was given in, through the centre of mass shift
        const transform = getSubShapeTransform(shape, 1);
        assert.closeTo(transform.position[1], 4, 1e-3);

        releaseShape(shape);
    });

    test('a rotated child round trips through getSubShapeTransform', () => {
        const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
        const shape = generateShape({
            type: 'mutableCompound',
            children: [
                { type: 'box', size: [1, 1, 1] },
                {
                    type: 'box',
                    size: [2, 0.5, 0.5],
                    position: [1, 2, -3],
                    rotation: [turn.x, turn.y, turn.z, turn.w]
                }
            ]
        });
        const { position, rotation } = getSubShapeTransform(shape, 1);
        assert.closeTo(position[0], 1, 1e-3);
        assert.closeTo(position[1], 2, 1e-3);
        assert.closeTo(position[2], -3, 1e-3);
        assert.closeTo(rotation[2], turn.z, 1e-3);
        assert.closeTo(rotation[3], turn.w, 1e-3);
        releaseShape(shape);
    });

    test('editing a static compound throws instead of mis-casting it', () => {
        const shape = generateShape({
            type: 'staticCompound',
            children: [
                { type: 'box', size: [1, 1, 1] },
                { type: 'sphere', radius: 0.5, position: [0, 2, 0] }
            ]
        });
        expect(() => addSubShape(shape, { type: 'box', size: [1, 1, 1] })).toThrow(
            /not a MutableCompoundShape/
        );
        expect(() => removeSubShape(shape, 0)).toThrow(/not a MutableCompoundShape/);
        assert.isFalse(isMutableCompoundShape(shape));
        releaseShape(shape);
    });

    test('add then remove is allocation net zero', () => {
        const tracker = installAllocTracker(Raw);
        try {
            const shape = generateShape({
                type: 'mutableCompound',
                children: [{ type: 'box', size: [1, 1, 1] }]
            });
            const before = tracker.live();
            for (let i = 0; i < 5; i++) {
                const index = addSubShape(shape, {
                    type: 'sphere',
                    radius: 0.5,
                    position: [0, i, 0]
                });
                modifySubShape(shape, index, { position: [0, i + 1, 0] });
                removeSubShape(shape, index);
            }
            assert.equal(subShapeCount(shape), 1);
            assert.equal(
                tracker.live(),
                before,
                `editing left ${JSON.stringify(tracker.liveByType())} behind`
            );
            releaseShape(shape);
        } finally {
            tracker.uninstall();
        }
    });

    test('a body whose shape is a mutable compound edits it through BodyState', async () => {
        const { PhysicsSystem } = await import('../src/systems/physics-system');
        const system = new PhysicsSystem('mutable-compound-test');
        const shape = generateShape({
            type: 'mutableCompound',
            children: [{ type: 'box', size: [1, 1, 1] }]
        });
        const handle = system.bodySystem.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)), {
            shape
        });
        // the body took its own reference
        releaseShape(shape);
        const body = system.bodySystem.getBody(handle)!;

        assert.isTrue(body.isMutableCompound);
        const massBefore = body.mass;

        const index = body.addSubShape({ type: 'box', size: [1, 1, 1], position: [0, 3, 0] });
        assert.equal(index, 1);
        assert.equal(subShapeCount(body.shape), 2);
        // NotifyShapeChanged(updateMassProperties) recomputed mass from the new shape
        assert.isAbove(body.mass, massBefore, 'the body kept its old mass properties');

        body.modifySubShape(index, { position: [0, 5, 0] });
        assert.closeTo(getSubShapeTransform(body.shape, index).position[1], 5, 1e-3);

        body.removeSubShape(index);
        assert.equal(subShapeCount(body.shape), 1);
        assert.closeTo(body.mass, massBefore, 1e-3);

        body.destroy(true);
    });

    test('BodyState rejects editing a body that is not a mutable compound', async () => {
        const { PhysicsSystem } = await import('../src/systems/physics-system');
        const system = new PhysicsSystem('mutable-compound-reject-test');
        const body = system.bodySystem.getBody(
            system.bodySystem.addBody(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))
        )!;
        assert.isFalse(body.isMutableCompound);
        expect(() => body.addSubShape({ type: 'box', size: [1, 1, 1] })).toThrow(
            /not a MutableCompoundShape/
        );
        body.destroy(true);
    });
});

describe('descriptor keys', () => {
    test('the key ignores key order and tracks values', () => {
        const a: any = { type: 'box', size: [1, 2, 3], position: [0, 1, 0] };
        const b: any = { position: [0, 1, 0], size: [1, 2, 3], type: 'box' };
        assert.equal(descriptorKey(a), descriptorKey(b));
        assert.notEqual(descriptorKey(a), descriptorKey({ ...a, size: [1, 2, 4] }));
    });

    test('a mesh key stays small and still changes with the mesh', () => {
        const sphere = describeShape(new THREE.SphereGeometry(1, 32, 32), { type: 'trimesh' });
        const key = descriptorKey(sphere);
        assert.isBelow(key.length, 200, 'long vertex arrays must be hashed, not serialised');

        const moved = describeShape(new THREE.SphereGeometry(1, 32, 32).translate(0, 0.01, 0), {
            type: 'trimesh'
        });
        assert.notEqual(descriptorKey(moved), key);
    });

    test('the same geometry always produces the same key', () => {
        const first = describeShape(new THREE.IcosahedronGeometry(1, 2));
        const second = describeShape(new THREE.IcosahedronGeometry(1, 2));
        assert.equal(descriptorKey(first), descriptorKey(second));
    });
});

describe('every descriptor type is allocation neutral', () => {
    const descriptors: [string, ShapeDescriptor][] = [
        ['box', { type: 'box', size: [1, 2, 3] }],
        ['sphere', { type: 'sphere', radius: 2 }],
        ['capsule', { type: 'capsule', radius: 0.5, height: 2 }],
        ['taperedCapsule', { type: 'taperedCapsule', height: 2, topRadius: 0.5, bottomRadius: 1 }],
        ['cylinder', { type: 'cylinder', radius: 0.5, height: 2 }],
        [
            'taperedCylinder',
            { type: 'taperedCylinder', height: 2, topRadius: 0.5, bottomRadius: 1 }
        ],
        [
            'convex',
            describeShapeFromOptions('convex', { geometry: new THREE.BoxGeometry(1, 1, 1) })
        ],
        [
            'trimesh',
            describeShapeFromOptions('trimesh', { geometry: new THREE.SphereGeometry(1, 8, 8) })
        ],
        [
            'heightfield',
            describeShape(new THREE.Mesh(new THREE.PlaneGeometry(16, 16, 15, 15)), {
                type: 'heightfield'
            })
        ],
        [
            'staticCompound',
            {
                type: 'staticCompound',
                children: [
                    { type: 'box', size: [1, 1, 1], position: [0, 1, 0] },
                    { type: 'sphere', radius: 0.5 }
                ]
            }
        ],
        ['scaled', { type: 'scaled', scale: [2, 2, 2], child: { type: 'box', size: [1, 1, 1] } }],
        [
            'mutableCompound',
            {
                type: 'mutableCompound',
                children: [
                    { type: 'box', size: [1, 1, 1], position: [0, 1, 0] },
                    { type: 'sphere', radius: 0.5 }
                ]
            }
        ]
    ];

    for (const [name, descriptor] of descriptors) {
        test(`${name}: generate + release is net zero`, () => {
            // installAllocTracker tracks the value types (Vec3/RVec3/Quat/Mat44/RMat44) the
            // shape paths use as scratch - the ones a per vertex/per child leak shows up in.
            const tracker = installAllocTracker(Raw);
            try {
                const before = tracker.live();
                const shape = generateShape(descriptor);
                releaseShape(shape);
                assert.equal(
                    tracker.live(),
                    before,
                    `${name} left ${JSON.stringify(tracker.liveByType())} behind`
                );
            } finally {
                tracker.uninstall();
            }
        });
    }
});

describe('BodyState.scale goes through the pipeline', () => {
    test('scaling a body wraps its shape once and re-wraps the inner shape after that', async () => {
        const { PhysicsSystem } = await import('../src/systems/physics-system');
        const system = new PhysicsSystem('scale-test');
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        const body = system.bodySystem.getBody(system.bodySystem.addBody(mesh))!;

        const allocations = startSpy();
        body.scale = [2, 2, 2];
        const scaled = body.body.GetShape();
        assert.equal(scaled.GetSubType(), Raw.module.EShapeSubType_Scaled);
        // only the body holds it: `set scale` released the reference it created
        assert.equal(scaled.GetRefCount(), 1, 'the body is not the only owner of the new shape');
        // the scale Vec3 is gone again; the ScaledShape is reference counted, not destroy()ed
        expect(allocations.counts()).toEqual({ ScaledShape: 1 });

        // scaling again wraps the *inner* shape rather than stacking wrappers
        body.scale = [3, 3, 3];
        const rescaled = Raw.module.castObject(body.body.GetShape(), Raw.module.ScaledShape);
        assert.equal(rescaled.GetSubType(), Raw.module.EShapeSubType_Scaled);
        assert.equal(rescaled.GetInnerShape().GetSubType(), Raw.module.EShapeSubType_Box);
        assert.closeTo(rescaled.GetScale().GetX(), 3, 1e-5);
        assert.equal(rescaled.GetRefCount(), 1);

        body.destroy(true);
    });
});

describe('the compatibility wrappers still behave', () => {
    test('getShapeSettingsFromGeometry still returns settings and a three offset', () => {
        const geometry = new THREE.BoxGeometry(1, 2, 3).translate(0, 5, 0);
        const result = getShapeSettingsFromGeometry(geometry)!;
        assert.instanceOf(result.offset, THREE.Vector3);
        assert.closeTo(result.offset!.y, 5, 1e-5);

        const shape = createShapeFromSettings(result.shapeSettings!);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_Box);
        releaseShape(shape);
    });

    test('generateShapeSettings without options no longer throws', () => {
        const shape = createShapeFromSettings(generateShapeSettings('box'));
        expectBounds(shape, { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, 0.02);
        releaseShape(shape);
    });

    test('generateShapeSettings accepts a numeric size', () => {
        const shape = createShapeFromSettings(generateShapeSettings('box', { size: 2 }));
        expectBounds(shape, { min: [-1, -1, -1], max: [1, 1, 1] }, 0.02);
        releaseShape(shape);
    });

    test('the `compound` alias means a static compound', () => {
        const descriptor = describeShapeFromOptions('compound', {
            // jolt collapses a one child compound into that child, so use two
            children: [
                { type: 'box', size: [1, 1, 1] },
                { type: 'sphere', radius: 0.5, position: [0, 2, 0] }
            ]
        });
        assert.equal(descriptor.type, 'staticCompound');
        const shape = generateShape(descriptor);
        assert.equal(shape.GetSubType(), Raw.module.EShapeSubType_StaticCompound);
        releaseShape(shape);
    });

    test('generateHeightfieldShapeFromThree matches the descriptor path', () => {
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(32, 32, 31, 31));
        plane.rotation.x = -Math.PI / 2;

        const legacy = createShapeFromSettings(generateHeightfieldShapeFromThree(plane));
        const viaDescriptor = generateShape(describeShape(plane, { type: 'heightfield' }));

        assert.equal(legacy.GetSubType(), viaDescriptor.GetSubType());
        assert.deepEqual(localBounds(legacy), localBounds(viaDescriptor));

        releaseShape(legacy);
        releaseShape(viaDescriptor);
    });
});
