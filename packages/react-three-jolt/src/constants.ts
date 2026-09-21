// constants for the physics system

/**
 * Jolt object layers: the *broad* collision filter. Which pairs actually collide is set up in
 * `PhysicsSystem`'s constructor through an `ObjectLayerPairFilterTable`, which starts with
 * everything disabled.
 *
 * `KINEMATIC` bodies (`generateBodySettings` in `body-system.ts`) get their own object layer
 * rather than sharing `MOVING`, so they can be filtered independently. The pair filter enables
 * `KINEMATIC` against `NON_MOVING`, `MOVING` and itself, so a kinematic platform still collides
 * with static geometry, dynamic bodies and other kinematic bodies (issue #210). It shares the
 * `MOVING` broad phase layer (see `bpInterface.MapObjectToBroadPhaseLayer` below) since it moves
 * every frame the same way a dynamic body does.
 *
 * The pair filter is necessary but not sufficient for the `KINEMATIC` vs `NON_MOVING`/`KINEMATIC`
 * pairs: Jolt only runs narrowphase on a pair when at least one side is Dynamic, so
 * `generateBodySettings` also sets `BodyCreationSettings.mCollideKinematicVsNonDynamic` on every
 * kinematic body, or a moving platform would silently pass through static geometry and other
 * kinematic bodies no matter how this table is configured.
 */
export const Layer = {
    MOVING: 0,
    NON_MOVING: 1,
    KINEMATIC: 2,
    RIG: 3
};

/**
 * Size of every object-layer indexed table (`ObjectLayerPairFilterTable`,
 * `BroadPhaseLayerInterfaceTable`, `ObjectVsBroadPhaseLayerFilterTable`).
 *
 * This MUST be `max(Layer) + 1`. It was 3 while `Layer` had four members (issue #95), so
 * `MapObjectToBroadPhaseLayer(Layer.RIG, ...)` wrote one entry past the end of a three element
 * array, and the pair filter's bit indices aliased unrelated layer pairs - Jolt only bounds
 * checks these with an assert, which is compiled out of the release wasm.
 */
export const NUM_OBJECT_LAYERS = Math.max(...Object.values(Layer)) + 1;

/** `MOVING` / `NON_MOVING` / `RIG` broad phase layers. */
export const NUM_BROAD_PHASE_LAYERS = 3;
