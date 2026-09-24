/**
 * Event names, payload shapes and the dispatch bitfield shared by the world (`PhysicsSystem`)
 * and per body (`BodyState`) emitters. See docs/events.md.
 */

import type { Object3D, Vector3 } from 'three';
import type { BodyState } from './body-state';
import type { ShapeDescriptor } from './shape-system';
import type { SoftBodyState } from './soft-body-system';

/**
 * One bit per event type. `Emitter.mask` ors these together, which is what lets the Jolt
 * contact callback bail out before it wraps a manifold nobody is going to look at.
 */
export const EventBit = {
    collisionEnter: 1 << 0,
    collisionPersist: 1 << 1,
    collisionExit: 1 << 2,
    sensorEnter: 1 << 3,
    sensorExit: 1 << 4,
    sleep: 1 << 5,
    wake: 1 << 6,
    contactValidate: 1 << 7,
    /**
     * Not a user event: set by `BodyState.activateMotionSource` so conveyors and teleporters
     * keep getting their synchronous `ContactSettings` pass even when no user handler is
     * attached to the body.
     */
    motionSource: 1 << 8,
    /**
     * Not a user event either: set by `BodyState.setSurfaceMaterials` so a heightfield with
     * per-quad materials (issue #46) gets its synchronous `ContactSettings` pass - Jolt's
     * materials carry no friction of their own, so it has to be written from the callback.
     */
    surfaceMaterial: 1 << 9
} as const;

/** Any of the contact driven bits - if none of these are set, contacts cost nothing. */
export const CONTACT_BITS =
    EventBit.collisionEnter |
    EventBit.collisionPersist |
    EventBit.collisionExit |
    EventBit.sensorEnter |
    EventBit.sensorExit |
    EventBit.motionSource |
    EventBit.surfaceMaterial;

/** Bits needed while a contact is being *added* or *persisted* (manifold/settings wrapping). */
export const MANIFOLD_BITS =
    EventBit.collisionEnter |
    EventBit.collisionPersist |
    EventBit.sensorEnter |
    EventBit.motionSource |
    EventBit.surfaceMaterial;

/** Step events, shared by `PhysicsSystem` and the `useBeforePhysicsStep` / `useAfterPhysicsStep` hooks. */
export type StepCallback = (deltaTime: number, subframe: number) => void;

/**
 * One side of a contact.
 *
 * `body` and `object` are `undefined` for a Jolt body that was never registered with
 * `BodySystem` - the vehicle's chassis and the character controller's rig anchor are both
 * created straight through the body interface. Those contacts used to be dropped entirely (or
 * to throw inside the WASM callback); now only the unknown side is blank.
 */
export interface CollisionTarget {
    body: BodyState | undefined;
    object: Object3D | undefined;
    /** `BodyID.GetIndexAndSequenceNumber()`. Always valid, even for an unknown body. */
    handle: number;
    /** `SubShapeID.GetValue()`. `-1` (Jolt's "empty" id) for a shape with no sub-shapes. */
    subShapeId: number;
    /** Instance index, for a body belonging to an `<InstancedRigidBody>`. */
    index?: number;
    /**
     * The soft body this side of the contact belongs to (issue #245), when it is one. A soft
     * body has no `BodyState` - `body` is always `undefined` for it, `object` is the mesh it
     * drives instead. `undefined` for every rigid-body side.
     */
    softBody?: SoftBodyState;
}

/**
 * Which piece of a compound shape a contact happened on (issue #13).
 *
 * Resolved **lazily**: reading `payload.targetSubShape` is what walks the shape, so a handler
 * that never asks costs nothing per contact. Like the payload itself, the object is pooled -
 * read what you need inside the handler rather than keeping it.
 */
