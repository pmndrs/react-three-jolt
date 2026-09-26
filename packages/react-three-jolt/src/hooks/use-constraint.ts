// creates a jolt constrain given two bodies

import { useMemo, useRef } from 'react';
// for types
import type { BodyState, ConstraintOptions, ConstraintType, ConstraintTypeMap } from '../systems';
import { useJolt } from './hooks';
import { useImperativeInstance } from './use-imperative-instance';

/**
 * Anything ref-like holding a `BodyState`. Deliberately structural so a plain
 * `useRef(null)` passed straight from a `<RigidBody ref={...}>` still fits.
 */
export type BodyStateRef = { readonly current: BodyState | null | undefined };

/**
 * Anything ref-like holding a constraint (e.g., a HingeConstraint, SliderConstraint).
 * Can be either a ref or the constraint itself.
 */
export type ConstraintRef<T = unknown> =
    { readonly current: T | null | undefined } | T | null | undefined;

/**
 * Dereference a constraint ref that may be either a ref object or the constraint itself.
 */
const dereferenceConstraintRef = <T>(ref: ConstraintRef<T>): T | null | undefined => {
    if (!ref) return ref as null | undefined;
    if (typeof ref === 'object' && 'current' in ref) {
        return (ref as { current: T | null | undefined }).current;
    }
    return ref as T;
};

/**
 * Create a constraint between two bodies and keep it alive for the lifetime of the
 * component. The constraint is removed from the physics system on unmount, and re-created
 * when the type, the bodies or the option *values* change.
 *
 * For dependent constraints (gear/rackAndPinion), `hinge1`, `hinge2`, `hinge`, and `slider`
 * options can be either the constraint itself or a ref to it. Refs are dereferenced lazily
 * inside the effect, allowing dependent constraints to be created after their dependencies.
 */
export const useConstraint = <T extends ConstraintType>(
    type: T,
    body1: BodyStateRef,
    body2: BodyStateRef,
    options?: ConstraintOptions
) => {
    const { physicsSystem } = useJolt();
    const constraint = useRef<ConstraintTypeMap[T] | null>(null);

    // options are nearly always an inline object literal, so compare by value: keying the
    // effect on the identity would rebuild the constraint on every single render.
    // For dependent constraint refs, we compare by identity rather than stringify.
    const optionsKey = useMemo(() => {
        if (!options) return 'null';
        // Extract refs for dependent constraints, compare by identity
        const deps = {
            hinge1: options.hinge1,
            hinge2: options.hinge2,
            hinge: options.hinge,
            slider: options.slider
        };
        // For everything else, stringify by value
        const other = { ...options };
        delete other.hinge1;
        delete other.hinge2;
        delete other.hinge;
        delete other.slider;
        return (
            JSON.stringify(other) +
            '_' +
            JSON.stringify(deps, (_, v) => {
                // Mark refs by identity, not value
                if (typeof v === 'object' && v !== null && 'current' in v) return '<<ref>>';
                return v;
            })
        );
    }, [options]);

    useImperativeInstance<ConstraintTypeMap[T] | null>(
        () => {
            if (!body1.current || !body2.current) {
                if (physicsSystem.debug)
                    console.warn('r3/jolt: useConstraint skipped, a body ref was empty');
                return null;
            }

            // Dereference dependent constraint refs before passing to addConstraint
            const resolvedOptions = options ? { ...options } : undefined;
            if (resolvedOptions) {
                if (resolvedOptions.hinge1) {
                    resolvedOptions.hinge1 = dereferenceConstraintRef(
                        resolvedOptions.hinge1
                    ) as any;
                }
                if (resolvedOptions.hinge2) {
                    resolvedOptions.hinge2 = dereferenceConstraintRef(
                        resolvedOptions.hinge2
                    ) as any;
                }
                if (resolvedOptions.hinge) {
                    resolvedOptions.hinge = dereferenceConstraintRef(resolvedOptions.hinge) as any;
                }
                if (resolvedOptions.slider) {
                    resolvedOptions.slider = dereferenceConstraintRef(
                        resolvedOptions.slider
                    ) as any;
                }
            }

            const newConstraint = physicsSystem.constraintSystem.addConstraint(
                type,
                body1.current,
                body2.current,
                resolvedOptions
            );
            constraint.current = newConstraint;
            return newConstraint;
        },
        (instance) => {
            // `instance` is the constraint this effect created, so a StrictMode double
            // invoke tears down exactly what it made. removeConstraint is idempotent.
            physicsSystem.constraintSystem.removeConstraint(instance);
            if (constraint.current === instance) constraint.current = null;
        },
        [physicsSystem, type, body1, body2, optionsKey]
    );

    return constraint;
};
