// This is the core component that manages and stores the simulation
import * as THREE from 'three';
import Jolt from 'jolt-physics';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import { Raw, initJolt } from '../raw';
import { joltContext } from '../context';
import {
    FC,
    ReactNode,
    //  ReactNode,
    useCallback,
    useEffect,
    //useMemo,
    useId,
    // useRef,
    useState
} from 'react';
// to clear weird TS error
import React from 'react';

import { useMount, useUnmount } from '../hooks';
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
    const pid = useId();

    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem>();
    const [contextApi, setContextApi] = useState({});

    useMount(() => {
        console.log('** Physics Component: ' + pid + ' Mounted **');
        const ps = new PhysicsSystem(pid);
        // we have to pass this here to catch before body creation
        if (defaultBodySettings) ps.bodySystem.defaultBodySettings = defaultBodySettings;
        setPhysicsSystem(ps);
    });

    // setup the step
    const step = useCallback((dt: number) => {
        // TODO: does running a conditional cause a performance hit?
        if (physicsSystem) physicsSystem.onUpdate(dt);
    }, []);
    // cleanup and destruction of system when component unmounts
    useUnmount(() => {
        if (physicsSystem) {
            console.log('Component ' + pid + ' wanting to destroy physicsSystem: ', physicsSystem);
            physicsSystem.destroy(pid);
        }
    });

    // These will be effects for props to send to the correct systems

    useEffect(() => {
        if (!physicsSystem) return;
        //@ts-ignore
        if (gravity != null) physicsSystem.setGravity(gravity);
    }, [physicsSystem, gravity]);

    // set the context
    useEffect(() => {
        if (!physicsSystem) return;
        setContextApi({
            jolt,
            physicsSystem,
            bodySystem: physicsSystem.bodySystem,
            joltInterface: physicsSystem.joltInterface,
            paused,
            debug,
            step
        });
    }, [debug, jolt, paused, physicsSystem, step]);
    if (!contextApi.physicsSystem) {
        console.log('no physicsSystem, children shouldnt load');
        return null;
    } else {
        console.log('physicsSystem exists, children should load', contextApi);
    }
    return (
        <joltContext.Provider value={contextApi}>
            <FrameStepper type={updateLoop} onStep={step} updatePriority={updatePriority} />
            {children}
        </joltContext.Provider>
    );
};
