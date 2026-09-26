/**
 * The wireframe collider overlay behind `<Physics debug>` (issue #158).
 *
 * One `THREE.Group` holding one `LineSegments` per registered body, built from the body's actual
 * Jolt shape rather than from the three.js geometry that was handed to `<RigidBody>` - which is
 * the entire point: it shows what the *simulation* sees, including the convex hull it fell back
 * to, the compound you assembled, and the scale it was actually given.
 *
 * Design notes
 * ------------
 * - **Render only.** Nothing here touches the simulation: it reads body poses and shapes and
 *   writes three.js matrices. It runs from `useFrame`, never from a step callback.
 * - **Shapes are shared, so geometry is cached by shape pointer.** A hundred `<RigidBody>`s
 *   around one box shape triangulate that box once. A shape edited in place (a
 *   `MutableCompoundShape`, issue #108) keeps its pointer, so the cache is also keyed on a
 *   generation counter that the world's `shapeChanged` event bumps.
 * - **Membership is event driven.** `bodyAdded` / `bodyRemoved` on the world emitter keep the
 *   overlay in step with the body system; nothing polls `bodySystem.bodies`. Bodies that already
 *   existed when the overlay was created are backfilled in the constructor, which is what makes
 *   toggling `debug` on for a running scene work.
 * - **Colour is event driven too.** Sleeping vs awake comes from the `sleep` / `wake` activation
 *   events rather than a per-frame `IsActive()` call per body.
 *
 * Why not Jolt's own `DebugRenderer`? It only exists in the debug builds of jolt-physics, and
 * even `debug-wasm-compat` exposes no JS binding for it (there is no `DebugRenderer` class in
 * jolt-physics 1.1.0's `types.d.ts`). If a `DebugRendererJS` binding ever lands upstream, it
 * would slot in here as an alternative source of geometry - the group, the caching and the
 * lifecycle below would not have to change.
 */

import type Jolt from 'jolt-physics';
import * as THREE from 'three';
import { Raw } from '../raw';
import type { BodyState } from './body-state';
import type { Unsubscribe } from './emitter';
import type { ActivationPayload, CollisionEnterPayload } from './events';
import type { PhysicsSystem } from './physics-system';
import { createMeshFromShape } from './shape-system';

//* Colours ====================================================================================

/** The categories the overlay colours bodies (and extras) by. */
export type DebugColorKey =
    'static' | 'kinematic' | 'dynamic' | 'sleeping' | 'sensor' | 'constraint' | 'contact';

/** Grey static, blue kinematic, green dynamic, yellow sleeping, magenta sensor. */
export const DEFAULT_DEBUG_COLORS: Record<DebugColorKey, THREE.ColorRepresentation> = {
    static: 0x8d8d8d,
    kinematic: 0x4a90ff,
    dynamic: 0x3ddc84,
    sleeping: 0xffd23d,
    sensor: 0xff3dd2,
    constraint: 0xffffff,
    contact: 0xff5a3d
};

export interface DebugRendererOptions {
    /** Override any of the {@link DEFAULT_DEBUG_COLORS}. */
    colors?: Partial<Record<DebugColorKey, THREE.ColorRepresentation>>;
    /** Draw a line between each constraint's two anchor points. @default true */
    showConstraints?: boolean;
    /**
     * Draw the contact points and normals reported by the last flushed step. Off by default
     * because it subscribes to `collisionPersist`, which makes Jolt hand us (and us wrap) every
     * manifold of every touching pair, every step.
     * @default false
     */
    showContacts?: boolean;
    /** Length of the drawn contact normals, in world units. @default 0.25 */
    contactNormalLength?: number;
    /** Ring buffer size for contact points; older points in the same frame are dropped. @default 1024 */
    maxContacts?: number;
    /**
     * Let the wireframes be occluded by the scene. Off by default, so colliders hidden inside
     * their meshes are still visible.
     * @default false
     */
    depthTest?: boolean;
}

//* Scratch ====================================================================================
// Module level and shared: `update()` is never reentrant (it is one call from one `useFrame`),
// and a debug overlay must not be the thing that allocates every frame.
const _position = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _anchor = new THREE.Vector3();

interface BodyEntry {
    state: BodyState;
    lines: THREE.LineSegments;
    /** Key into {@link DebugRenderer.geometries}; also what releases the reference. */
    cacheKey: string;
    /** Pointer of the shape the current geometry was built from. */
    shapePointer: number;
    color: DebugColorKey;
    sleeping: boolean;
}

