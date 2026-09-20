// ridged body wrapping and mesh components
import Jolt from 'jolt-physics';
import React, {
    Children,
    createContext,
    forwardRef,
    memo,
    ReactNode,
    useCallback,
    useEffect,
    //  useLayoutEffect,
    useMemo,
    useRef
} from 'react';
import * as THREE from 'three';
import { Object3D } from 'three';
import { useBodyEvent, useForwardedRef, useJolt, useUnmount } from '../hooks';
import { AutoShape, BodyState } from '../systems';
import { BodyType, GenerateBodyOptions } from '../systems/body-system';
import type { BodyEventMap } from '../systems/events';
import { vec3 } from '../utils';

interface RigidBodyProps {
    children: ReactNode;
    key?: number;
    position?: number[];
    rotation?: number[];
    onlyInitialize?: boolean;

    //* Events -------------------------------------------
    /** This body started touching another. Fires once per pair, per body. */
    onCollisionEnter?: BodyEventMap['collisionEnter'];
    /** The contact was maintained this step. Free from Jolt, zero cost when unused. */
    onCollisionPersist?: BodyEventMap['collisionPersist'];
    /** The last sub-shape manifold between the two bodies closed. */
    onCollisionExit?: BodyEventMap['collisionExit'];
    /** Something started overlapping this sensor (set `isSensor`). */
    onSensorEnter?: BodyEventMap['sensorEnter'];
    /** Something stopped overlapping this sensor. */
    onSensorExit?: BodyEventMap['sensorExit'];
    /** Rapier compatible alias for {@link onSensorEnter}. */
    onIntersectionEnter?: BodyEventMap['sensorEnter'];
    /** Rapier compatible alias for {@link onSensorExit}. */
    onIntersectionExit?: BodyEventMap['sensorExit'];
    /** The body was deactivated by Jolt's sleeping logic. */
    onSleep?: BodyEventMap['sleep'];
    /** The body was activated again. */
    onWake?: BodyEventMap['wake'];
    /**
     * Runs **synchronously inside the physics step**: return `false` to reject the contact
     * (one-way platforms, team pass-through). Must be fast and must not touch bodies.
     */
    onContactValidate?: BodyEventMap['contactValidate'];

    /** @deprecated renamed to {@link onCollisionEnter}; receives the new payload. */
    onContactAdded?: BodyEventMap['collisionEnter'];
    /** @deprecated renamed to {@link onCollisionExit}; receives the new payload. */
    onContactRemoved?: BodyEventMap['collisionExit'];
    /** @deprecated renamed to {@link onCollisionPersist}; receives the new payload. */
    onContactPersisted?: BodyEventMap['collisionPersist'];

    // this is MOTION Type
    type?: BodyType;
    shape?: AutoShape;
    debug?: boolean;
    ref?: any;
    allowObstruction?: boolean;
    obstructionTimelimit?: number;
    isSensor?: boolean;

    // Collision groups: the "these two specific objects shouldn't collide" filter. Bodies only
    // consult it when their `group` matches; `bodySystem.disableCollision(subA, subB)` then turns
    // off that one sub group pair. Broad categories stay on the object layer. Both are reactive.
    group?: number;
    subGroup?: number;

    //physics props
    linearDamping?: number;
    angularDamping?: number;
    friction?: number;
    scale?: number[];

    // dof
    lockRotations?: boolean;
    lockTranslations?: boolean;
    dof?: { x?: boolean; y?: boolean; z?: boolean; rotX?: boolean; rotY?: boolean; rotZ?: boolean };
    //TODO: do these work yet?

    mass?: number;
    // remove
    quaternion?: number[];
}
export interface RigidBodyContext {
    body: BodyState | undefined;
    type: BodyType | undefined;
    position: THREE.Vector3 | undefined;
    rotation: THREE.Vector3 | undefined;
    scale: THREE.Vector3 | undefined;
    quaternion: THREE.Quaternion | undefined;
    // methods
    setActiveShape: (shape: any) => void;
    /**
     * Tell the body its shape changed underneath it (#108: a `<Shape dynamic>` edits its
     * `MutableCompoundShape` in place rather than handing over a new shape, so `setActiveShape`
     * never fires and the body would keep the bounds and mass properties it was created with).
     */
    notifyShapeChanged?: (previousCenterOfMass?: [number, number, number]) => void;
}
export const RigidBodyContext = createContext<RigidBodyContext | undefined>(undefined!);

