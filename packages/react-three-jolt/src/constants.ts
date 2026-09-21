// constants for the physics system

/**
 * Jolt object layers: the *broad* collision filter. Which pairs actually collide is set up in
 * `PhysicsSystem`'s constructor through an `ObjectLayerPairFilterTable`, which starts with
 * everything disabled.
 *
 * `KINEMATIC` is reserved: kinematic bodies are currently created on `MOVING` (see
 * `body-system.ts`), but the id stays allocated so existing user code that references it keeps
 * working and so the filter tables are sized for it.
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
