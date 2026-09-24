// Water volumes (issue #240): a registry of axis-aligned boxes that apply
// `Body.ApplyBuoyancyImpulse` to every dynamic body whose broad-phase AABB overlaps them, once
// per physics substep - the same `onBeforeStep` hook `<Attractor>` uses (see
// components/Attractor.tsx), so a body gets a fixed amount of momentum per substep rather than a
// frame-rate dependent one per rendered frame.
//
// `Body.GetWorldSpaceBounds()` returns `AABox` **by value**, which - like `Body.GetPosition()` /
// `GetRotation()` and every other by-value return in the WebIDL binder - hands back a pointer to
// a single static temporary owned by the binder: read `.mMin`/`.mMax` off it immediately, never
// destroy it, never keep it past the current statement. This is the exact pattern
// `test/shape-system.test.ts` already exercises against `Shape.GetLocalBounds()` (same by-value
// `AABox` return) with zero allocations, so it's read the same way here.

import type Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { anyVec3, joltScratch, vec3 } from '../utils';
import type { BodyState } from './body-state';
import type { PhysicsSystem } from './physics-system';

//* Public types =====================================================

export interface BuoyancyVolumeOptions {
    /** World space center of the volume's box. @default [0, 0, 0] */
    position?: anyVec3;
    /** Full width/height/depth of the box - not half-extents. @default [10, 4, 10] */
    size?: anyVec3;
    /**
     * World space Y of the water surface plane - the `inSurfacePosition` `ApplyBuoyancyImpulse`
     * is given (the surface normal is always straight up, `[0, 1, 0]`).
     * @default the top face of the box: `position.y + size.y / 2`
     */
    surfaceHeight?: number;
    /** How strongly a submerged body is pushed back up. @default 1.5 */
    buoyancy?: number;
    /** Linear velocity damping applied while (partially) submerged. @default 0.3 */
    linearDrag?: number;
    /** Angular velocity damping applied while (partially) submerged. @default 0.05 */
    angularDrag?: number;
    /** Fluid velocity - a current, added into the impulse like the water itself was moving. @default [0, 0, 0] */
    flow?: anyVec3;
    /** Stop applying buoyancy without removing the volume. @default true */
    enabled?: boolean;
    /**
     * Wake a sleeping body whose AABB enters the volume. Without this a body already asleep on
     * the bottom of the volume would never float back up (issue #240).
     * @default true
     */
    activate?: boolean;
    /** Only affect bodies whose collision group id is this one (`<RigidBody group>`). */
    group?: number;
    /** Arbitrary per-body filter, called once per body per substep it overlaps this volume. */
    filter?: (body: BodyState) => boolean;
}

//* Internal record ===================================================
// Bounds and flow are kept as plain numbers, not Jolt or THREE vectors: nothing here is ever
// handed to Jolt directly (the per-substep scratch vectors below are, but those are rebuilt
// from these numbers every time), so there's nothing to own or destroy.
interface VolumeRecord {
    id: number;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    surfaceHeight: number;
    buoyancy: number;
    linearDrag: number;
    angularDrag: number;
    flowX: number;
    flowY: number;
    flowZ: number;
    enabled: boolean;
    activate: boolean;
    group?: number;
    filter?: (body: BodyState) => boolean;
}

const DEFAULT_POSITION: [number, number, number] = [0, 0, 0];
const DEFAULT_SIZE: [number, number, number] = [10, 4, 10];
const DEFAULT_FLOW: [number, number, number] = [0, 0, 0];
const DEFAULT_BUOYANCY = 1.5;
const DEFAULT_LINEAR_DRAG = 0.3;
const DEFAULT_ANGULAR_DRAG = 0.05;

