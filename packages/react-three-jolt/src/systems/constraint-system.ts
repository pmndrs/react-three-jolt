// class to control and manage constraints
// designed to be used from the body system although it can be accessed directly

import type Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { type anyVec3, vec3 } from '../utils';
import type { BodyState } from './body-state';
import type { PhysicsSystem } from './physics-system';

//* Public types =====================================================

/**
 * Every constraint type `addConstraint` understands, mapped to the Jolt class the
 * returned constraint is cast to. `revolute`/`prismatic` are aliases for
 * `hinge`/`slider` kept for parity with other physics libraries.
 */
export interface ConstraintTypeMap {
    fixed: Jolt.TwoBodyConstraint;
    point: Jolt.PointConstraint;
    distance: Jolt.DistanceConstraint;
    hinge: Jolt.HingeConstraint;
    revolute: Jolt.HingeConstraint;
    slider: Jolt.SliderConstraint;
    prismatic: Jolt.SliderConstraint;
    cone: Jolt.ConeConstraint;
    swingTwist: Jolt.SwingTwistConstraint;
    sixDOF: Jolt.SixDOFConstraint;
}
export type ConstraintType = keyof ConstraintTypeMap;

export type ConstraintAxis = 'x' | 'y' | 'z';

export interface ConstraintSpringOptions {
    /** frequency in Hz, or stiffness when `mode` is `'stiffness'` */
    strength?: number;
    damping?: number;
    mode?: 'frequency' | 'stiffness';
}

export interface ConstraintMotorOptions {
    /** `'velocity'` drives at a constant speed, `'position'` drives towards `target` */
    type?: 'velocity' | 'position';
    /** target velocity: rad/s for a hinge, m/s for a slider */
    velocity?: number;
    /** target position: radians for a hinge, meters for a slider */
    target?: number;
    /** force limits (slider) applied to the constraint's `MotorSettings` */
    minForce?: number;
    maxForce?: number;
    /** torque limits (hinge) applied to the constraint's `MotorSettings` */
    minTorque?: number;
    maxTorque?: number;
    /** spring the motor uses to reach its target */
    spring?: ConstraintSpringOptions;
}

export interface ConstraintOptions {
    /** world (or local, see `space`) anchor on body 1 */
    point1?: anyVec3;
    /** world (or local) anchor on body 2. Defaults to `point1` where the constraint allows it */
    point2?: anyVec3;
    /** shared anchor for `swingTwist` / `sixDOF` */
    position?: anyVec3;
    /** hinge/slider axis */
    axis?: anyVec3;
    /** reference axis perpendicular to `axis` (hinge) */
    normal?: anyVec3;
    twistAxis?: anyVec3;
    planeAxis?: anyVec3;
    /** lower limit: meters for slider/distance, radians for hinge */
    min?: number;
    /** upper limit: meters for slider/distance, radians for hinge */
    max?: number;
    /** full cone angle in radians (cone) */
    angle?: number;
    normalConeAngle?: number;
    planeConesAngle?: number;
    twistMin?: number;
    twistMax?: number;
    maxFrictionTorque?: number;
    maxFrictionForce?: number;
    /** `'local'` switches to `EConstraintSpace_LocalToBodyCOM`. Dangerous, see below */
    space?: 'local' | 'world';
    spring?: ConstraintSpringOptions;
    motor?: ConstraintMotorOptions;
    // sixDOF only ---
    fixedTranslationAxis?: ConstraintAxis[];
    fixedRotationAxis?: ConstraintAxis[];
    limitedTranslationAxis?: ConstraintAxis[];
    limitedRotationAxis?: ConstraintAxis[];
    limits?: Record<string, number | undefined>;
    /** per-axis friction, in `SixDOFConstraintSettings::EAxis` order */
    friction?: number[];
    limitShape?: 'cone' | 'pyramid';
}

/** what the system tracks for every live constraint */
export interface ConstraintRecord {
    /** the base-class wrapper `Create()` returned */
    constraint: Jolt.Constraint;
    /** the subclass wrapper the caller was handed, which is what comes back on removal */
    casted: Jolt.Constraint;
    type: ConstraintType;
    bodyHandles: number[];
}

/**
 * The binder keeps one JS wrapper per (pointer, class) pair, so a constraint allocated at a
 * freed constraint's address is handed the *old* wrapper - which would make a stale handle
 * indistinguishable from the live one. Dropping the cache entries when we free a constraint
 * keeps wrapper identity meaningful (and stops the wrappers accumulating).
 */
