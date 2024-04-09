// creates a jolt constrain given two bodies
import { useJolt } from './hooks';
import { useRef, Ref } from 'react';
import { useImperativeInstance } from './use-imperative-instance';

// for types
import { BodyState } from '../systems';

// helper function to take a list of bodies and add them to the same filter group

export const useConstraint = (
    type: string,
    body1: Ref<BodyState>,
    body2: Ref<BodyState>,
    options?: any
) => {
    const { physicsSystem } = useJolt();
    const constraint = useRef(null);

    useImperativeInstance(
        () => {
            //@ts-ignore
            if (!body1.current || !body2.current) return;
            physicsSystem.constraintSystem.addConstraint(
                type,
                //@ts-ignore
                body1.current,
                //@ts-ignore
                body2.current,
                options
            );
        },
        () => {
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
