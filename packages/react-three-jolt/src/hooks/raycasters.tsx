// creates a jolt constrain given two bodies
import { useJolt } from './';
import { useMemo } from 'react';
import * as THREE from 'three';
import { Raycaster, AdvancedRaycaster, Multicaster } from '../';

// helper function to take a list of bodies and add them to the same filter group

export const useRaycaster = (
    origin?: THREE.Vector3 | number[] | null,
    direction?: THREE.Vector3 | number[] | null,
    type?: string
) => {
    const { physicsSystem } = useJolt();
    //const raycaster = useRef<Raycaster | null>(null);
    const raycaster: Raycaster = useMemo(() => {
        const caster: Raycaster = physicsSystem.getRaycaster();
        //@ts-ignore
        if (origin) caster.origin = origin;
        //@ts-ignore
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
    type?: string
) => {
    const { physicsSystem } = useJolt();
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
    const { physicsSystem } = useJolt();
    const raycaster: Multicaster = useMemo(() => {
        const caster = physicsSystem.getMulticaster();
        if (origin) caster.origin = origin;
        if (direction) caster.direction = direction;
        if (type) caster.setCollector(type);
        return caster;
    }, [origin, direction, type]);
    return raycaster;
};
