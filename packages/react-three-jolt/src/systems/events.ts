/**
 * Event names, payload shapes and the dispatch bitfield shared by the world (`PhysicsSystem`)
 * and per body (`BodyState`) emitters. See docs/events.md.
 */

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

/** Events emitted by `physicsSystem.events`. */
export type WorldEventMap = {
    beforeStep: StepCallback;
    afterStep: StepCallback;
};

/**
 * Bit assignment handed to the world `Emitter`. Step events are always dispatched, so they get
 * no bit; the contact events added in T2 do.
 */
export const WORLD_EVENT_BITS: Partial<Record<keyof WorldEventMap, number>> = {};
