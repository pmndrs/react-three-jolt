// ridged body wrapping and mesh components
import React, {
    createContext,
    memo,
    // MutableRefObject,
    //RefObject,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef
} from 'react';
import { forwardRef, ReactNode, useContext, useImperativeHandle } from 'react';
import { Object3D } from 'three';
import { useForwardedRef, useConst, useJolt } from '../hooks';
//import * as THREE from 'three';
import { JoltContext } from './Physics';
import {
    BodyState,
    GenerateBodyOptions,
    getThreeObjectForBody
} from '../systems/body-system';
import * as THREE from 'three';
import { quat, vec3 } from '../utils';
//import { useImperativeInstance } from '../hooks/use-imperative-instance';

interface RigidBodyProps {
    children: ReactNode;
    key?: number;
    position?: number[];
    rotation?: number[];
    onContactAdded?: (body1: number, body2: number) => void;
    onContactRemoved?: (body1: number, body2: number) => void;
    onContactPersisted?: (body1: number, body2: number) => void;
    // sleep listener
    //wake listener
    // this is MOTION Type
    type?: string;
    shape?: string;

    //TODO: do these work yet?
    scale?: number[];
    mass?: number;
    quaternion?: number[];
}
// the ridgedBody is a forwardRef so we can pass props directly

export const RigidBodyContext = createContext(undefined!);

// inital version from r3/rapier
export const RigidBody: React.FC<RigidBodyProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,

            type,
            shape,
            position,
            rotation,
            scale,
            mass,

            quaternion,

            debug: propDebug,

            onContactAdded,
            onContactRemoved,
            onContactPersisted,
            ...objectProps
        } = props;

        const objectRef = useRef<Object3D>(null);
        const rigidBodyRef = useForwardedRef(forwardedRef);
        const debugMeshRef = useRef<THREE.Mesh>(null);
        // load the jolt stuff
        const {
            jolt,
            physicsSystem,
            bodySystem,
            debug: physicsDebug,
            paused
        } = useJolt();

        const debug = propDebug || physicsDebug;
        //* Load the body -------------------------------------
        useLayoutEffect(() => {
            if (objectRef.current) {
                //handle options from props
                // for the moment all we care about is bodyType
                const options = {
                    bodyType: type || 'dynamic', // default to dynamic
                    shapeType: shape || null
                };
                //put the initial position, rotation, scale, and quaternion in the options
                if (position)
                    objectRef.current.position.copy(vec3.three(position));
                if (rotation)
                    objectRef.current.rotation.setFromVector3(
                        vec3.three(rotation)
                    );
                const bodyHandle = bodySystem.addBody(
                    objectRef.current,
                    options
                );
                const body = bodySystem.getBody(bodyHandle);
                /*setInterval(() => {
                    const body = rigidBodyRef.current.body;
                }, 1000);
                */
                rigidBodyRef.current = body;
            }
        }, []);
        //*/ Debugging -------------------------------------
        useEffect(() => {
            if (debug && debugMeshRef.current) {
                // get the debug threeObject for this body
                const debugObject = getThreeObjectForBody(
                    rigidBodyRef.current.body
                );
                debugMeshRef.current.geometry = debugObject.geometry;
                debugMeshRef.current.material = new THREE.MeshStandardMaterial({
                    color: 0xff0000,
                    wireframe: true
                });
            }
        }, [debug]);

        // add the contact listeners
        useEffect(() => {
            if (rigidBodyRef.current) {
                if (onContactAdded)
                    rigidBodyRef.current.addContactListener(
                        onContactAdded,
                        'added'
                    );
                if (onContactRemoved)
                    rigidBodyRef.current.addContactListener(
                        onContactRemoved,
                        'removed'
                    );
                if (onContactPersisted)
                    rigidBodyRef.current.addContactListener(
                        onContactPersisted,
                        'persisted'
                    );
            }
            // remove the listeners
            return () => {
                if (rigidBodyRef.current) {
                    if (onContactAdded)
                        rigidBodyRef.current.removeContactListener(
                            onContactAdded
                        );
                    if (onContactRemoved)
                        rigidBodyRef.current.removeContactListener(
                            onContactRemoved
                        );
                    if (onContactPersisted)
                        rigidBodyRef.current.removeContactListener(
                            onContactPersisted
                        );
                }
            };
        }, [
            rigidBodyRef.current,
            onContactAdded,
            onContactRemoved,
            onContactPersisted
        ]);
        //not sure these should be set as useEffects or directly in the body
        useEffect(() => {
            if (mass) bodySystem.setMass(rigidBodyRef.current.handle, mass);
        }, [mass]);

        // the context should update when a new handle is added
        const contextValue = useMemo(() => {
            return {
                object: objectRef.current,
                type,
                position,
                rotation,
                scale,
                quaternion
            };
        }, [objectRef, type, position, rotation, scale, quaternion]);
        return (
            <RigidBodyContext.Provider value={contextValue}>
                <object3D ref={objectRef} {...objectProps}>
                    {children}
                    <mesh ref={debugMeshRef} visible={debug} ignore />
                </object3D>
            </RigidBodyContext.Provider>
        );
    })
);

// trying with useImperativeInstance
/*
        const getRigitBody = useImperativeInstance(
            () => {
                //handle options from props
                // for the moment all we care about is bodyType
                const options = {
                    bodyType: type || 'dynamic' // default to dynamic
                };
                const bodyHandle = bodySystem.addBody(
                    objectRef.current,
                    options
                );
                const body = bodySystem.getBody(bodyHandle);
                rigidBodyRef.current = body;
                console.log('Body Loaded', bodyHandle, body);
                return body;
            },
            (instance: BodyState) => {
                bodySystem.removeBody(instance.handle);
            },
            []
        );
        useEffect(() => {
            getRigitBody();
        }, [getRigitBody]);
        */