interface CachedGeometry {
    geometry: THREE.BufferGeometry;
    refs: number;
}

export class DebugRenderer {
    /** The overlay. Add it to the scene (`<primitive object={renderer.object} />`). */
    readonly object = new THREE.Group();

    private readonly physicsSystem: PhysicsSystem;
    private readonly entries = new Map<number, BodyEntry>();
    private readonly geometries = new Map<string, CachedGeometry>();
    /** Bumped per shape pointer when a shape is edited in place, so the cache key changes. */
    private readonly generations = new Map<number, number>();
    private readonly materials = new Map<DebugColorKey, THREE.LineBasicMaterial>();
    private readonly subscriptions: Unsubscribe[] = [];
    /** Handles whose geometry a `shapeChanged` event invalidated, rebuilt on the next frame. */
    private readonly dirty = new Set<number>();

    private options: Required<Omit<DebugRendererOptions, 'colors'>> & {
        colors: Record<DebugColorKey, THREE.ColorRepresentation>;
    };
    private disposed = false;

    //* Extras -------------------------------------------------
    private constraintLines?: THREE.LineSegments;
    private contactLines?: THREE.LineSegments;
    /** Segments written into the contact buffer since the last frame was drawn. */
    private contactCount = 0;

    // per-frame interpolation state, copied off the physics system once per `update()`
    private alpha = 1;
    private interpolating = false;
    private readonly parentInverse = new THREE.Matrix4();

    constructor(physicsSystem: PhysicsSystem, options: DebugRendererOptions = {}) {
        this.physicsSystem = physicsSystem;
        this.object.name = 'jolt-debug';
        // The wireframes carry world space matrices of their own; letting three recompose this
        // group's matrix from a position/quaternion/scale it never reads would only cost time.
        this.object.matrixAutoUpdate = false;
        this.options = {
            colors: { ...DEFAULT_DEBUG_COLORS, ...options.colors },
            showConstraints: options.showConstraints ?? true,
            showContacts: options.showContacts ?? false,
            contactNormalLength: options.contactNormalLength ?? 0.25,
            maxContacts: options.maxContacts ?? 1024,
            depthTest: options.depthTest ?? false
        };

        const events = physicsSystem.events;
        this.subscriptions.push(
            events.on('bodyAdded', this.onBodyAdded),
            events.on('bodyRemoved', this.onBodyRemoved),
            events.on('shapeChanged', this.onShapeChanged),
            events.on('sleep', this.onSleep),
            events.on('wake', this.onWake)
        );
        if (this.options.showContacts) this.subscribeToContacts();

        // Backfill: turning the overlay on mid-flight has to show the world as it already is.
        physicsSystem.bodySystem.bodies.forEach(this.onBodyAdded);
    }

    //* Options ================================================================================
    /**
     * Apply new options. Colours are pushed straight into the existing materials, so changing
     * one does not rebuild anything.
     */
    setOptions(options: DebugRendererOptions): void {
        if (this.disposed) return;
        const wasShowingContacts = this.options.showContacts;
        this.options = {
            colors: { ...this.options.colors, ...options.colors },
            showConstraints: options.showConstraints ?? this.options.showConstraints,
            showContacts: options.showContacts ?? this.options.showContacts,
            contactNormalLength: options.contactNormalLength ?? this.options.contactNormalLength,
            maxContacts: options.maxContacts ?? this.options.maxContacts,
            depthTest: options.depthTest ?? this.options.depthTest
        };
        this.materials.forEach((material, key) => {
            material.color.set(this.options.colors[key]);
            material.depthTest = this.options.depthTest;
        });
        if (this.options.showContacts !== wasShowingContacts) {
            if (this.options.showContacts) this.subscribeToContacts();
            else this.unsubscribeFromContacts();
        }
        if (!this.options.showConstraints && this.constraintLines)
            this.constraintLines.visible = false;
        if (!this.options.showContacts && this.contactLines) this.contactLines.visible = false;
    }