export interface SubShapeRef {
    /** Raw `SubShapeID.GetValue()`. `-1` is Jolt's "empty" id. */
    id: number;
    /**
     * Index of the top level compound child that was hit, or `-1` when the body's shape has no
     * children (the whole shape is the contact).
     */
    index: number;
    /**
     * The `userData` stamped on the `<Shape>` / descriptor that produced this sub shape, at any
     * nesting depth. `0` when nothing set one.
     */
    userData: number;
    /**
     * The descriptor the sub shape was built from, when the body kept one
     * (`BodyState.shapeDescriptor`). A body built straight from a `Jolt.Shape` has none.
     */
    descriptor: ShapeDescriptor | undefined;
}

export interface CollisionPayload {
    /** The body the handler is registered on. World level handlers get the lower `handle`. */
    target: CollisionTarget;
    other: CollisionTarget;
    /** True when `target` is Jolt's body 2 for this pair. */
    flipped: boolean;
    /** Sub-shape manifolds currently open between the two bodies. */
    contactCount: number;
    /** Which piece of `target`'s shape was hit. Resolved on first read - see {@link SubShapeRef}. */
    readonly targetSubShape: SubShapeRef;
    /** Which piece of `other`'s shape was hit. Resolved on first read. */
    readonly otherSubShape: SubShapeRef;
}

export interface CollisionEnterPayload extends CollisionPayload {
    /** World space, pointing from `other` toward `target` (the separation direction). */
    normal: Vector3;
    penetration: number;
    /** World space contact points; `points.length === pointCount`. */
    points: Vector3[];
    pointCount: number;
}

export type CollisionExitPayload = CollisionPayload;
export type SensorPayload = CollisionPayload;

export interface ActivationPayload {
    body: BodyState | undefined;
    handle: number;
}

export interface ValidatePayload {
    target: CollisionTarget;
    other: CollisionTarget;
    /** World space offset the manifold's relative contact points are expressed against. */
    baseOffset: Vector3;
}

/**
 * `contactValidate` payload for a soft body (issue #245). Unlike rigid's {@link ValidatePayload},
 * Jolt hands no `baseOffset` to `SoftBodyContactListener::OnSoftBodyContactValidate` - it fires
 * once per (soft body, other body) whose bounding boxes overlap, *before* any vertex contact is
 * confirmed (accepting doesn't mean anything actually touches; rejecting skips it for the step).
 */
export interface SoftBodyValidatePayload {
    target: CollisionTarget;
    other: CollisionTarget;
}

/**
 * Events emitted by `bodyState.events` (and by `physicsSystem.events`, world wide).
 *
 * **Payloads are pooled and reused.** Read what you need inside the handler, or clone it; do
 * not retain the payload, its `normal`, its `points` or its `CollisionTarget`s. This is the
 * same contract r3f pointer events and rapier's `TempContactManifold` carry. Under
 * `<Physics debug>` the pooled objects are poisoned after dispatch, so retaining one fails
 * loudly in development and costs nothing in production.
 */
export type BodyEventMap = {
    collisionEnter: (payload: CollisionEnterPayload) => void;
    collisionPersist: (payload: CollisionEnterPayload) => void;
    collisionExit: (payload: CollisionExitPayload) => void;
    sensorEnter: (payload: SensorPayload) => void;
    sensorExit: (payload: SensorPayload) => void;
    sleep: (payload: ActivationPayload) => void;
    wake: (payload: ActivationPayload) => void;
    /**
     * Runs *synchronously inside* `joltInterface.Step()`. Return false to reject the contact.
     * Must be fast and must not touch bodies - see docs/events.md.
     */
    contactValidate: (payload: ValidatePayload) => boolean | void;
};

