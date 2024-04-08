// creates a jolt constrain given two bodies
import { Jolt } from 'jolt-physics';
import { useJolt } from './';
import { Raw } from '../raw';
import { useEffect, useMemo, useRef, Ref } from 'react';
import { useImperativeInstance } from './use-imperative-instance';

// utils
import { vec3 } from '../utils';

// for types
import { BodyState } from '../systems/body-system';

// helper function to take a list of bodies and add them to the same filter group

export const useConstraint = (
    type: string,
    body1: Ref<BodyState>,
    body2: Ref<BodyState>,
    options?
) => {
    const { jolt, physicsSystem } = useJolt();
    const constraint = useRef(null);

    useImperativeInstance(
        () => {
            if (!body1.current || !body2.current) return;
            physicsSystem.constraintSystem.addConstraint(
                type,
                body1.current,
                body2.current,
                options
            );
        },
        (rawConstraint) => {
            //  physicsSystem.constraintSystem.removeConstraint(rawConstraint);
        },
        []
    );
    return constraint;

    /* original
    const constraint = useMemo(() => {
        console.log('Running use constraint', body1, body2);
        if (!body1 || !body2) return;
        physicsSystem.constraintSystem.addConstraint(
            type,
            body1,
            body2,
            options
        );
    }, [body1, body2, type, options]);
    

    return constraint;
    */
};
