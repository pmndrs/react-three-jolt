export type Vector3Tuple = [number, number, number];
export type Vector4Tuple = [number, number, number, number] | number[];

export type PhysicsConfig = {
    timeStep: number | 'vary';
    interpolate: boolean;
    paused: boolean;
};

// `BodyEvents` and `WorldEvents` used to live here. They were unreachable - `index.ts` only
// ever re-exported the two tuple types - and described handler signatures that never matched
// what was dispatched. The real ones are `BodyEventMap` / `WorldEventMap` in
// `systems/events.ts`, alongside the payload types, and they are exported.
export type {
    ActivationPayload,
    BodyEventMap,
    CollisionEnterPayload,
    CollisionExitPayload,
    CollisionPayload,
    CollisionTarget,
    SensorPayload,
    StepCallback,
    ValidatePayload,
    WorldEventMap
} from './systems/events';
