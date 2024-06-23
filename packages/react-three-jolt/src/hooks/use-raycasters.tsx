// creates a jolt constrain given two bodies
import { useRef } from 'react';
import * as THREE from 'three';
import { AdvancedRaycaster, Multicaster, Raycaster } from '../systems';
import { useJolt } from './hooks';
import { useImperativeInstance } from './use-imperative-instance';

// helper function to take a list of bodies and add them to the same filter group

export const useRaycaster = (
    origin?: THREE.Vector3 | number[] | null,
    direction?: THREE.Vector3 | number[] | null,
    type?: string
) => {
    const { physicsSystem } = useJolt();

    const raycaster = useRef<Raycaster | null>(null);

    const get = useImperativeInstance(
        () => {
            const caster = physicsSystem.getRaycaster();

            if (origin) {
                //@ts-ignore
                caster.origin = origin;
            }

            if (direction) {
                //@ts-ignore
                caster.direction = direction;
            }

            if (type) {
                caster.setCollector(type);
            }

            raycaster.current = caster;

            return caster;
        },
        (instance) => {
            raycaster.current = null;
            instance.destroy();
        },
        [origin, direction, type, physicsSystem]
    );

    get();

    return raycaster.current!;
};

export const useAdvancedRaycaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type?: string
) => {
    const { physicsSystem } = useJolt();

    const raycaster = useRef<AdvancedRaycaster | null>(null);

    const get = useImperativeInstance(
        () => {
            const caster = physicsSystem.getAdvancedRaycaster();

            if (origin) {
                caster.origin = origin;
            }

            if (direction) {
                caster.direction = direction;
            }

            if (type) {
                caster.setCollector(type);
            }

            raycaster.current = caster;

            return caster;
        },
        (instance) => {
            raycaster.current = null;
            instance.destroy();
        },
        [origin, direction, type, physicsSystem]
    );

    get();

    return raycaster.current!;
};

export const useMulticaster = (
    origin?: THREE.Vector3,
    direction?: THREE.Vector3,
    type?: string
) => {
    const { physicsSystem } = useJolt();

    const raycaster = useRef<Multicaster | null>(null);

    const get = useImperativeInstance(
        () => {
            const caster = physicsSystem.getMulticaster();

            if (origin) {
                caster.origin = origin;
            }

            if (direction) {
                caster.direction = direction;
            }

            if (type) {
                caster.setCollector(type);
            }

            raycaster.current = caster;

            return caster;
        },
        (instance) => {
            raycaster.current = null;
            instance.raycaster.destroy();
        },
        [origin, direction, type, physicsSystem]
    );

    get();

    return raycaster.current!;
};