/** Read a `BuoyancyVolumeOptions` into the plain-number bounds/props a `VolumeRecord` holds. */
function toRecord(id: number, options: BuoyancyVolumeOptions): VolumeRecord {
    const position = vec3.three(options.position ?? DEFAULT_POSITION);
    const size = vec3.three(options.size ?? DEFAULT_SIZE);
    const flow = vec3.three(options.flow ?? DEFAULT_FLOW);
    const halfX = size.x / 2;
    const halfY = size.y / 2;
    const halfZ = size.z / 2;
    return {
        id,
        minX: position.x - halfX,
        minY: position.y - halfY,
        minZ: position.z - halfZ,
        maxX: position.x + halfX,
        maxY: position.y + halfY,
        maxZ: position.z + halfZ,
        surfaceHeight: options.surfaceHeight ?? position.y + halfY,
        buoyancy: options.buoyancy ?? DEFAULT_BUOYANCY,
        linearDrag: options.linearDrag ?? DEFAULT_LINEAR_DRAG,
        angularDrag: options.angularDrag ?? DEFAULT_ANGULAR_DRAG,
        flowX: flow.x,
        flowY: flow.y,
        flowZ: flow.z,
        enabled: options.enabled ?? true,
        activate: options.activate ?? true,
        group: options.group,
        filter: options.filter
    };
}

//* System ============================================================

/**
 * The registry `useBuoyancy` / `<Water>` add volumes to. One per `PhysicsSystem`, created lazily
 * by {@link PhysicsSystem.getBuoyancySystem} and torn down with the world.
 *
 * `Body.ApplyBuoyancyImpulse` takes three *different* `Vec3` arguments in the same call (surface
 * normal, fluid velocity, gravity). The module-wide `joltScratch.vec3()` singleton only has room
 * for one live value at a time - calling it three times to build one call's arguments would hand
 * every one of them the same (last-written) object. This class keeps its own three persistent
 * `Jolt.Vec3` scratch objects instead - the same trick `joltScratch` itself uses, just with more
 * slots - created once and destroyed with the system. `surfacePosition` (an `RVec3`) is the only
 * vector argument needed once per call, so that one does go through `joltScratch.rvec3()`.
 */
export class BuoyancySystem {
    readonly physicsSystem: PhysicsSystem;
    private readonly volumes = new Map<number, VolumeRecord>();
    private nextId = 1;
    private destroyed = false;
    /** This substep's dt, written by {@link step} and read by {@link applyToBody}. */
    private deltaTime = 0;

    private readonly normalScratch: Jolt.Vec3;
    private readonly fluidScratch: Jolt.Vec3;
    private readonly gravityScratch: Jolt.Vec3;

    private unsubscribeStep?: () => void;
    private unregister?: () => void;

    constructor(physicsSystem: PhysicsSystem) {
        this.physicsSystem = physicsSystem;
        this.normalScratch = new Raw.module.Vec3(0, 1, 0);
        this.fluidScratch = new Raw.module.Vec3(0, 0, 0);
        this.gravityScratch = new Raw.module.Vec3(0, 0, 0);
        this.unsubscribeStep = physicsSystem.onBeforeStep(this.step);
        this.unregister = physicsSystem.registerDisposable(this);
    }

    //* Registry ======================================================

    /** Register a new water volume. Returns an id, used to {@link updateVolume} or {@link removeVolume} it. */
    addVolume(options: BuoyancyVolumeOptions = {}): number {
        const id = this.nextId++;
        this.volumes.set(id, toRecord(id, options));
        return id;
    }

    /** Replace a volume's options wholesale (not merged - pass everything you want to keep). No-op for an unknown id. */
    updateVolume(id: number, options: BuoyancyVolumeOptions = {}): void {
        if (!this.volumes.has(id)) return;
        this.volumes.set(id, toRecord(id, options));
    }

    /** Remove a previously added volume. Safe to call with an id that is already gone. @returns whether a volume was removed */
    removeVolume(id: number): boolean {
        return this.volumes.delete(id);
    }

    /** Every currently registered volume's id. Test/debug hook. */
    volumeIds(): number[] {
        return [...this.volumes.keys()];
    }

    /** How many volumes are registered. Test/debug hook. */
    get volumeCount(): number {
        return this.volumes.size;
    }

    //* Step ==========================================================