// biome-ignore lint/suspicious/noExplicitAny: `getCache` is a binder internal with no typing
type BinderClass = new (...args: any[]) => unknown;
interface BinderModule {
    getCache(Class: BinderClass): Record<number, unknown>;
}

//* Internal structural helpers ======================================
// The Jolt settings classes have no common base for these members, so the shared
// tail of `addConstraint` is typed against the shape it actually touches.
interface HasPoints {
    mPoint1: Jolt.RVec3;
    mPoint2: Jolt.RVec3;
}
interface HasPositions {
    mPosition1: Jolt.RVec3;
    mPosition2: Jolt.RVec3;
}
interface HasLimitsSpring {
    mLimitsSpringSettings: Jolt.SpringSettings;
}
interface HasMotor {
    mMotorSettings: Jolt.MotorSettings;
}
interface HasSpace {
    mSpace: Jolt.EConstraintSpace;
}

/**
 * jolt-physics uses the WebIDL binder, where a C++ method returning BY VALUE
 * (`Body.GetPosition()`, `Vec3.Normalized()`, a settings getter, ...) hands back a pointer
 * to a single shared static temporary. Those must never be destroyed and are invalidated by
 * the next call, so these two read the components out immediately and hand back a fresh
 * object we own. They are deliberately local rather than `vec3.jolt()`/`vec3.rjolt()`: this
 * file frees everything it allocates, so it must never be handed a caller's own vector.
 */
const ownedVec3 = (value: anyVec3): Jolt.Vec3 => {
    const v = vec3.three(value);
    return new Raw.module.Vec3(v.x, v.y, v.z);
};
const ownedRVec3 = (value: anyVec3): Jolt.RVec3 => {
    const v = vec3.three(value);
    return new Raw.module.RVec3(v.x, v.y, v.z);
};

/**
 * Everything allocated while building a constraint goes in here and is freed once the
 * constraint exists. Jolt copies each value into the settings struct on assignment, so the
 * temporaries are dead the moment they have been handed over.
 *
 * Only ever track objects made with `new Raw.module.X()` (which is all `ownedVec3` and
 * friends produce). Anything jolt returned is borrowed or a shared static and destroying it
 * is a double free.
 */
class Temporaries {
    private items: unknown[] = [];
    track<T>(item: T): T {
        this.items.push(item);
        return item;
    }
    release(): void {
        for (const item of this.items) Raw.module.destroy(item);
        this.items.length = 0;
    }
}

export class ConstraintSystem {
    physicsSystem: PhysicsSystem;
    joltPhysicsSystem: Jolt.PhysicsSystem;

    /** every live constraint, keyed by its wasm pointer */
    readonly constraints = new Map<number, ConstraintRecord>();
    /** body handle -> pointers of the constraints referencing it */
    private bodyIndex = new Map<number, Set<number>>();

    constructor(physicSystem: PhysicsSystem) {
        this.physicsSystem = physicSystem;
        this.joltPhysicsSystem = physicSystem.physicsSystem;
    }

    //* Creation ======================================================
    addConstraint<T extends ConstraintType>(
        type: T,
        body1: BodyState,
        body2: BodyState,
        options?: ConstraintOptions
    ): ConstraintTypeMap[T] {
        if (this.physicsSystem.destroyed)
            throw new Error('r3/jolt: cannot add a constraint to a destroyed PhysicsSystem');
        const temps = new Temporaries();
        let settings: Jolt.TwoBodyConstraintSettings | undefined;
        try {
            settings = this.createSettings(type, body1, body2, options, temps);
            //* Actually create the constraint ----------------
            const constraint = settings.Create(body1.body, body2.body);
            // `Create` hands back a RefTarget with a zero refcount. Take our own reference so
            // the constraint survives until `removeConstraint` releases it; `AddConstraint`
            // takes a second one and `RemoveConstraint` gives that one back.
            constraint.AddRef();
            this.joltPhysicsSystem.AddConstraint(constraint);

            const casted = this.castConstraint(type, constraint);
            // now that the constraint exists we can drive its motor
            this.applyMotorState(type, casted, options);

            this.register(constraint, casted, type, body1, body2);
            return casted;
        } finally {
            // jolt has copied everything it needs into the constraint by now
            if (settings) Raw.module.destroy(settings);
            temps.release();
        }
    }

