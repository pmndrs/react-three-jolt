// This is the core component that manages and stores the simulation
import * as THREE from 'three';
import Jolt from 'jolt-physics';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import { Raw, initJolt } from '../raw';
import { JoltContext, joltContext } from '../context';
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
import { FrameStepper } from './FrameStepper';

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
export type PhysicsProps = {
    defaultBodySettings?: any;
    children: ReactNode;
    gravity?: number | THREE.Vector3;
    paused?: boolean;
    interpolate?: boolean;
    updatePriority?: any;
    updateLoop?: 'follow' | 'independent';
    debug?: boolean;
    module?: any;
};

export const Physics: FC<PhysicsProps> = (props) => {
    const {
        defaultBodySettings,
        // TODO: determine and apply/remove these defaults
        children,
        gravity,

        paused = false,
        debug = false,
        //interpolate = true,
        updatePriority,
        updateLoop = 'follow',

        //possible module or path?
        module
    } = props;

    // =================================================
    //* Module initialization
    //if the user passed a module path try to load it
    if (module) suspend(async () => initJolt(module), []);
    else suspend(() => initJolt(), []);
    // =================================================
    const jolt = Raw.module;
    const pid = useId();

    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem>();
    const [contextApi, setContextApi] = useState<JoltContext>();

    useMount(() => {
        console.log('** Physics Component: ' + pid + ' Mounted **');
        const ps = new PhysicsSystem(pid);
        // we have to pass this here to catch before body creation
        if (defaultBodySettings) ps.bodySystem.defaultBodySettings = defaultBodySettings;
        setPhysicsSystem(ps);
    });

    // setup the step
    const step = useCallback(
        (dt: number) => {
            // TODO: does running a conditional cause a performance hit?
            if (physicsSystem) physicsSystem.onUpdate(dt);
        },
        [physicsSystem]
    );
    // cleanup and destruction of system when component unmounts
    useUnmount(() => {
        if (physicsSystem) {
            // console.log('Component ' + pid + ' wanting to destroy physicsSystem: ', physicsSystem);
            physicsSystem.destroy(pid);
        }
    });

    // These will be effects for props to send to the correct systems

    useEffect(() => {
        if (!physicsSystem) return;
        console.log('setting gravity from component');
        //@ts-ignore
        if (gravity != null) physicsSystem.setGravity(gravity);
    }, [gravity, physicsSystem]);

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
        // set the paused and debug state on the physics system
        if (physicsSystem.debug !== debug) physicsSystem.debug = debug;
        if (physicsSystem.paused !== paused) physicsSystem.paused = paused;
    }, [debug, jolt, paused, physicsSystem, step]);

    if (!contextApi || !contextApi.physicsSystem) return null;

    return (
        <joltContext.Provider value={contextApi}>
            <FrameStepper type={updateLoop} onStep={step} updatePriority={updatePriority} />
            {children}
        </joltContext.Provider>
    );
};
