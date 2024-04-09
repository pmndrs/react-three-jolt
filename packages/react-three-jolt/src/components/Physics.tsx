// This is the core component that manages and stores the simulation
import * as THREE from 'three';
import Jolt from 'jolt-physics';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import { Raw, initJolt } from '../raw';
import { type JoltContext, joltContext } from '../context';
import {
    FC,
    ReactNode,
    //  ReactNode,
    useCallback,
    useEffect,
    useMemo
    //useRef,
    //useState,
} from 'react';
// to clear weird TS error
import React from 'react';

import { useConst } from '../hooks';
// library imports
import FrameStepper from './FrameStepper';

// physics system import
import { PhysicsSystem } from '../systems/physics-system';

// TODO: Move this to a better place
declare module 'three' {
    interface Mesh {
        shape: string;
        ignore: boolean;
    }
}

// stepping state object
export interface SteppingState {
    accumulator: number;
    previousState: Map<
        Jolt.Body,
        {
            position: THREE.Vector3;
            quaternion: THREE.Quaternion;
        }
    >;
}

// Core component
export interface PhysicsProps {
    defaultBodySettings?: any;
    children: ReactNode;
    gravity?: number | THREE.Vector3;
    paused?: boolean;
    interpolate?: boolean;
    updatePriority?: any;
    updateLoop?: string;
    debug?: boolean;
}

export const Physics: FC<PhysicsProps> = (props) => {
    const {
        defaultBodySettings,
        // TODO: determine and apply/remove these defaults
        children,
        gravity = [0, -9.81, 0],

        paused = false,
        //interpolate = true,
        updatePriority,
        updateLoop = 'follow',
        debug = false
    } = props;

    // =================================================

    suspend(() => initJolt(), []);
    const jolt = Raw.module;
    useEffect(() => {
        console.log('Physics Componment Mounting');
    }, []);
    const physicsSystem = useConst(() => new PhysicsSystem());
    // we have to pass this here to catch before body creation
    if (defaultBodySettings) physicsSystem.bodySystem.defaultBodySettings = defaultBodySettings;
    // setup the step
    const step = useCallback((dt: number) => {
        physicsSystem.onUpdate(dt);
    }, []);
    // cleanup and destruction of system when component unmounts
    useEffect(() => {
        return () => {
            physicsSystem.destroy();
        };
    }, [physicsSystem]);

    // These will be effects for props to send to the correct systems

    useEffect(() => {
        //@ts-ignore
        if (gravity != null) physicsSystem.setGravity(gravity);
    }, [gravity]);

    const context: JoltContext = useMemo(
        () => ({
            jolt,
            physicsSystem,
            bodySystem: physicsSystem.bodySystem,
            joltInterface: physicsSystem.joltInterface,
            paused,
            debug,
            step
        }),
        [debug, jolt, paused, physicsSystem, step]
    );

    return (
        <joltContext.Provider value={context}>
            <FrameStepper type={updateLoop} onStep={step} updatePriority={updatePriority} />
            {children}
        </joltContext.Provider>
    );
};