    /**
     * One body against every volume. Hoisted so `bodySystem.dynamicBodies.forEach(fn)` never
     * allocates a closure per substep (same trick as `Attractor.applyToBody`).
     */
    private applyToBody = (body: BodyState): void => {
        const jBody = body.body;
        if (!jBody.IsDynamic()) return;

        // `GetWorldSpaceBounds()` returns AABox by value - the binder's shared static temp for
        // this function. Read the components immediately; never destroy it, never keep it.
        const bounds = jBody.GetWorldSpaceBounds();
        const bMinX = bounds.mMin.GetX();
        const bMinY = bounds.mMin.GetY();
        const bMinZ = bounds.mMin.GetZ();
        const bMaxX = bounds.mMax.GetX();
        const bMaxY = bounds.mMax.GetY();
        const bMaxZ = bounds.mMax.GetZ();

        for (const volume of this.volumes.values()) {
            if (!volume.enabled) continue;
            if (volume.group !== undefined && body.group !== volume.group) continue;

            // broad-phase AABB overlap, exactly like the issue asks for - Jolt's own shape
            // sampling inside ApplyBuoyancyImpulse handles partial submersion from here.
            const overlaps =
                bMinX <= volume.maxX &&
                bMaxX >= volume.minX &&
                bMinY <= volume.maxY &&
                bMaxY >= volume.minY &&
                bMinZ <= volume.maxZ &&
                bMaxZ >= volume.minZ;
            if (!overlaps) continue;

            if (volume.filter && !volume.filter(body)) continue;

            if (!jBody.IsActive()) {
                // a sleeping body resting on the bottom would otherwise never float back up
                if (!volume.activate) continue;
                this.physicsSystem.bodyInterface.ActivateBody(body.BodyID);
            }

            // `GetPosition()` is another shared static temp (same rule as GetWorldSpaceBounds
            // above) - read its components out before any other by-value call can invalidate it.
            const position = jBody.GetPosition();
            const surfacePosition = joltScratch.rvec3(
                position.GetX(),
                volume.surfaceHeight,
                position.GetZ()
            );

            this.normalScratch.Set(0, 1, 0);
            this.fluidScratch.Set(volume.flowX, volume.flowY, volume.flowZ);
            // `GetGravity()` is the same by-value pattern as GetPosition - copy it into our own
            // scratch immediately rather than handing the binder's own temporary to another call.
            // The *world's* gravity, not scaled by this body's own `gravityFactor` - verified
            // empirically (see buoyancy.test.ts): `ApplyBuoyancyImpulse`'s resulting velocity
            // change does not depend on the body's mass at all, only on `volume.buoyancy` (a
            // ratio to standard gravity - 1.0 is neutrally buoyant, >1 floats, <1 sinks) and the
            // submerged fraction Jolt derives from the shape. There is no per-body density knob:
            // give bodies that should behave differently different `<Water buoyancy>` volumes
            // (with `group`/`filter` to pick who each one affects), same as the demo does.
            const gravity = this.physicsSystem.joltPhysicsSystem.GetGravity();
            this.gravityScratch.Set(gravity.GetX(), gravity.GetY(), gravity.GetZ());

            jBody.ApplyBuoyancyImpulse(
                surfacePosition,
                this.normalScratch,
                volume.buoyancy,
                volume.linearDrag,
                volume.angularDrag,
                this.fluidScratch,
                this.gravityScratch,
                this.deltaTime
            );
        }
    };

    private step = (deltaTime: number): void => {
        if (this.destroyed || this.physicsSystem.destroyed) return;
        if (this.volumes.size === 0) return;
        this.deltaTime = deltaTime;
        this.physicsSystem.bodySystem.dynamicBodies.forEach(this.applyToBody);
    };

    //* Teardown ======================================================

    /** Stop stepping, drop every volume and free this system's own scratch objects. Idempotent. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.unsubscribeStep?.();
        this.unsubscribeStep = undefined;
        this.unregister?.();
        this.unregister = undefined;
        this.volumes.clear();
        // `PhysicsSystem.destroy()` runs registered disposables while the world (and its wasm
        // heap) is still alive, so this is the common path. Guarded anyway for a standalone
        // `getBuoyancySystem().destroy()` called after the world itself is already gone.
        if (!this.physicsSystem.destroyed) {
            Raw.module.destroy(this.normalScratch);
            Raw.module.destroy(this.fluidScratch);
            Raw.module.destroy(this.gravityScratch);
        }
    }
}
