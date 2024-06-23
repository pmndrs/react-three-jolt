// This is the core component that manages and stores the simulation
import type Jolt from 'jolt-physics';
import * as THREE from 'three';
//import InitJolt from 'jolt-physics/wasm-compat'
import { FC, ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { suspend } from 'suspend-react';
import { JoltContext, joltContext } from '../context';
import { Raw, initJolt } from '../raw';
// to clear weird TS error
import React from 'react';

// library imports
import { FrameStepper } from './FrameStepper';

// physics system import
import { Vector3 } from '@react-three/fiber';
import { PhysicsSystem } from '../systems/physics-system';
import { vec3 } from '../utils';

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
    gravity?: Vector3 | number;
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
    if (module) {
        suspend(() => initJolt(module), ['jolt', module]);
    } else {
        suspend(() => initJolt(), ['jolt']);
    }
    // =================================================
    const jolt = Raw.module;
    const pid = useId();

    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem>();
    const [contextApi, setContextApi] = useState<JoltContext>();

    ;(window as any).contextApi = contextApi;

    useEffect(() => {
        if (debug) console.log('** Physics Component: ' + pid + ' Mounted **');
        const ps = new PhysicsSystem(pid);
        
		// we have to pass this here to catch before body creation
        if (defaultBodySettings) {
			ps.bodySystem.defaultBodySettings = defaultBodySettings;
		}

        setPhysicsSystem(ps);

        return () => {
            ps.destroy(pid);
        }
    }, []);

    // setup the step
    const step = useCallback(
        (dt: number) => {
            // TODO: does running a conditional cause a performance hit?
            if (physicsSystem) physicsSystem.onUpdate(dt);
        },
        [physicsSystem]
    );

    // These will be effects for props to send to the correct systems
    useEffect(() => {
        if (!physicsSystem) return;
        if (gravity === undefined) return;

        physicsSystem.setGravity(
            typeof gravity === 'number' ? new THREE.Vector3(0, -gravity, 0) : vec3.three(gravity)
        );
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
        if (physicsSystem.debug !== debug) {
            physicsSystem.debug = debug;
        }

        if (physicsSystem.paused !== paused) {
            physicsSystem.paused = paused;
        }
    }, [debug, jolt, paused, physicsSystem, step]);

    if (!contextApi || !contextApi.physicsSystem) return null;

    return (
        <joltContext.Provider value={contextApi}>
            <FrameStepper type={updateLoop} onStep={step} updatePriority={updatePriority} />
            {children}
        </joltContext.Provider>
    );
};
