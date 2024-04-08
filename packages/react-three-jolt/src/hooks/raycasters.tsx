// creates a jolt constrain given two bodies
import { Jolt } from 'jolt-physics';
import { useJolt } from './';
import { Raw } from '../raw';
import { useEffect, useMemo, useRef, Ref } from 'react';
import { useImperativeInstance } from './use-imperative-instance';
import { PhysicsSystem } from '../systems/physics-system';
import {
    Raycaster,
    AdvancedRaycaster,
    Multicaster
} from '../systems/raycasters';

// helper function to take a list of bodies and add them to the same filter group

export const useRaycaster = (
    origin?: THREE.Vector3 | number[] | null,
    direction?: THREE.Vector3 | number[] | null,
    type?: string
) => {
    const { jolt, physicsSystem } = useJolt();
    //const raycaster = useRef<Raycaster | null>(null);
    const raycaster: Raycaster = useMemo(() => {
        const caster = physicsSystem.getRaycaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);

        return caster;
    }, [origin, direction, type]);
    /* lets try with a memo first
    useImperativeInstance(
        () => {
            raycaster.current = physicsSystem.getRaycaster();
        if (origin) raycaster.current.origin = origin;
        if (direction) raycaster.current.direction = direction;

        },
        (rawConstraint) => {
            //  physicsSystem.constraintSystem.removeConstraint(rawConstraint);
        },
        []
    );
    */
    return raycaster;
};

export const useAdvancedRaycaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type: string
) => {
    const { jolt, physicsSystem } = useJolt();
    const raycaster: AdvancedRaycaster = useMemo(() => {
        const caster = physicsSystem.getAdvancedRaycaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);

        return caster;
    }, [origin, direction, type]);
    return raycaster;
};

export const useMulticaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type?: string
) => {
    const { jolt, physicsSystem } = useJolt();
    const raycaster: Multicaster = useMemo(() => {
        const caster = physicsSystem.getMulticaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);
        return caster;
    }, [origin, direction, type]);
    return raycaster;
};
