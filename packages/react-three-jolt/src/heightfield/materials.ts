/**
 * Per-surface materials for heightfields (issue #46).
 *
 * ## What Jolt does and does not do for us
 *
 * `HeightFieldShapeSettings` carries two material members: `mMaterials`, a
 * `PhysicsMaterialList`, and `mMaterialIndices`, one `uint8` **per quad** (so
 * `(mSampleCount - 1)^2` of them, row major, same order as the height samples). The shape keeps
 * them and `Shape::GetMaterial(subShapeID)` hands the right one back for any contact.
 *
 * What Jolt's JS binding does *not* expose is a material with properties: `PhysicsMaterial` is
 * bound with nothing but a constructor and the ref-count methods, and even in C++ friction never
 * comes from the material - it comes from the two bodies and is combined as `sqrt(f1 * f2)`. The
 * documented way to give one triangle a different friction is to look its material up inside the
 * `ContactListener` and write `ContactSettings::mCombinedFriction` yourself.
 *
 * So this table owns both halves: it creates one bare `PhysicsMaterial` per entry for the shape
 * to index into, and remembers which pointer means which `{ friction, restitution, name }`, so
 * the contact listener can turn a sub-shape id back into a friction value synchronously.
 *
 * ## Ownership (verified at runtime against jolt-physics 1.1.0)
 *
 * `new PhysicsMaterial()` starts at ref-count 0. `list.push_back(m)` takes a reference (1),
 * assigning the list to `settings.mMaterials` copies the vector and takes another (2), destroying
 * our list drops ours (1), `settings.Create()` copies it into the shape (2) and destroying the
 * settings drops the settings' (1 - the shape's). Releasing the shape frees the materials.
 *
 * In short: **destroy the list, never the materials.** `dispose()` therefore only drops JS side
 * bookkeeping and the scratch `SubShapeID`; the materials belong to the shape.
 */

import type Jolt from 'jolt-physics';
import { Raw } from '../raw';

/** A surface description: what a region of a heightfield feels like to slide on. */
export interface SurfaceMaterial {
    /** Friction for contacts on this surface. Combined with the other body's as `sqrt(a * b)`. */
    friction?: number;
    /** Restitution (bounciness). Combined with the other body's as `max(a, b)`. */
    restitution?: number;
    /** Purely for your own debugging/lookups - Jolt's JS binding has no material name. */
    name?: string;
}

/** Jolt stores one `uint8` material index per quad, so at most 256 materials per heightfield. */
export const MAX_SURFACE_MATERIALS = 256;

/**
 * The materials of one heightfield: the JS descriptions, the Jolt `PhysicsMaterial` objects the
 * shape indexes into, and the pointer -> description map the contact listener resolves through.
 */
export class SurfaceMaterialTable {
    readonly materials: readonly SurfaceMaterial[];
    /** jolt `PhysicsMaterial` pointer -> the entry it stands for */
    private byPointer = new Map<number, SurfaceMaterial>();
    private scratchSubShapeId?: Jolt.SubShapeID;
    /** The module the scratch object came from; it is recreated if the module is swapped. */
    private scratchModule?: typeof Jolt;

    constructor(materials: readonly SurfaceMaterial[]) {
        if (materials.length > MAX_SURFACE_MATERIALS)
            throw new Error(
                `Heightfield: at most ${MAX_SURFACE_MATERIALS} materials are supported ` +
                    `(Jolt stores one uint8 material index per quad), got ${materials.length}.`
            );
        this.materials = materials;
    }

    get size(): number {
        return this.materials.length;
    }

    /**
     * Build the `PhysicsMaterialList` for a shape, one bare `PhysicsMaterial` per entry, and
     * remember each one's pointer.
     *
     * The caller owns the returned list only: hand it to the shape settings and destroy the
     * list. The materials inside it are ref-counted by the shape (see the note at the top).
     * Calling this again (a rebuilt shape) throws the previous mapping away, because those
     * materials died with the previous shape and their pointers can be recycled.
     */
    createList(): Jolt.PhysicsMaterialList {
        const jolt = Raw.module;
        this.byPointer.clear();
        const list = new jolt.PhysicsMaterialList();
        list.reserve(this.materials.length);
        for (const material of this.materials) {
            const joltMaterial = new jolt.PhysicsMaterial();
            list.push_back(joltMaterial);
            this.byPointer.set(jolt.getPointer(joltMaterial), material);
        }
        return list;
    }

    /** The entry a Jolt material pointer stands for, if it is one of ours. */
    lookup(pointer: number): SurfaceMaterial | undefined {
        return this.byPointer.get(pointer);
    }

    /** True once {@link createList} has run and the pointer map is live. */
    get mapped(): boolean {
        return this.byPointer.size > 0;
    }

    /**
     * Resolve the surface under one contact. `subShapeIdValue` is
     * `ContactManifold.mSubShapeID1/2.GetValue()`; the shape is the one that owns this table.
     */
    resolve(shape: Jolt.Shape, subShapeIdValue: number): SurfaceMaterial | undefined {
        if (this.byPointer.size === 0) return undefined;
        const jolt = Raw.module;
        if (!this.scratchSubShapeId || this.scratchModule !== jolt) {
            this.scratchSubShapeId = new jolt.SubShapeID();
            this.scratchModule = jolt;
        }
        this.scratchSubShapeId.SetValue(subShapeIdValue);
        // returns a pointer into the shape's material list - never destroy it
        const material = shape.GetMaterial(this.scratchSubShapeId);
        return this.byPointer.get(jolt.getPointer(material));
    }

    /**
     * Drop this table's JS bookkeeping. The Jolt materials are *not* freed here: they belong to
     * the shape and go when it does.
     */
    dispose(): void {
        this.byPointer.clear();
        if (this.scratchSubShapeId && this.scratchModule === Raw.module) {
            this.scratchModule.destroy(this.scratchSubShapeId);
        }
        this.scratchSubShapeId = undefined;
        this.scratchModule = undefined;
    }
}

/**
 * Write a surface's friction/restitution into the live `ContactSettings` of a contact.
 *
 * Synchronous, inside `Step()` - `ContactSettings` is only valid there. The combine rules match
 * Jolt's defaults (`sqrt` for friction, `max` for restitution) so a material only replaces *its*
 * side of the calculation and the other body's friction still counts.
 */
export const applySurfaceMaterial = (
    material: SurfaceMaterial,
    otherBody: Jolt.Body,
    settings: Jolt.ContactSettings
): void => {
    if (material.friction !== undefined)
        settings.mCombinedFriction = Math.sqrt(
            Math.max(0, material.friction) * Math.max(0, otherBody.GetFriction())
        );
    if (material.restitution !== undefined)
        settings.mCombinedRestitution = Math.max(material.restitution, otherBody.GetRestitution());
};
