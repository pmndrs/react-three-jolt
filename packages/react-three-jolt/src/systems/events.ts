/**
 * Event names, payload shapes and the dispatch bitfield shared by the world (`PhysicsSystem`)
 * and per body (`BodyState`) emitters. See docs/events.md.
 */

import type { Object3D, Vector3 } from 'three';
import type { BodyState } from './body-state';

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
    motionSource: 1 << 8
} as const;

/** Any of the contact driven bits - if none of these are set, contacts cost nothing. */
export const CONTACT_BITS =
    EventBit.collisionEnter |
    EventBit.collisionPersist |
    EventBit.collisionExit |
    EventBit.sensorEnter |
    EventBit.sensorExit |
    EventBit.motionSource;

/** Bits needed while a contact is being *added* or *persisted* (manifold/settings wrapping). */
export const MANIFOLD_BITS =
    EventBit.collisionEnter |
    EventBit.collisionPersist |
    EventBit.sensorEnter |
    EventBit.motionSource;

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
}

export interface CollisionPayload {
    /** The body the handler is registered on. World level handlers get the lower `handle`. */
    target: CollisionTarget;
    other: CollisionTarget;
    /** True when `target` is Jolt's body 2 for this pair. */
    flipped: boolean;
    /** Sub-shape manifolds currently open between the two bodies. */
    contactCount: number;
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