    private createSettings<T extends ConstraintType>(
        type: T,
        body1: BodyState,
        body2: BodyState,
        options: ConstraintOptions | undefined,
        temps: Temporaries
    ): Jolt.TwoBodyConstraintSettings {
        switch (type) {
            //* Fixed -------------------------------------
            case 'fixed': {
                const settings = new Raw.module.FixedConstraintSettings();
                if (!options?.point1 && !options?.point2) {
                    // let jolt work the anchor out from the current body transforms
                    settings.mAutoDetectPoint = true;
                } else {
                    this.applyPoints(settings, body1, body2, options, temps);
                }
                this.applySpace(settings, options);
                return settings;
            }

            //* Point -------------------------------------
            // point constraints fix movement but NOT rotation
            case 'point': {
                const settings = new Raw.module.PointConstraintSettings();
                this.applyPoints(settings, body1, body2, options, temps, true);
                this.applySpace(settings, options);
                return settings;
            }

            //* Distance ----------------------------------
            case 'distance': {
                const settings = new Raw.module.DistanceConstraintSettings();
                // this constraint does not do autoPoints
                // if there is no min set, use the distance between the two points
                settings.mMinDistance = options?.min ?? -1;
                // max is totally optional
                if (options?.max !== undefined) settings.mMaxDistance = options.max;
                this.applyPoints(settings, body1, body2, options, temps);
                this.applySpring(settings, options, temps);
                this.applySpace(settings, options);
                return settings;
            }

            //* Revolute/Hinge -----------------------------
            case 'revolute':
            case 'hinge': {
                const settings = new Raw.module.HingeConstraintSettings();
                // the axis is from the point. so which item its rotating on
                settings.mHingeAxis1 = settings.mHingeAxis2 = temps.track(
                    options?.axis ? ownedVec3(options.axis) : new Raw.module.Vec3(1, 0, 0)
                );
                // jolt needs a reference direction perpendicular to the hinge axis to
                // measure the limit angles against
                settings.mNormalAxis1 = settings.mNormalAxis2 = temps.track(
                    options?.normal ? ownedVec3(options.normal) : new Raw.module.Vec3(0, 1, 0)
                );
                // the rest of these are optional
                // In Radians
                if (options?.min !== undefined) settings.mLimitsMin = options.min;
                if (options?.max !== undefined) settings.mLimitsMax = options.max;
                if (options?.maxFrictionTorque !== undefined)
                    settings.mMaxFrictionTorque = options.maxFrictionTorque;

                this.applyPoints(settings, body1, body2, options, temps, true);
                this.applySpring(settings, options, temps);
                this.applyMotorSettings(settings, options, temps);
                this.applySpace(settings, options);
                return settings;
            }

            //* Slider/Prismatic ---------------------------
            case 'prismatic':
            case 'slider': {
                const settings = new Raw.module.SliderConstraintSettings();
                // the axis to slide along. This really is required but we'll add a fallback
                const axis = temps.track(
                    options?.axis ? ownedVec3(options.axis) : new Raw.module.Vec3(0, 0, 1)
                );
                // `Normalized()` and `GetNormalizedPerpendicular()` return jolt's shared scratch
                // object, so assign straight through (which copies) and never free the result.
                settings.mSliderAxis1 = settings.mSliderAxis2 = axis.Normalized();
                // the normal axis is perpendicular to the slider axis
                settings.mNormalAxis1 = settings.mNormalAxis2 =
                    settings.mSliderAxis1.GetNormalizedPerpendicular();
                // the rest of these are optional
                if (options?.min !== undefined) settings.mLimitsMin = options.min;
                if (options?.max !== undefined) settings.mLimitsMax = options.max;
                if (options?.maxFrictionForce !== undefined)
                    settings.mMaxFrictionForce = options.maxFrictionForce;

                this.applyPoints(settings, body1, body2, options, temps, true);
                this.applySpring(settings, options, temps);
                this.applyMotorSettings(settings, options, temps);
                this.applySpace(settings, options);
                return settings;
            }

            //* Cone -------------------------------------
            case 'cone': {
                const settings = new Raw.module.ConeConstraintSettings();
                settings.mTwistAxis1 = settings.mTwistAxis2 = temps.track(
                    options?.twistAxis ? ownedVec3(options.twistAxis) : new Raw.module.Vec3(0, 1, 0)
                );
                if (options?.angle !== undefined) settings.mHalfConeAngle = options.angle / 2;
                this.applyPoints(settings, body1, body2, options, temps, true);
                this.applySpace(settings, options);
                return settings;
            }

            //* SwingTwist --------------------------------
            //This one is pretty complex
            case 'swingTwist': {
                const settings = new Raw.module.SwingTwistConstraintSettings();
                this.applyPositions(settings, body1, options, temps);
                settings.mTwistAxis1 = settings.mTwistAxis2 = temps.track(
                    options?.twistAxis ? ownedVec3(options.twistAxis) : new Raw.module.Vec3(0, 1, 0)
                );
                settings.mPlaneAxis1 = settings.mPlaneAxis2 = temps.track(
                    options?.planeAxis ? ownedVec3(options.planeAxis) : new Raw.module.Vec3(1, 0, 0)
                );
                // all angles are in radians
                if (options?.normalConeAngle !== undefined)
                    settings.mNormalHalfConeAngle = options.normalConeAngle / 2;
                if (options?.planeConesAngle !== undefined)
                    settings.mPlaneHalfConeAngle = options.planeConesAngle / 2;
                if (options?.twistMin !== undefined) settings.mTwistMinAngle = options.twistMin;
                if (options?.twistMax !== undefined) settings.mTwistMaxAngle = options.twistMax;
                if (options?.maxFrictionTorque !== undefined)
                    settings.mMaxFrictionTorque = options.maxFrictionTorque;
                if (options?.limitShape === 'pyramid')
                    settings.mSwingType = Raw.module.ESwingType_Pyramid;
                this.applySpace(settings, options);
                return settings;
            }

            //*** */ This is the most complex standard constraint
            case 'sixDOF': {
                const settings = new Raw.module.SixDOFConstraintSettings();
                this.applyPositions(settings, body1, options, temps);
                //not sure these need to be changable so we will fix them
                settings.mAxisX1 = settings.mAxisX2 = temps.track(new Raw.module.Vec3(0, 0, 1));
                settings.mAxisY1 = settings.mAxisY2 = temps.track(new Raw.module.Vec3(1, 0, 0));
                this.applySixDOFAxes(settings, options);
                // sixDOF has friction but it's weird.
                if (options?.friction)
                    // because I'm lazy, im making the user do a full array
                    options.friction.forEach((value, index) =>
                        settings.set_mMaxFriction(index, value)
                    );
                // if the limiter is a pyramid
                if (options?.limitShape === 'pyramid')
                    settings.mSwingType = Raw.module.ESwingType_Pyramid;
                this.applySpring(settings, options, temps);
                this.applySpace(settings, options);
                return settings;
            }

            default:
                throw new Error(`r3/jolt: unknown constraint type "${type}"`);
        }
    }