    //* Membership =============================================================================
    private onBodyAdded = (state: BodyState): void => {
        if (this.disposed || this.entries.has(state.handle)) return;
        const shapePointer = Raw.module.getPointer(state.body.GetShape());
        const cacheKey = this.keyFor(shapePointer);
        const entry: BodyEntry = {
            state,
            lines: new THREE.LineSegments(),
            cacheKey,
            shapePointer,
            color: 'dynamic',
            sleeping: state.isSleeping
        };
        entry.lines.geometry = this.acquireGeometry(cacheKey, state.body.GetShape());
        entry.lines.matrixAutoUpdate = false;
        entry.lines.frustumCulled = false;
        entry.lines.renderOrder = 1000;
        this.refreshColor(entry);
        this.entries.set(state.handle, entry);
        this.object.add(entry.lines);
    };

    private onBodyRemoved = (state: BodyState): void => {
        const entry = this.entries.get(state.handle);
        if (!entry) return;
        this.entries.delete(state.handle);
        this.dirty.delete(state.handle);
        this.object.remove(entry.lines);
        this.releaseGeometry(entry.cacheKey);
    };

    private onShapeChanged = (state: BodyState): void => {
        const entry = this.entries.get(state.handle);
        if (!entry) return;
        // An in-place edit (addSubShape/removeSubShape/modifySubShape) keeps the pointer, so the
        // only way the cache can tell the geometry apart is a fresh generation. Every body
        // sharing that shape is stale, not just this one.
        const pointer = Raw.module.getPointer(state.body.GetShape());
        if (pointer === entry.shapePointer) {
            this.generations.set(pointer, (this.generations.get(pointer) ?? 0) + 1);
            this.entries.forEach((other) => {
                if (other.shapePointer === pointer) this.dirty.add(other.state.handle);
            });
        }
        this.dirty.add(state.handle);
    };

    private onSleep = (payload: ActivationPayload): void => {
        const entry = this.entries.get(payload.handle);
        if (!entry || entry.sleeping) return;
        entry.sleeping = true;
        this.refreshColor(entry);
    };

    private onWake = (payload: ActivationPayload): void => {
        const entry = this.entries.get(payload.handle);
        if (!entry?.sleeping) return;
        entry.sleeping = false;
        this.refreshColor(entry);
    };

    //* Geometry cache =========================================================================
    private keyFor(pointer: number): string {
        return `${pointer}#${this.generations.get(pointer) ?? 0}`;
    }

    private acquireGeometry(cacheKey: string, shape: Jolt.Shape): THREE.BufferGeometry {
        const cached = this.geometries.get(cacheKey);
        if (cached) {
            cached.refs++;
            return cached.geometry;
        }
        // `createMeshFromShape` gives triangles in the shape's own space (it passes the shape's
        // centre of mass as the transform, which cancels the centre of mass offset Jolt bakes
        // into its triangle data), so this geometry lines up with `body.GetPosition()` /
        // `GetRotation()` directly, and a scaled shape is already scaled.
        const triangles = createMeshFromShape(shape);
        const geometry = new THREE.WireframeGeometry(triangles);
        triangles.dispose();
        this.geometries.set(cacheKey, { geometry, refs: 1 });
        return geometry;
    }

    private releaseGeometry(cacheKey: string): void {
        const cached = this.geometries.get(cacheKey);
        if (!cached) return;
        cached.refs--;
        if (cached.refs > 0) return;
        this.geometries.delete(cacheKey);
        cached.geometry.dispose();
    }

    private rebuildGeometry(entry: BodyEntry, shapePointer: number): void {
        const previousKey = entry.cacheKey;
        entry.shapePointer = shapePointer;
        entry.cacheKey = this.keyFor(shapePointer);
        entry.lines.geometry = this.acquireGeometry(entry.cacheKey, entry.state.body.GetShape());
        // released last, so a shape that resolved to the same key is not disposed and rebuilt
        this.releaseGeometry(previousKey);
    }

    //* Materials ==============================================================================
    private materialFor(key: DebugColorKey): THREE.LineBasicMaterial {
        let material = this.materials.get(key);
        if (!material) {
            material = new THREE.LineBasicMaterial({
                color: this.options.colors[key],
                depthTest: this.options.depthTest,
                toneMapped: false,
                transparent: true,
                opacity: 0.9
            });
            this.materials.set(key, material);
        }
        return material;
    }