/** Events emitted by `physicsSystem.events`. */
export type WorldEventMap = BodyEventMap & {
    beforeStep: StepCallback;
    afterStep: StepCallback;
    /** Every dynamic body is asleep. Edge triggered. */
    settled: () => void;
    activityChange: (active: number, total: number) => void;

    //* Registry events (issue #158) ---------------------------------------------------
    // Not pooled and not dispatched from inside `Step()`: the `BodyState` handed over is the
    // real one and stays valid for the duration of the call. They exist so a renderer (or any
    // other observer) can mirror the contents of the world without polling `bodySystem.bodies`
    // every frame.
    /** A body finished being registered with the world and added to the simulation. */
    bodyAdded: (body: BodyState) => void;
    /**
     * A body is on its way out. Fires *before* anything is torn down, so `body.object` and
     * `body.body` are both still usable; do not retain either past the handler.
     */
    bodyRemoved: (body: BodyState) => void;
    /**
     * A body's shape was replaced or edited in place (`set shape`, `notifyShapeChanged`, and so
     * every `addSubShape` / `removeSubShape` / `modifySubShape` on a mutable compound). Anything
     * caching geometry per shape has to invalidate its entry for this body.
     */
    shapeChanged: (body: BodyState) => void;
};

/** Bit assignment handed to a `BodyState`'s `Emitter`. */
export const BODY_EVENT_BITS: Partial<Record<keyof BodyEventMap, number>> = {
    collisionEnter: EventBit.collisionEnter,
    collisionPersist: EventBit.collisionPersist,
    collisionExit: EventBit.collisionExit,
    sensorEnter: EventBit.sensorEnter,
    sensorExit: EventBit.sensorExit,
    sleep: EventBit.sleep,
    wake: EventBit.wake,
    contactValidate: EventBit.contactValidate
};

/**
 * Bit assignment handed to the world `Emitter`. Step events are always dispatched, so they get
 * no bit.
 */
export const WORLD_EVENT_BITS: Partial<Record<keyof WorldEventMap, number>> = BODY_EVENT_BITS;

/**
 * Events emitted by a `SoftBodyState`'s own emitter (issue #245) - the soft-body counterpart of
 * {@link BodyEventMap}. Same names and the same pooled `CollisionEnterPayload` /
 * `CollisionExitPayload` / `SensorPayload` shapes a rigid body's events get: `target` is always
 * the soft body itself (`target.body` is `undefined`, `target.softBody` is set, `target.object`
 * is the mesh it drives) and `other` resolves against `BodySystem` or `SoftBodySystem` exactly
 * like a rigid contact's `other` does.
 *
 * There is no `sleep` / `wake` - soft bodies have no sleep story yet (see `soft-body-system.ts`)
 * - and `contactValidate` carries {@link SoftBodyValidatePayload} rather than `ValidatePayload`,
 * since Jolt gives the soft body validate callback no `baseOffset`.
 */
export type SoftBodyEventMap = {
    collisionEnter: (payload: CollisionEnterPayload) => void;
    collisionPersist: (payload: CollisionEnterPayload) => void;
    collisionExit: (payload: CollisionExitPayload) => void;
    sensorEnter: (payload: SensorPayload) => void;
    sensorExit: (payload: SensorPayload) => void;
    /**
     * Runs *synchronously inside* `joltInterface.Step()`, once per (soft body, other body)
     * bounding box overlap. Return `false` to reject the contact for this step. Must be fast and
     * must not touch bodies - see docs/events.md.
     */
    contactValidate: (payload: SoftBodyValidatePayload) => boolean | void;
};

/**
 * Bit assignment handed to a `SoftBodyState`'s `Emitter`. Reuses the same bit values as
 * {@link BODY_EVENT_BITS} - a bit only has to be unique within the one `Emitter` instance it
 * backs, and a soft body's emitter is never the same instance as a rigid body's.
 */
export const SOFT_BODY_EVENT_BITS: Partial<Record<keyof SoftBodyEventMap, number>> = {
    collisionEnter: EventBit.collisionEnter,
    collisionPersist: EventBit.collisionPersist,
    collisionExit: EventBit.collisionExit,
    sensorEnter: EventBit.sensorEnter,
    sensorExit: EventBit.sensorExit,
    contactValidate: EventBit.contactValidate
};