    //* Shared settings helpers =======================================

    /** `Body.GetPosition()` returns jolt's shared static; copy it out before anything else */
    private bodyPosition(body: BodyState, temps: Temporaries): Jolt.RVec3 {
        return temps.track(ownedRVec3(body.body.GetPosition()));
    }

    // replicates autoPoints with body position
    private applyPoints(
        settings: HasPoints,
        body1: BodyState,
        body2: BodyState,
        options: ConstraintOptions | undefined,
        temps: Temporaries,
        point2DefaultsToPoint1 = false
    ): void {
        settings.mPoint1 = options?.point1
            ? temps.track(ownedRVec3(options.point1))
            : this.bodyPosition(body1, temps);
        // some constraints are happy anchoring both bodies at the same spot
        const point2 = options?.point2 ?? (point2DefaultsToPoint1 ? options?.point1 : undefined);
        settings.mPoint2 = point2
            ? temps.track(ownedRVec3(point2))
            : this.bodyPosition(body2, temps);
    }

    private applyPositions(
        settings: HasPositions,
        body1: BodyState,
        options: ConstraintOptions | undefined,
        temps: Temporaries
    ): void {
        settings.mPosition1 = settings.mPosition2 = options?.position
            ? temps.track(ownedRVec3(options.position))
            : this.bodyPosition(body1, temps);
    }

    private applySpring(
        settings: HasLimitsSpring,
        options: ConstraintOptions | undefined,
        temps: Temporaries
    ): void {
        if (!options?.spring) return;
        settings.mLimitsSpringSettings = temps.track(
            this.createSpringSettings(
                options.spring.strength,
                options.spring.damping,
                options.spring.mode
            )
        );
    }