    private refreshColor(entry: BodyEntry): void {
        const body = entry.state.body;
        let key: DebugColorKey;
        if (body.IsSensor()) key = 'sensor';
        else if (body.IsStatic()) key = 'static';
        else if (body.IsKinematic()) key = 'kinematic';
        else key = entry.sleeping ? 'sleeping' : 'dynamic';
        entry.color = key;
        entry.lines.material = this.materialFor(key);
    }

    //* Frame ==================================================================================
    /** Push this frame's body poses onto the wireframes. Call from `useFrame`. */
    update(): void {
        if (this.disposed || this.physicsSystem.destroyed) return;
        // The overlay's own transform is whatever its parent's is; the wireframes are positioned
        // in world space, so it has to be undone.
        const parent = this.object.parent;
        if (parent) this.parentInverse.copy(parent.matrixWorld).invert();
        else this.parentInverse.identity();
        // Match the pose the bodies' own meshes were given this frame, or the wireframes lead
        // them by up to one physics step whenever interpolation is on.
        this.alpha = this.physicsSystem.frameAlpha;
        this.interpolating = this.physicsSystem.frameInterpolating;

        this.entries.forEach(this.updateEntry);
        if (this.dirty.size) this.dirty.clear();
        this.updateConstraints();
        this.updateContacts();
    }

    private updateEntry = (entry: BodyEntry): void => {
        const state = entry.state;
        // A shape swapped straight through the body interface changes the pointer; an in-place
        // edit is caught by the `shapeChanged` event instead. Both land here.
        const shapePointer = Raw.module.getPointer(state.body.GetShape());
        if (shapePointer !== entry.shapePointer || this.dirty.has(state.handle))
            this.rebuildGeometry(entry, shapePointer);

        if (this.interpolating && state.poseCacheValid)
            state.getInterpolatedPose(this.alpha, _position, _rotation);
        else state.readPose(_position, _rotation);

        entry.lines.matrix.compose(_position, _rotation, _scale).premultiply(this.parentInverse);
        entry.lines.matrixWorldNeedsUpdate = true;
    };

    //* Constraints ============================================================================
    private updateConstraints(): void {
        const records = this.physicsSystem.constraintSystem?.constraints;
        if (!this.options.showConstraints || !records || records.size === 0) {
            if (this.constraintLines) this.constraintLines.visible = false;
            return;
        }
        const lines = this.ensureExtraLines('constraint', records.size * 2);
        const array = (lines.geometry.getAttribute('position') as THREE.BufferAttribute)
            .array as Float32Array;
        let offset = 0;
        records.forEach((record) => {
            // Every constraint the constraint system creates is a TwoBodyConstraint subclass, so
            // the anchor matrices are there - but this is a debug path and a hand rolled
            // constraint could be anything, so it is checked rather than asserted.
            const constraint = record.casted as unknown as Jolt.TwoBodyConstraint;
            if (typeof constraint.GetConstraintToBody1Matrix !== 'function') return;
            // NOTE ON JOLT MEMORY: every one of these returns a pointer to a single static
            // temporary per function. They must never be destroyed, and each one is only valid
            // until that same function is called again - which is why body 1 is read to
            // completion before body 2 is touched.
            this.readAnchor(constraint.GetBody1(), constraint.GetConstraintToBody1Matrix());
            array[offset++] = _anchor.x;
            array[offset++] = _anchor.y;
            array[offset++] = _anchor.z;
            this.readAnchor(constraint.GetBody2(), constraint.GetConstraintToBody2Matrix());
            array[offset++] = _anchor.x;
            array[offset++] = _anchor.y;
            array[offset++] = _anchor.z;
        });
        this.commitExtraLines(lines, offset / 3);
    }

    /**
     * World space position of one end of a constraint, into `_anchor`. The constraint matrix is
     * expressed in its body's *centre of mass* space, which is the frame `GetCenterOfMassPosition`
     * and `GetRotation` describe.
     */
    private readAnchor(body: Jolt.Body, toBody: Jolt.Mat44): void {
        const local = toBody.GetTranslation();
        _anchor.set(local.GetX(), local.GetY(), local.GetZ());
        const rotation = body.GetRotation();
        _rotation.set(rotation.GetX(), rotation.GetY(), rotation.GetZ(), rotation.GetW());
        const com = body.GetCenterOfMassPosition();
        _anchor.applyQuaternion(_rotation).add(_position.set(com.GetX(), com.GetY(), com.GetZ()));
    }

