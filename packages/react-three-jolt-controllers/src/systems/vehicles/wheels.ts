import { joltPropName, Raw, withJolt } from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import type {
    ResolvedVehicleSettings,
    SuspensionSpringSettings,
    Vector,
    WheelSettings
} from './vehicle-settings';

// the settings types used to live here; they are re-exported by the package index from
// ./vehicle-settings so `import { WheelSettings } from '@react-three/jolt-controllers'` keeps
// working.

/** keys of our settings objects that are not jolt properties and must never be assigned to one */
const NON_JOLT_KEYS = new Set([
    'object',
    'position',
    'wheelOffsetHorizontal',
    'wheelOffsetVertical',
    'suspensionSpring',
    'fl',
    'fr',
    'bl',
    'br',
    'front',
    'back'
]);

/** settings whose jolt counterpart is a `Vec3` and therefore needs a (copied) temporary */
const VECTOR_KEYS = new Set([
    'suspensionForcePoint',
    'suspensionDirection',
    'steeringAxis',
    'wheelUp',
    'wheelForward'
]);

function applySuspensionSpring(wheel: Jolt.WheelSettings, spring: SuspensionSpringSettings) {
    if (spring.frequency !== undefined) wheel.mSuspensionSpring.mFrequency = spring.frequency;
    if (spring.damping !== undefined) wheel.mSuspensionSpring.mDamping = spring.damping;
}

/**
 * Build the jolt `WheelSettings` for one corner of a vehicle.
 *
 * The returned object is pushed into `VehicleConstraintSettings.mWheels`, which is a `Ref<>`
 * array: the settings own it from there on and it must not be destroyed by the caller.
 */
export function createWheelSettings(
    baseSettings: ResolvedVehicleSettings,
    corner?: string,
    // tracked vehicles ('tv') are not supported yet; the argument is kept for the call sites
    _type: 'wv' | 'tv' = 'wv'
): Jolt.WheelSettingsWV {
    const wheel = new Raw.module.WheelSettingsWV();

    const halfVehicleWidth = baseSettings.vehicleWidth / 2;
    const allWheels = (baseSettings.wheels ?? {}) as unknown as Record<string, unknown>;
    // strip the per corner overrides out of the shared settings and merge the requested corner in
    const { fl, fr, bl, br, front, back, ...defaultWheelSettings } = allWheels;
    const cornerSettings = corner ? (allWheels[corner] as WheelSettings | undefined) : undefined;
    const wheelSettings: WheelSettings = {
        ...(defaultWheelSettings as WheelSettings),
        ...cornerSettings
    };
    const isFront = corner === 'fl' || corner === 'fr' || corner === 'front';
    const isLeft = corner === 'fl' || corner === 'bl';

    // `mPosition` is a Vec3 by value, so the assignment copies and the temporary is ours to free
    // (this used to leak one Vec3 per wheel). An explicit `position` wins over the offsets.
    const offsetHorizontal = wheelSettings.wheelOffsetHorizontal ?? 0;
    const offsetVertical = wheelSettings.wheelOffsetVertical ?? 0;
    const position: Vector = wheelSettings.position ?? [
        isLeft ? halfVehicleWidth : -halfVehicleWidth,
        -offsetVertical,
        isFront ? offsetHorizontal : -offsetHorizontal
    ];
    withJolt(position, (value) => {
        wheel.mPosition = value;
    });

    if (wheelSettings.suspensionSpring) {
        applySuspensionSpring(wheel, wheelSettings.suspensionSpring);
    }

    // everything else maps straight onto the jolt property of the same name.
    // embind: the wheel settings' properties are emscripten accessors and the key is computed
    // (`joltPropName`), so this one cast is what buys the whole loop its dynamic writes - it
    // used to be a suppression on each of the two assignments.
    const joltWheel = wheel as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(wheelSettings)) {
        if (value === undefined || NON_JOLT_KEYS.has(key)) continue;
        const joltKey = joltPropName(key);
        if (VECTOR_KEYS.has(key)) {
            // by-value Vec3 properties: the assignment copies, the temporary is ours
            withJolt(value as Vector, (vector) => {
                joltWheel[joltKey] = vector;
            });
            continue;
        }
        joltWheel[joltKey] = value;
    }
    return wheel;
}

//creates basic crashtest style wheel texture
// One loader, one texture and one material for the whole process: this used to build a fresh
// TextureLoader, texture and material for every wheel of every vehicle (issue #140). Because it
// is shared, `WheelState.destroy()` disposes only its own geometry.
let sharedWheelMaterial: THREE.MeshPhongMaterial | undefined;

/** the shared wheel material, if it has been built - callers use this to skip disposing it */
export function getSharedWheelMaterial() {
    return sharedWheelMaterial;
}

export function getWheelMaterial() {
    if (sharedWheelMaterial) return sharedWheelMaterial;
    // Create material for wheel
    const texLoader = new THREE.TextureLoader();
    const texture = texLoader.load(
        'data:image/gif;base64,R0lGODdhAgACAIABAAAAAP///ywAAAAAAgACAAACA0QCBQA7'
    );
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.offset.set(0, 0);
    texture.repeat.set(1, 1);
    texture.magFilter = THREE.NearestFilter;
    const wheelMaterial = new THREE.MeshPhongMaterial({ color: 0x666666 });
    wheelMaterial.map = texture;
    sharedWheelMaterial = wheelMaterial;
    return wheelMaterial;
}

/**
 * Dispose a three object tree the library generated itself (issues #26/#27: objects the *user*
 * handed us are only ever detached, never disposed). The wheel material is shared between every
 * wheel in the process, so it is deliberately skipped.
 */
export function disposeGeneratedObject(object: THREE.Object3D) {
    object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material))
            material.forEach((entry) => {
                entry.dispose();
            });
        else if (material && material !== getSharedWheelMaterial()) material.dispose();
    });
    object.removeFromParent();
    object.clear();
}