    private applyMotorSettings(
        settings: HasMotor,
        options: ConstraintOptions | undefined,
        temps: Temporaries
    ): void {
        const motor = options?.motor;
        if (!motor) return;
        // only worth building when something other than the target was asked for
        if (
            motor.minForce === undefined &&
            motor.maxForce === undefined &&
            motor.minTorque === undefined &&
            motor.maxTorque === undefined &&
            !motor.spring
        )
            return;
        settings.mMotorSettings = temps.track(this.createMotorSettings(motor));
    }

    // WARNING: Messing with space is dangerous and requires understanding
    // It WILL break stuff switching to local space
    private applySpace(settings: HasSpace, options: ConstraintOptions | undefined): void {
        if (options?.space === 'local')
            settings.mSpace = Raw.module.EConstraintSpace_LocalToBodyCOM;
    }

    // go over the options for fixed and limited constraints, remove from free
    private applySixDOFAxes(
        settings: Jolt.SixDOFConstraintSettings,
        options: ConstraintOptions | undefined
    ): void {
        const all: ConstraintAxis[] = ['x', 'y', 'z'];
        const fixedTranslation = options?.fixedTranslationAxis ?? [];
        const fixedRotation = options?.fixedRotationAxis ?? [];
        const limitedTranslation = options?.limitedTranslationAxis ?? [];
        const limitedRotation = options?.limitedRotationAxis ?? [];
        const freeTranslation = all.filter(
            (axis) => !fixedTranslation.includes(axis) && !limitedTranslation.includes(axis)
        );
        const freeRotation = all.filter(
            (axis) => !fixedRotation.includes(axis) && !limitedRotation.includes(axis)
        );

        for (const axis of freeTranslation) settings.MakeFreeAxis(this.getEaxis(axis));
        for (const axis of freeRotation) settings.MakeFreeAxis(this.getEaxis(axis, 'rotation'));
        for (const axis of fixedTranslation) settings.MakeFixedAxis(this.getEaxis(axis));
        for (const axis of fixedRotation) settings.MakeFixedAxis(this.getEaxis(axis, 'rotation'));
        // limited axis are a bit different
        const limits = options?.limits ?? {};
        for (const axis of limitedTranslation) {
            const key = axis.toUpperCase();
            settings.SetLimitedAxis(
                this.getEaxis(axis),
                limits[`min${key}`] ?? 0,
                limits[`max${key}`] ?? 0
            );
        }
        for (const axis of limitedRotation) {
            const key = axis.toUpperCase();
            settings.SetLimitedAxis(
                this.getEaxis(axis, 'rotation'),
                limits[`minAngle${key}`] ?? 0,
                limits[`maxAngle${key}`] ?? 0
            );
        }
    }

    //* Casting and motors ============================================

    /** the binder class a constraint of this type is wrapped in, or null for the base class */
    private constraintClass(type: ConstraintType): BinderClass | null {
        const jolt = Raw.module;
        switch (type) {
            case 'prismatic':
            case 'slider':
                return jolt.SliderConstraint as unknown as BinderClass;
            case 'point':
                return jolt.PointConstraint as unknown as BinderClass;
            case 'distance':
                return jolt.DistanceConstraint as unknown as BinderClass;
            case 'hinge':
            case 'revolute':
                return jolt.HingeConstraint as unknown as BinderClass;
            case 'sixDOF':
                return jolt.SixDOFConstraint as unknown as BinderClass;
            case 'cone':
                return jolt.ConeConstraint as unknown as BinderClass;
            case 'swingTwist':
                return jolt.SwingTwistConstraint as unknown as BinderClass;
            // jolt has no `FixedConstraint` binding, the base class is all there is
            default:
                return null;
        }
    }

    // for various reasons we need to cast the constraint to the correct type
    private castConstraint<T extends ConstraintType>(
        type: T,
        constraint: Jolt.Constraint
    ): ConstraintTypeMap[T] {
        const Class = this.constraintClass(type);
        if (!Class) return constraint as ConstraintTypeMap[T];
        return Raw.module.castObject(constraint, Class) as ConstraintTypeMap[T];
    }