// the ridgedBody is a forwardRef so we can pass props directly
// inital version from r3/rapier
export const RigidBody: React.FC<RigidBodyProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,

            type,
            shape,
            position,
            rotation,
            onlyInitialize,
            scale,
            mass,
            quaternion,
            isSensor,
            angularDamping,
            linearDamping,
            group,
            subGroup,

            // obstruction
            allowObstruction,
            obstructionTimelimit,

            //dof
            lockRotations,
            lockTranslations,
            dof,

            debug: propDebug,

            onCollisionEnter,
            onCollisionPersist,
            onCollisionExit,
            onSensorEnter,
            onSensorExit,
            onIntersectionEnter,
            onIntersectionExit,
            onSleep,
            onWake,
            onContactValidate,
            onContactAdded,
            onContactRemoved,
            onContactPersisted,
            ...objectProps
        } = props;

        const objectRef = useRef<Object3D>(null);
        //TODO: Figure out way to put BodyState type on this ref
        const rigidBodyRef = useForwardedRef(forwardedRef);

        // state refs allow us to track if inputs have changed without triggering a re-render
        const prevPosition = useRef<THREE.Vector3 | undefined>(undefined);
        const prevRotation = useRef<THREE.Quaternion | undefined>(undefined);

        // load the jolt stuff
        const { bodySystem, debug: physicsDebug } = useJolt();

        // States
        const bodyLoaded = useRef(false);
        const [activeShape, setActiveShape] = React.useState<Jolt.Shape>();
        /**
         * The body as React state, not just a ref. Effects that subscribe to events have to
         * depend on the body *instance*: a `ref.current` read in a dep array is not reactive,
         * which is exactly why the old listener effect never ran on the pass that created the
         * body and so never registered anything at all.
         */
        const [body, setBody] = React.useState<BodyState>();

        // this allows us to debug on the physics system or the component specifically
        const debug = propDebug || physicsDebug;

        //* Load the body -------------------------------------
        // todo: we cant use useMount here because we need the shape dependencies
        useEffect(() => {
            if (!bodySystem || bodyLoaded.current) return;
            // detect if any of the children are shapes
            let hasShapes = false;
            if (children)
                Children.toArray(children).forEach((child) => {
                    //@ts-ignore
                    if (child.type && child.type.displayName === 'Shape') hasShapes = true;
                });
            //if (hasShapes) console.log("hasShapes", hasShapes, activeShape);
            // if the children are shapes, we will wait for them to mount
            if (hasShapes && !activeShape) return;
            // todo: is this protection needed?
            if (objectRef.current) {
                //handle options from props
                const options: GenerateBodyOptions = {
                    group: group,
                    subGroup: subGroup,
                    shape: activeShape,
                    bodyType: type,
                    shapeType: shape
                };
                //put the initial position, rotation, scale, and quaternion in the options
                if (position) objectRef.current.position.copy(vec3.three(position));
                if (rotation) objectRef.current.rotation.setFromVector3(vec3.three(rotation));

                //@ts-ignore
                const bodyHandle = bodySystem.addBody(objectRef.current, options);
                const body = bodySystem.getBody(bodyHandle);
                if (!body) throw new Error('Body not found');
                rigidBodyRef.current = body;
                bodyLoaded.current = true;
                setBody(body);

                // for cycle reasons some stuff might have gotten missed
                // try setting the debug
                if (debug) body.debug = debug;
                if (position) body.position = vec3.three(position);
                if (rotation)
                    body.rotation = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(rotation[0], rotation[1], rotation[2])
                    );
                // #40: scale the shape as part of creating the body rather than a frame later,
                // so the body never exists at the wrong size (BodyState.scale wraps the shape in
                // a ScaledShape, which is what lets it change again afterwards)
                if (scale) body.scale = vec3.three(scale);
            }
        }, [activeShape, bodySystem, rigidBodyRef]);

        // When destroying we need to do some stuff
        useUnmount(() => {
            // A RigidBody whose shape children never resolved has no body at all; this used to
            // throw on unmount trying to read `.handle` of undefined.
            const current = rigidBodyRef.current as BodyState | undefined;
            if (current) bodySystem.removeBody(current.handle);
        });

        //*/ Debugging -------------------------------------

        useEffect(() => {
            if (rigidBodyRef.current) (rigidBodyRef.current as BodyState).debug = debug;
        }, [debug, rigidBodyRef]);

        //* Shape Updates -------------------------------------
        // Shape update
        useEffect(() => {
            if (!rigidBodyRef.current || !bodyLoaded) return;
            const body = rigidBodyRef.current as BodyState;
            if (activeShape) body.shape = activeShape;
            //if we have a scale we should also set the scale on this new shape
            if (scale) body.scale = vec3.three(scale);
        }, [activeShape, rigidBodyRef]);

        // scale the shape when the input scale changes
        useEffect(() => {
            if (!rigidBodyRef.current || !bodyLoaded) return;
            const body = rigidBodyRef.current as BodyState;
            if (scale) body.scale = vec3.three(scale);
        }, [scale, rigidBodyRef]);
        //* Prop Updates -------------------------------------
        useEffect(() => {
            if (!rigidBodyRef.current || onlyInitialize) return;
            const body = rigidBodyRef.current as BodyState;
            if (position) {
                // this adds a little to things,and might be worth not doing onlyInitialize
                // but if the input hasn't changed we should ignore this
                const newPositon = vec3.three(position);
                if (!prevPosition.current || !newPositon.equals(prevPosition.current)) {
                    body.position = newPositon;
                    prevPosition.current = newPositon;
                }
            }
            if (rotation) {
                const quaternion = Array.isArray(rotation)
                    ? new THREE.Quaternion().setFromEuler(
                          new THREE.Euler(rotation[0], rotation[1], rotation[2])
                      )
                    : rotation;
                // if the input hasn't changed we should ignore this
                if (!prevRotation.current || !quaternion.equals(prevRotation.current)) {
                    body.rotation = quaternion;
                    prevRotation.current = quaternion;
                }
            }
        }, [onlyInitialize, position, rotation, rigidBodyRef]);

        //* Events -------------------------------------------
        // Each of these is an effect whose cleanup is the unsubscribe handle, keyed on the body
        // instance. Handler identity is deliberately not a dependency (see useBodyEvent), so an
        // inline arrow does not resubscribe every render, and StrictMode's mount/cleanup/mount
        // leaves exactly one subscription.
        useBodyEvent(body, 'collisionEnter', onCollisionEnter ?? onContactAdded);
        useBodyEvent(body, 'collisionPersist', onCollisionPersist ?? onContactPersisted);
        useBodyEvent(body, 'collisionExit', onCollisionExit ?? onContactRemoved);
        useBodyEvent(body, 'sensorEnter', onSensorEnter ?? onIntersectionEnter);
        useBodyEvent(body, 'sensorExit', onSensorExit ?? onIntersectionExit);
        useBodyEvent(body, 'sleep', onSleep);
        useBodyEvent(body, 'wake', onWake);
        useBodyEvent(body, 'contactValidate', onContactValidate);

        //not sure these should be set as useEffects or directly in the body
        useEffect(() => {
            if (!rigidBodyRef.current) return;
            const body = rigidBodyRef.current as BodyState;
            //@ts-ignore
            if (mass) bodySystem.setMass(body.handle, mass);
            if (linearDamping) body.linearDamping = linearDamping;
            if (angularDamping) body.angularDamping = angularDamping;

            // check if the body is allowing obstruction
            const isAllowing = body.allowObstruction;
            if (allowObstruction !== undefined) {
                if (isAllowing !== allowObstruction) {
                    body.allowObstruction = allowObstruction as boolean;
                }
                if (obstructionTimelimit) {
                    body.obstructionType = 'temporal';
                    body.obstructionTimelimit = obstructionTimelimit;
                }
            }
            if (isSensor !== undefined) body.body.SetIsSensor(isSensor);
        }, [
            mass,
            allowObstruction,
            obstructionTimelimit,
            linearDamping,
            angularDamping,
            rigidBodyRef,
            isSensor
        ]);

        //* Groups -------------------------------------
        useEffect(() => {
            if (!rigidBodyRef.current) return;
            const body = rigidBodyRef.current as BodyState;
            // `!== undefined` rather than truthy: group/sub group 0 are perfectly valid ids.
            // activeShape is a dependency because a body with <Shape> children isn't created
            // until the shape mounts, which is after this effect's first run.
            if (group !== undefined) body.group = group;
            if (subGroup !== undefined) body.subGroup = subGroup;
        }, [group, subGroup, activeShape, rigidBodyRef]);

        //* DOF -------------------------------------
        useEffect(() => {
            if (!rigidBodyRef.current) return;
            const body = rigidBodyRef.current as BodyState;
            if (dof) {
                const { x, y, z, rotX, rotY, rotZ } = dof;
                body.setEnabledTranslations(x || false, y || false, z || false);
                body.setEnabledRotations(rotX || false, rotY || false, rotZ || false);
            }
            if (lockRotations) body.lockRotations();
            if (lockTranslations) body.lockTranslations();
        }, [dof, lockRotations, lockTranslations, rigidBodyRef]);

        // #108: a <Shape dynamic> edits its compound in place; this is how it reaches the body.
        // Read through the ref so the callback identity never changes (the context value below
        // is memoised, and a child's registration effect depends on it).
        const notifyShapeChanged = useCallback(
            (previousCenterOfMass?: [number, number, number]) => {
                const body = rigidBodyRef.current as BodyState | undefined;
                body?.notifyShapeChanged(previousCenterOfMass);
            },
            [rigidBodyRef]
        );

        // the context should update when a new handle is added
        //@ts-ignore
        const contextValue: RigidBodyContext = useMemo(() => {
            return {
                // the state, not the ref: this is what makes the context update once the body
                // actually exists
                body,
                type,
                position,
                rotation,
                scale,
                quaternion,
                setActiveShape,
                notifyShapeChanged
            };
        }, [body, type, position, rotation, scale, quaternion, notifyShapeChanged]);
        return (
            <RigidBodyContext.Provider value={contextValue}>
                <object3D ref={objectRef} {...objectProps}>
                    {children}
                </object3D>
            </RigidBodyContext.Provider>
        );
    })
);
