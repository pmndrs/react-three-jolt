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
 * Create a constraint between two bodies and keep it alive for the lifetime of the
 * component. The constraint is removed from the physics system on unmount, and re-created
 * when the type, the bodies or the option *values* change.
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
    const optionsKey = useMemo(() => JSON.stringify(options ?? null), [options]);

    useImperativeInstance<ConstraintTypeMap[T] | null>(
        () => {
            if (!body1.current || !body2.current) {
                if (physicsSystem.debug)
                    console.warn('r3/jolt: useConstraint skipped, a body ref was empty');
                return null;
            }
            const newConstraint = physicsSystem.constraintSystem.addConstraint(
                type,
                body1.current,
                body2.current,
                options
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