    /**
     * Drop the binder's cached JS wrappers for a freed constraint. Without this the next
     * constraint allocated at the same address is handed the dead constraint's wrapper, and
     * a stale handle becomes impossible to tell apart from a live one.
     */
    private forgetWrappers(record: ConstraintRecord, pointer: number): void {
        const binder = Raw.module as unknown as Partial<BinderModule>;
        if (typeof binder.getCache !== 'function') return;
        const classes = [
            Raw.module.Constraint as unknown as BinderClass,
            Raw.module.TwoBodyConstraint as unknown as BinderClass,
            this.constraintClass(record.type)
        ];
        for (const Class of classes) {
            if (!Class) continue;
            const cache = binder.getCache(Class);
            if (cache) delete cache[pointer];
        }
    }

    /**
     * Motors live on the constraint, not the settings. Hinges measure their target in
     * radians/rad-per-second and sliders in meters/meters-per-second, which is why the two
     * have differently named setters.
     */
    private applyMotorState<T extends ConstraintType>(
        type: T,
        constraint: ConstraintTypeMap[T],
        options: ConstraintOptions | undefined
    ): void {
        const motor = options?.motor;
        if (!motor) return;
        const isHinge = type === 'hinge' || type === 'revolute';
        const isSlider = type === 'slider' || type === 'prismatic';
        if (!isHinge && !isSlider) {
            if (this.physicsSystem.debug)
                console.warn(`r3/jolt: constraint type "${type}" has no motor support`);
            return;
        }

        if (isHinge) {
            const hinge = constraint as Jolt.HingeConstraint;
            if (motor.type === 'velocity') {
                hinge.SetMotorState(Raw.module.EMotorState_Velocity);
                if (motor.velocity !== undefined) hinge.SetTargetAngularVelocity(motor.velocity);
            } else {
                hinge.SetMotorState(Raw.module.EMotorState_Position);
                if (motor.target !== undefined) hinge.SetTargetAngle(motor.target);
            }
            return;
        }

        const slider = constraint as Jolt.SliderConstraint;
        if (motor.type === 'velocity') {
            slider.SetMotorState(Raw.module.EMotorState_Velocity);
            if (motor.velocity !== undefined) slider.SetTargetVelocity(motor.velocity);
        } else {
            slider.SetMotorState(Raw.module.EMotorState_Position);
            // target is a float along the axis
            if (motor.target !== undefined) slider.SetTargetPosition(motor.target);
        }
    }

    //* Registry ======================================================

    private register(
        constraint: Jolt.Constraint,
        casted: Jolt.Constraint,
        type: ConstraintType,
        body1: BodyState,
        body2: BodyState
    ): void {
        const pointer = Raw.module.getPointer(constraint);
        const bodyHandles = [body1.handle, body2.handle];
        this.constraints.set(pointer, { constraint, casted, type, bodyHandles });
        for (const handle of bodyHandles) {
            let pointers = this.bodyIndex.get(handle);
            if (!pointers) {
                pointers = new Set();
                this.bodyIndex.set(handle, pointers);
            }
            pointers.add(pointer);
        }
    }

    /**
     * Take a constraint out of the simulation and free it.
     *
     * Jolt owns constraints by reference count: `PhysicsSystem::RemoveConstraint` drops the
     * system's reference and `Release()` drops ours, which deletes the C++ object. Calling
     * `Raw.module.destroy()` on top of that is a double free and is what used to crash the
     * page (issue #82) - do not add it back.
     *
     * Safe to call with anything: an unknown or already-removed constraint is a no-op, and
     * so is a constraint whose world has already been torn down.
     *
     * @returns true when a constraint was actually removed
     */
    removeConstraint(constraint?: Jolt.Constraint | null): boolean {
        if (!constraint) return false;
        const pointer = Raw.module.getPointer(constraint);
        const record = this.constraints.get(pointer);
        if (!record) {
            // already gone (double cleanup, StrictMode remount, or a foreign constraint)
            if (this.physicsSystem.debug)
                console.warn('r3/jolt: removeConstraint called for an unknown constraint');
            return false;
        }
        if (constraint !== record.casted && constraint !== record.constraint) {
            // the address matches but the wrapper does not: this handle belongs to a
            // constraint we already freed, and a new one was allocated in its place
            if (this.physicsSystem.debug)
                console.warn('r3/jolt: removeConstraint called with a stale constraint');
            return false;
        }
        // drop the bookkeeping first so a re-entrant call cannot remove it twice
        this.constraints.delete(pointer);
        for (const handle of record.bodyHandles) {
            const pointers = this.bodyIndex.get(handle);
            if (!pointers) continue;
            pointers.delete(pointer);
            if (pointers.size === 0) this.bodyIndex.delete(handle);
        }

        // React destroys a parent's effects before its children's, so `<Physics>` unmounting
        // frees the JoltInterface - and with it every constraint - before the hooks that own
        // them get to clean up. Touching jolt here would trap in wasm (issue #82).
        if (this.physicsSystem.destroyed) return true;

        this.joltPhysicsSystem.RemoveConstraint(record.constraint);
        // matches the AddRef in addConstraint: this is what actually frees the constraint
        record.constraint.Release();
        this.forgetWrappers(record, pointer);
        return true;
    }