    //* Contacts ===============================================================================
    private subscribeToContacts(): void {
        const events = this.physicsSystem.events;
        this.contactSubscriptions.push(
            events.on('collisionEnter', this.onContact),
            events.on('collisionPersist', this.onContact)
        );
    }

    private unsubscribeFromContacts(): void {
        for (const off of this.contactSubscriptions) off();
        this.contactSubscriptions.length = 0;
        this.contactCount = 0;
    }

    private readonly contactSubscriptions: Unsubscribe[] = [];
    private contactBuffer = new Float32Array(0);

    /**
     * The payload is pooled and its `points` are reused, so everything is copied out here and
     * now. Written straight into the vertex buffer the next `update()` uploads.
     */
    private onContact = (payload: CollisionEnterPayload): void => {
        const max = this.options.maxContacts;
        if (this.contactBuffer.length !== max * 6) this.contactBuffer = new Float32Array(max * 6);
        const array = this.contactBuffer;
        const length = this.options.contactNormalLength;
        const normal = payload.normal;
        for (let i = 0; i < payload.pointCount; i++) {
            if (this.contactCount >= max) return;
            const point = payload.points[i];
            let offset = this.contactCount * 6;
            array[offset++] = point.x;
            array[offset++] = point.y;
            array[offset++] = point.z;
            array[offset++] = point.x + normal.x * length;
            array[offset++] = point.y + normal.y * length;
            array[offset++] = point.z + normal.z * length;
            this.contactCount++;
        }
    };

    private updateContacts(): void {
        if (!this.options.showContacts || this.contactCount === 0) {
            if (this.contactLines) this.contactLines.visible = false;
            this.contactCount = 0;
            return;
        }
        const lines = this.ensureExtraLines('contact', this.options.maxContacts * 2);
        const attribute = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
        (attribute.array as Float32Array).set(
            this.contactBuffer.subarray(0, this.contactCount * 6)
        );
        this.commitExtraLines(lines, this.contactCount * 2);
        // The queue is per step; anything not drawn this frame is stale by the next one.
        this.contactCount = 0;
    }

    //* Extra line helpers =====================================================================
    /** The constraint / contact overlays are one growable `LineSegments` each. */
    private ensureExtraLines(key: 'constraint' | 'contact', vertices: number): THREE.LineSegments {
        const existing = key === 'constraint' ? this.constraintLines : this.contactLines;
        const attribute = existing?.geometry.getAttribute('position') as
            THREE.BufferAttribute | undefined;
        if (existing && attribute && attribute.count >= vertices) return existing;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(new Float32Array(Math.max(vertices, 64) * 3), 3)
        );
        if (existing) {
            existing.geometry.dispose();
            existing.geometry = geometry;
            return existing;
        }
        const lines = new THREE.LineSegments(geometry, this.materialFor(key));
        lines.matrixAutoUpdate = false;
        lines.frustumCulled = false;
        lines.renderOrder = 1001;
        if (key === 'constraint') this.constraintLines = lines;
        else this.contactLines = lines;
        this.object.add(lines);
        return lines;
    }

    private commitExtraLines(lines: THREE.LineSegments, vertices: number): void {
        const attribute = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
        attribute.needsUpdate = true;
        lines.geometry.setDrawRange(0, vertices);
        // These are written in world space, so they get the same parent correction as the bodies.
        lines.matrix.copy(this.parentInverse);
        lines.matrixWorldNeedsUpdate = true;
        lines.visible = vertices > 0;
    }

    //* Teardown ===============================================================================
    /**
     * Drop every subscription, every three.js resource and every reference to the world. Safe to
     * call twice; the instance is dead afterwards.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.subscriptions) off();
        this.subscriptions.length = 0;
        this.unsubscribeFromContacts();

        this.entries.clear();
        this.dirty.clear();
        this.generations.clear();
        this.geometries.forEach((cached) => {
            cached.geometry.dispose();
        });
        this.geometries.clear();
        this.constraintLines?.geometry.dispose();
        this.contactLines?.geometry.dispose();
        this.constraintLines = undefined;
        this.contactLines = undefined;
        this.materials.forEach((material) => {
            material.dispose();
        });
        this.materials.clear();
        // `clear()` only detaches; the geometries and materials above are the owned resources.
        this.object.clear();
        this.object.parent?.remove(this.object);
        this.contactBuffer = new Float32Array(0);
    }
}
