// <Shape> declares one node of a body's collision shape.
//
// It is a thin React binding over the shape pipeline in systems/shape-system.ts (issue #107):
// the props are normalised into a plain `ShapeDescriptor`, that descriptor's stable key drives
// the effects (issue #151: they used to depend on `type` alone, so changing `size` did nothing
// and every superseded shape leaked), and `generateShape` turns it into a Jolt shape this
// component owns exactly one reference on. A nested <Shape> registers its descriptor with its
// parent, which builds a compound out of them.
import type Jolt from 'jolt-physics';
import React, {
    createContext,
    forwardRef,
    memo,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import * as THREE from 'three';

import { useForwardedRef, useJolt } from '../../hooks';
import {
    type AutoShape,
    describeShapeFromOptions,
    descriptorKey,
    generateShape,
    releaseShape,
    type ShapeDescriptor,
    type ShapeOptions,
    type ShapeType,
    scaleShape,
    stableKey
} from '../../systems';
import { devWarn, vec3 } from '../../utils';
import { RigidBodyContext } from '../RigidBody';

// creates a Jolt Shape from three.js meshes.
//NOTE by default doesn't render them

// Shape Props
export interface ShapeProps extends Omit<ShapeOptions, 'children'> {
    /** nested `<Shape>`s become the children of a compound shape */
    children?: ReactNode;
    /** local position inside the parent compound */
    position?: number[];
    /** local rotation (euler) inside the parent compound */
    rotation?: [number, number, number];
    /** wraps the generated shape in a `ScaledShape` */
    scale?: number[] | number;

    /** reserved for #108: a mutable (runtime editable) compound */
    dynamic?: boolean;
    type?: AutoShape | ShapeType;
}

/** What a `<Shape>` ref exposes: the description it built and the shape it owns. */
export type ShapeHandle = {
    descriptor: ShapeDescriptor | undefined;
    shape: Jolt.Shape | undefined;
};

export interface ShapeContext {
    shape: Jolt.Shape | undefined;
    /** register a child descriptor with this compound; returns the child's index */
    addShape: (descriptor: ShapeDescriptor) => number;
    /** replace the descriptor at `index` and rebuild */
    modifyShape: (index: number, descriptor: ShapeDescriptor) => void;
    /** drop the child at `index` and rebuild */
    removeShape: (index: number) => void;
}
export const ShapeContext = createContext<ShapeContext | undefined>(undefined!);

/**
 * Identity of everything that defines the shape itself. Geometries and objects are identified by
 * their uuid rather than walked, and long vertex arrays are hashed by `stableKey`.
 */
const shapePropsKey = (type: string, options: ShapeOptions) =>
    stableKey({
        ...options,
        type,
        geometry: options.geometry?.uuid,
        object: options.object?.uuid,
        mesh: options.mesh?.uuid
    });

export const Shape: React.FC<ShapeProps> = memo(
    forwardRef<ShapeHandle, ShapeProps>((props, forwardedRef) => {
        const {
            children,
            dynamic = false,
            type = 'box',
            position = [0, 0, 0],
            rotation = [0, 0, 0],
            scale,
            ...options
        } = props;

        // keeps <Shape> inside a <Physics> tree, so the wasm module is up before we allocate
        useJolt();
        const ref = useForwardedRef<ShapeHandle>(forwardedRef, {
            descriptor: undefined,
            shape: undefined
        });
        // the rigid body context (a nested <Shape> still sees it, so it is read optionally)
        const rigidBody = useContext(RigidBodyContext);
        // if we are the child of another shape, we can get the shape context
        const parentShape = useContext(ShapeContext);

        // dynamic checker
        const dynamicOnInit = useRef(dynamic);

        // if the user tries to change the dynamic prop throw an error
        if (dynamicOnInit.current !== dynamic) {
            throw new Error('Cannot change dynamic prop after initialization');
        }

        const hasChildren = React.Children.count(children) > 0;

        const [shape, setShape] = useState<Jolt.Shape>();
        // the shape as generated from the descriptor, before any scaling
        const baseShape = useRef<Jolt.Shape | undefined>(undefined);
        // the ScaledShape wrapping `baseShape`, when a scale is set
        const scaledShape = useRef<Jolt.Shape | undefined>(undefined);
        // what has actually been built, so an effect re-run with unchanged props is a no-op
        const builtDescriptorKey = useRef<string | undefined>(undefined);
        const appliedScaleKey = useRef<string | undefined>(undefined);

        // Compound Shape Data: child descriptors, plus a counter so a change re-runs the effect
        const subShapes = useRef<(ShapeDescriptor | undefined)[]>([]);
        const [subShapeVersion, setSubShapeVersion] = useState(0);
        // our index inside the parent compound, if we have one, and what we last told it
        const indexInParent = useRef<number | undefined>(undefined);
        const registeredKey = useRef<string | undefined>(undefined);

        //* Descriptor ----------------------------------------
        // Every key below is a primitive, so the effects re-run exactly when the *content* of a
        // prop changes - not when react hands us a new array/object with the same values.
        const propsKey = shapePropsKey(type, options as ShapeOptions);
        const transformKey = stableKey([position, rotation]);
        const scaleKey = scale === undefined ? 'none' : stableKey(scale);

        // our own (leaf) description. Memoised because the convex/trimesh paths walk the geometry
        const localDescriptor = useMemo(
            () => describeShapeFromOptions(type, options as ShapeOptions),
            // biome-ignore lint/correctness/useExhaustiveDependencies: propsKey is the content
            // hash of `type` + `options`, which is exactly what this depends on
            [propsKey]
        );

        // position/rotation are the transform inside a parent compound
        const transform = useMemo(() => {
            const quaternion = new THREE.Quaternion().setFromEuler(
                new THREE.Euler().fromArray(rotation || [0, 0, 0])
            );
            const { x, y, z } = vec3.three(position || [0, 0, 0]);
            return {
                position: [x, y, z] as [number, number, number],
                rotation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] as [
                    number,
                    number,
                    number,
                    number
                ]
            };
            // biome-ignore lint/correctness/useExhaustiveDependencies: transformKey is the
            // content hash of `position` + `rotation`
        }, [transformKey]);

        /** The full description of this node: a compound when it has children, a leaf otherwise. */
        const resolveDescriptor = useCallback((): ShapeDescriptor => {
            const childDescriptors = subShapes.current.filter(Boolean) as ShapeDescriptor[];
            const base: ShapeDescriptor = childDescriptors.length
                ? // #108 turns this into a `mutableCompound` when `dynamic` is set
                  { type: 'staticCompound', children: childDescriptors }
                : localDescriptor;
            return { ...base, position: transform.position, rotation: transform.rotation };
            // biome-ignore lint/correctness/useExhaustiveDependencies: subShapeVersion is what
            // tells us the children in `subShapes` changed
        }, [localDescriptor, transform, subShapeVersion]);

        //* Compound children ---------------------------------
        // callable function to add a shape to the compound shape. return the new index
        const addShape = useCallback((descriptor: ShapeDescriptor) => {
            const index = subShapes.current.length;
            subShapes.current.push(descriptor);
            setSubShapeVersion((version) => version + 1);
            return index;
        }, []);

        // modify the shape at the index - the compound is rebuilt from the new descriptors
        const modifyShape = useCallback((index: number, descriptor: ShapeDescriptor) => {
            const current = subShapes.current[index];
            // an unchanged child must not churn the compound (or re-render us for nothing)
            if (current && descriptorKey(current) === descriptorKey(descriptor)) return;
            subShapes.current[index] = descriptor;
            setSubShapeVersion((version) => version + 1);
        }, []);

        const removeShape = useCallback((index: number) => {
            subShapes.current[index] = undefined;
            setSubShapeVersion((version) => version + 1);
        }, []);

        //* Shape generation ----------------------------------
        /**
         * Wrap (or re-wrap) the base shape in a `ScaledShape`. The scaled shape takes its own
         * reference on the base, so the base stays alive; the superseded wrapper is released
         * here and is freed as soon as the body lets go of it.
         */
        // read through a ref so a new `scale` array with the same values does not change this
        // callback's identity (and with it every effect that depends on it)
        const scaleProp = useRef(scale);
        scaleProp.current = scale;
        const updateScaleShape = useCallback(() => {
            const base = baseShape.current;
            if (!base) return;
            const scale = scaleProp.current;
            const next = scale === undefined ? undefined : scaleShape(base, scale as number[]);
            releaseShape(scaledShape.current);
            scaledShape.current = next;
            appliedScaleKey.current = scaleKey;
            setShape(next ?? base);
        }, [scaleKey]);

        // creates the shape, releasing whatever it replaces. Idempotent: a re-run that does not
        // change the description (a re-render, a StrictMode double mount) does nothing.
        const generateOwnShape = useCallback(() => {
            const descriptor = resolveDescriptor();
            const key = descriptorKey(descriptor);
            if (key !== builtDescriptorKey.current) {
                // one reference, ours, released when it is replaced or the component unmounts
                const next = generateShape(descriptor);
                releaseShape(baseShape.current);
                baseShape.current = next;
                builtDescriptorKey.current = key;
                // any existing ScaledShape wrapped the shape we just dropped
                appliedScaleKey.current = undefined;
            }
            if (appliedScaleKey.current !== scaleKey) updateScaleShape();
            ref.current = { descriptor, shape: scaledShape.current ?? baseShape.current };
        }, [ref, resolveDescriptor, scaleKey, updateScaleShape]);

        // when the component mounts - and whenever anything that defines the shape changes -
        // (re)build it. A child of a compound hands its description to the parent instead.
        useEffect(() => {
            if (parentShape) {
                const descriptor = resolveDescriptor();
                const key = descriptorKey(descriptor);
                ref.current = { descriptor, shape: undefined };
                if (indexInParent.current === undefined)
                    indexInParent.current = parentShape.addShape(descriptor);
                else if (key !== registeredKey.current)
                    parentShape.modifyShape(indexInParent.current, descriptor);
                registeredKey.current = key;
                return;
            }
            if (dynamic && hasChildren)
                devWarn(
                    'react-three-jolt: <Shape dynamic> builds a static compound for now; mutable ' +
                        'compounds land with issue #108.'
                );
            generateOwnShape();
        }, [parentShape, resolveDescriptor, generateOwnShape, ref, dynamic, hasChildren]);

        // Release our references on unmount, and leave the parent compound. This must run on
        // unmount *only*: the parent's context value changes whenever its shape does, and
        // re-running this on that would drop the shape (or re-register this child under a new
        // index) in the middle of its life.
        const parentShapeRef = useRef(parentShape);
        parentShapeRef.current = parentShape;
        useEffect(
            () => () => {
                releaseShape(scaledShape.current);
                releaseShape(baseShape.current);
                scaledShape.current = undefined;
                baseShape.current = undefined;
                builtDescriptorKey.current = undefined;
                appliedScaleKey.current = undefined;
                if (parentShapeRef.current && indexInParent.current !== undefined) {
                    parentShapeRef.current.removeShape(indexInParent.current);
                    indexInParent.current = undefined;
                    registeredKey.current = undefined;
                }
            },
            []
        );

        // when the shape changes, hand it to the rigid body
        useEffect(() => {
            if (parentShape || !shape) return;
            // if we are the top level shape, we need to set the active shape
            rigidBody?.setActiveShape(shape);
        }, [shape, parentShape, rigidBody]);

        // A stable context value matters: a child's registration effect depends on it, so a new
        // object every render would have the child re-register, bump our version state, re-render
        // us, and loop forever.
        const context = useMemo(
            () => ({ shape, addShape, modifyShape, removeShape }),
            [shape, addShape, modifyShape, removeShape]
        );

        return <ShapeContext.Provider value={context}>{children}</ShapeContext.Provider>;
    })
);
Shape.displayName = 'Shape';