    /**
     * Remove every constraint referencing a body. Jolt dereferences both bodies while
     * detaching a constraint, so this has to run *before* the body is removed or destroyed
     * or the next step reads freed memory.
     *
     * @returns how many constraints were removed
     */
    removeConstraintsForBody(bodyHandle: number): number {
        const pointers = this.bodyIndex.get(bodyHandle);
        if (!pointers || pointers.size === 0) return 0;
        let removed = 0;
        for (const pointer of [...pointers]) {
            const record = this.constraints.get(pointer);
            if (record && this.removeConstraint(record.constraint)) removed++;
        }
        this.bodyIndex.delete(bodyHandle);
        if (removed && this.physicsSystem.debug)
            console.warn(
                `r3/jolt: removed ${removed} constraint(s) still attached to body ${bodyHandle}`
            );
        return removed;
    }

    /** Remove every constraint this system created. Used when tearing the world down. */
    removeAllConstraints(): number {
        let removed = 0;
        for (const record of [...this.constraints.values()])
            if (this.removeConstraint(record.constraint)) removed++;
        this.bodyIndex.clear();
        return removed;
    }

    //* Settings factories ============================================

    /**
     * Spring used by a constraint's limits or motor.
     *
     * The returned object is a plain wasm value: assign it to a settings member (which
     * copies) and destroy it, or hand it to `Raw.module.destroy` when you are done.
     */
    createSpringSettings(strength = 1, damping = 0.5, mode = 'frequency'): Jolt.SpringSettings {
        const springSettings = new Raw.module.SpringSettings();

        springSettings.mDamping = damping;
        // the default mode is frequency, only change if we want stiffness
        //NOTE: According to jolt docs, stiffness needs to be ALOT
        if (mode === 'stiffness') {
            springSettings.mMode = Raw.module.ESpringMode_StiffnessAndDamping;
            springSettings.mStiffness = strength;
        } else springSettings.mFrequency = strength;
        return springSettings;
    }

    /**
     * Motor limits for a constraint. Jolt keeps the *target* (speed or position) on the
     * constraint itself - see `applyMotorState` - so only the limits and the spring live here.
     * https://jrouwe.github.io/JoltPhysics/index.html#constraint-motors
     *
     * The caller owns the returned object and must destroy it (assigning it to a settings
     * member copies the value).
     */
    createMotorSettings(options: ConstraintMotorOptions = {}): Jolt.MotorSettings {
        const motorSettings = new Raw.module.MotorSettings();
        if (options.minForce !== undefined) motorSettings.mMinForceLimit = options.minForce;
        if (options.maxForce !== undefined) motorSettings.mMaxForceLimit = options.maxForce;
        if (options.minTorque !== undefined) motorSettings.mMinTorqueLimit = options.minTorque;
        if (options.maxTorque !== undefined) motorSettings.mMaxTorqueLimit = options.maxTorque;
        if (options.spring) {
            const spring = this.createSpringSettings(
                options.spring.strength,
                options.spring.damping,
                options.spring.mode
            );
            motorSettings.mSpringSettings = spring;
            Raw.module.destroy(spring);
        }
        return motorSettings;
    }

    // helper to get sixDof EAxis
    getEaxis(
        axis: ConstraintAxis,
        type: 'translation' | 'rotation' = 'translation'
    ): Jolt.SixDOFConstraintSettings_EAxis {
        const translation = type === 'translation';
        switch (axis) {
            case 'x':
                return translation
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationX
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationX;
            case 'y':
                return translation
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationY
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationY;
            case 'z':
                return translation
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationZ
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationZ;
            default:
                throw new Error(`r3/jolt: unknown sixDOF axis "${axis}"`);
        }
    }
}
