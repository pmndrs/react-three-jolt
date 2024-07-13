// ridged body wrapping and mesh components
import type { Euler, Quaternion, Vector3 } from '@react-three/fiber';
import type Jolt from 'jolt-physics';
import React, {
    Children,
    ReactNode,
    createContext,
    forwardRef,
    memo,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import * as THREE from 'three';
import { Object3D } from 'three';
import { useForwardedRef, useJolt } from '../hooks';
import { AutoShape, BodyState } from '../systems';
import { BodyType, GenerateBodyOptions } from '../systems/body-system';
import { _matrix4, _position, _quaternion, _scale, _vector3 } from '../tmp';
import { vec3 } from '../utils';

type MutableRigidBodyProps = {
    [Prop in keyof RigidBodyProps]: (body: BodyState, value: any) => void;
};

const mutableRigidBodyProps: MutableRigidBodyProps = {
    scale: (body: BodyState, scale: Vector3) => {
        body.setScale(vec3.three(scale, _vector3));
    },
    mass: (body: BodyState, mass: number) => {
        body.mass = mass;
    },
    friction: (body: BodyState, friction: number) => {
        body.friction = friction;
    },
    linearDamping: (body: BodyState, linearDamping: number) => {
        body.linearDamping = linearDamping;
    },
    angularDamping: (body: BodyState, angularDamping: number) => {
        body.angularDamping = angularDamping;
    },
    allowObstruction: (body: BodyState, allowObstruction: boolean) => {
        body.allowObstruction = allowObstruction;
    },
    obstructionTimelimit: (body: BodyState, obstructionTimelimit: number) => {
        body.obstructionTimelimit = obstructionTimelimit;
    },
    isSensor: (body: BodyState, isSensor: boolean) => {
        body.body.SetIsSensor(isSensor);
    },
    group: (body: BodyState, group: number) => {
        body.group = group;
    },
    subGroup: (body: BodyState, subGroup: number) => {
        body.subGroup = subGroup;
    },
    dof: (
        body: BodyState,
        dof: {
            x?: boolean;
            y?: boolean;
            z?: boolean;
            rotX?: boolean;
            rotY?: boolean;
            rotZ?: boolean;
        }
    ) => {
        const { x, y, z, rotX, rotY, rotZ } = dof;
        body.setEnabledTranslations(x || false, y || false, z || false);
        body.setEnabledRotations(rotX || false, rotY || false, rotZ || false);
    },
    lockRotations: (body: BodyState, lockRotations: boolean) => {
        if (!lockRotations) return;

        body.lockRotations();
    },
    lockTranslations: (body: BodyState, lockTranslations: boolean) => {
        if (!lockTranslations) return;

        body.lockTranslations();
    }
};

const useMutableRigidBodyProp = (
    body: BodyState | undefined,
    props: RigidBodyProps,
    key: keyof RigidBodyProps
) => {
    useEffect(() => {
        if (!body) return;
        const value = props[key];

        if (value !== undefined) {
            mutableRigidBodyProps[key]!(body, value);
        }
    }, [body, props[key]]);
};

const immutableRigidBodyProps: Array<keyof RigidBodyProps> = ['shape'];

export type RigidBodyProps = {
    children?: ReactNode;
    key?: string | number;

    position?: Vector3;
    rotation?: Euler;
    quaternion?: Quaternion;

    onlyInitialize?: boolean;
    onContactAdded?: (body1: number, body2: number) => void;
    onContactRemoved?: (body1: number, body2: number) => void;
    onContactPersisted?: (body1: number, body2: number) => void;
    // sleep listener
    //wake listener
    // this is MOTION Type
    type?: BodyType;
    shape?: AutoShape;
    debug?: boolean;
    ref?: any;
    allowObstruction?: boolean;
    obstructionTimelimit?: number;
    isSensor?: boolean;

    // groups
    group?: number;
    subGroup?: number;

    //physics props
    linearDamping?: number;
    angularDamping?: number;
    friction?: number;
    scale?: Vector3;

    // dof
    lockRotations?: boolean;
    lockTranslations?: boolean;
    dof?: { x?: boolean; y?: boolean; z?: boolean; rotX?: boolean; rotY?: boolean; rotZ?: boolean };
    //TODO: do these work yet?

    mass?: number;

    /**
     * @internal Do not use. Used internally by the InstancedRigidBodies.
     */
    _instancedMesh?: { instancedMesh: THREE.InstancedMesh; index: number } | undefined;
};

export type RigidBodyContext = {
    body: BodyState | undefined;
    type: BodyType | undefined;
    // methods
    setActiveShape: (shape: any) => void;
};

export const RigidBodyContext = createContext<RigidBodyContext | undefined>(undefined!);

export type RigidBodyRef = BodyState | undefined;

export const RigidBody = memo(
    forwardRef<RigidBodyRef, RigidBodyProps>((props, ref) => {
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
            friction,
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

            onContactAdded,
            onContactRemoved,
            onContactPersisted,

            _instancedMesh: instancedMesh,

            ...objectProps
        } = props;

        const objectRef = useRef<Object3D>(null!);

        const [bodyState, setBodyState] = useState<BodyState | undefined>(undefined);
        const bodyStateRef = useForwardedRef(ref);
        
        // load the jolt stuff
        const { bodySystem, debug: physicsDebug } = useJolt();

        // States
        const bodyLoaded = useRef(false);
        const [activeShape, setActiveShape] = React.useState<Jolt.Shape>();

        // this allows us to debug on the physics system or the component specifically
        const debug = propDebug || physicsDebug;

        const immutablePropArray = immutableRigidBodyProps.map((key) => {
            return props[key];
        });

        //* Load the body -------------------------------------
        // todo: we cant use useMount here because we need the shape dependencies
        useEffect(() => {
            if (!bodySystem || bodyLoaded.current) return;

            // detect if any of the children are shapes
            let hasShapes = false;
            if (children) {
                Children.toArray(children).forEach((child) => {
                    //@ts-ignore
                    if (child.type && child.type.displayName === 'Shape') {
                        hasShapes = true;
                    }
                });
            }

            if (hasShapes) console.log("hasShapes", hasShapes, activeShape);
            // if the children are shapes, we will wait for them to mount
            if (hasShapes && !activeShape) return;
            // todo: is this protection needed?
            //handle options from props

            const shapeObject = props._instancedMesh
                ? props._instancedMesh.instancedMesh
                : objectRef.current;

            const options: GenerateBodyOptions = {
                group: group,
                subGroup: subGroup,
                shape: activeShape,
                shapeObject,
                bodyType: type,
                shapeType: shape,
                instancedMesh: props._instancedMesh
            };

            const bodyHandle = bodySystem.addBody(objectRef.current, options);
            const body = bodySystem.getBody(bodyHandle);
            if (!body) throw new Error('Body not found');

            setBodyState(body);
            bodyStateRef.current = body;

            bodyLoaded.current = true;

            // for cycle reasons some stuff might have gotten missed
            // try setting the debug
            if (debug) {
                body.debug = debug;
            }

            return () => {
                // cleanup
                bodySystem.removeBody(bodyHandle);

                setBodyState(undefined);
                bodyStateRef.current = undefined;
            };
        }, [activeShape, bodySystem, ...immutablePropArray]);

        //*/ Debugging -------------------------------------

        useEffect(() => {
            if (!bodyState) return;

            bodyState.debug = debug;
        }, [bodyState, debug]);

        //* Shape Updates -------------------------------------

        // Shape update
        useEffect(() => {
            if (!bodyState || !bodyLoaded) return;

            if (activeShape) {
                bodyState.shape = activeShape;
            }

            //if we have a scale we should also set the scale on this new shape
            if (scale) {
                bodyState.setScale(vec3.three(scale, _vector3));
            }
        }, [bodyState, activeShape]);

        // position and rotation updates
        useEffect(() => {
            if (!bodyState || onlyInitialize) return;

            bodyState.object.updateWorldMatrix(true, false);

            _matrix4.copy(bodyState.object.matrixWorld).decompose(_position, _quaternion, _scale);

            bodyState.setPosition(_position);
            bodyState.setRotation(_quaternion);
        }, [bodyState, onlyInitialize, position, rotation, quaternion]);

        // mutable prop updates
        useMutableRigidBodyProp(bodyState, props, 'scale');
        useMutableRigidBodyProp(bodyState, props, 'mass');
        useMutableRigidBodyProp(bodyState, props, 'friction');
        useMutableRigidBodyProp(bodyState, props, 'linearDamping');
        useMutableRigidBodyProp(bodyState, props, 'angularDamping');
        useMutableRigidBodyProp(bodyState, props, 'allowObstruction');
        useMutableRigidBodyProp(bodyState, props, 'obstructionTimelimit');
        useMutableRigidBodyProp(bodyState, props, 'isSensor');
        useMutableRigidBodyProp(bodyState, props, 'group');
        useMutableRigidBodyProp(bodyState, props, 'subGroup');
        useMutableRigidBodyProp(bodyState, props, 'dof');
        useMutableRigidBodyProp(bodyState, props, 'lockRotations');
        useMutableRigidBodyProp(bodyState, props, 'lockTranslations');

        // contact listeners
        useEffect(() => {
            if (!bodyState) return;

            if (onContactAdded) bodyState.addContactListener(onContactAdded, 'added');
            if (onContactRemoved) bodyState.addContactListener(onContactRemoved, 'removed');
            if (onContactPersisted) bodyState.addContactListener(onContactPersisted, 'persisted');

            return () => {
                if (onContactAdded) bodyState.removeContactListener(onContactAdded);
                if (onContactRemoved) bodyState.removeContactListener(onContactRemoved);
                if (onContactPersisted) bodyState.removeContactListener(onContactPersisted);
            };
        }, [bodyState, onContactAdded, onContactRemoved, onContactPersisted]);

        const contextValue: RigidBodyContext = useMemo(() => {
            return {
                body: bodyState,
                type,
                setActiveShape
            };
        }, [bodyState, type]);

        return (
            <RigidBodyContext.Provider value={contextValue}>
                <object3D
                    ref={objectRef}
                    {...objectProps}
                    position={position}
                    quaternion={quaternion}
                    rotation={rotation}
                    scale={scale}>
                    {children}
                </object3D>
            </RigidBodyContext.Provider>
        );
    })
);
