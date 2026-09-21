// ridged body wrapping and mesh components
import type Jolt from 'jolt-physics';
import React, {
    Children,
    createContext,
    forwardRef,
    memo,
    type ReactNode,
    useCallback,
    useEffect,
    //  useLayoutEffect,
    useMemo,
    useRef
} from 'react';
import type { Object3D } from 'three';
import * as THREE from 'three';
import { useBodyEvent, useForwardedRef, useJolt, useUnmount } from '../hooks';
import {
    type AutoShape,
    type BodyState,
    type DynamicMeshStrategy,
    describeObject,
    descriptorKey,
    generateShape,
    makeDescriptorDynamicSafe,
    releaseShape,
    type ShapeDescriptor
} from '../systems';
import type { BodyType, GenerateBodyOptions } from '../systems/body-system';
import type { BodyEventMap } from '../systems/events';
import { devWarn, vec3 } from '../utils';
import { ShapeContext } from './shape/context';

interface RigidBodyProps {
    /** Optional so `createElement(RigidBody, props, ...children)` typechecks as JSX does. */
    children?: ReactNode;
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
    /**
     * What to do about the meshes inside this body - issue #155, rapier's prop of the same name.
     *
     * - left out (default): every mesh below the body contributes an automatically detected
     *   shape, exactly as before.
     * - `false`: no automatic shape at all. The body's shape is built only from the collider
     *   components (`<CuboidCollider>`, `<Shape>`, ...) inside it, so the meshes are purely
     *   visual.
     * - `'cuboid' | 'ball' | 'hull' | 'trimesh'`: force that shape for the meshes, the rapier
     *   spelling of this library's {@link AutoShape} names (`box` / `sphere` / `convex` /
     *   `trimesh`). Equivalent to `shape`, which still works.
     *
     * A body that has *both* meshes and colliders combines them into one compound: the mesh
     * shapes first, then the colliders in mount order.
     */
    colliders?: RigidBodyColliders;
    /**
     * What a **dynamic** body does with a trimesh shape (issue #112, #211). Jolt has no
     * mesh-vs-mesh collision, so an unconverted trimesh on a dynamic body falls straight through
     * the world. This was always reachable on `bodySystem.addBody`'s `GenerateBodyOptions` but
     * had no way to reach it from `<RigidBody>` itself.
     *
     * - left out (default): falls back to `<Physics defaultDynamicMeshStrategy>`, then
     *   `'convex'` - warn and use a convex hull of the same points.
     * - `'error'`: throw instead, so the mistake is loud.
     * - `'decompose'`: reserved for a convex decomposition; currently throws with an explanation.
     *
     * No effect on a static or kinematic body - a trimesh is always fine there.
     */
    dynamicMeshStrategy?: DynamicMeshStrategy;
    debug?: boolean;
    /**
     * Receives the {@link BodyState} once the body exists. `| undefined` because the usual
     * `useRef<BodyState>()` produces a `RefObject<BodyState | undefined>`.
     */
    ref?: React.Ref<BodyState | undefined>;
    allowObstruction?: boolean;
    obstructionTimelimit?: number;
    isSensor?: boolean;

    // Collision groups: the "these two specific objects shouldn't collide" filter. Bodies only
    // consult it when their `group` matches; `bodySystem.disableCollision(subA, subB)` then turns
    // off that one sub group pair. Broad categories stay on the object layer. Both are reactive.
    group?: number;
    subGroup?: number;

    //physics props
    /** Velocity lost per second to drag. Jolt's default is `0.05`. */
    linearDamping?: number;
    /** Angular velocity lost per second. Jolt's default is `0.05`. */
    angularDamping?: number;
    /**
     * How much this body resists sliding against another, `0` (ice) to `1` (glue). Jolt's
     * default is `0.2`, which is slippery - raise it for things that have to carry or be
     * carried. Reactive: changing it updates the existing body.
     */
    friction?: number;
    /**
     * How bouncy this body is, `0` (no bounce) to `1` (no energy lost). Jolt's default is `0`.
     * Reactive, like {@link friction}.
     */
    restitution?: number;
    /**
     * Multiplier on world gravity for this body: `0` floats, `2` falls twice as hard. Default
     * `1`. Only meaningful on a dynamic body.
     */
    gravityFactor?: number;
    scale?: number[];

    // dof
    lockRotations?: boolean;
    lockTranslations?: boolean;
    dof?: { x?: boolean; y?: boolean; z?: boolean; rotX?: boolean; rotY?: boolean; rotZ?: boolean };
    //TODO: do these work yet?

    mass?: number;
    // remove
    quaternion?: number[];

    /**
     * Whether `position`/`rotation`/`velocity`/`angularVelocity`/`scale`/`group`/`subGroup`
     * writes are allowed to wake this body (issue #167). Default `true`, matching every setter's
     * behavior before this prop existed. Turn it off to bulk-reposition sleeping bodies (e.g.
     * re-laying out scenery) without waking them - see `bodyState.activateOnChange` for the
     * per-call `{ activate }` override.
     */
    activateOnChange?: boolean;
    /**
     * Opt-in perf optimisation (issue #168): when `false`, the physics frame sync writes this
     * body's pose straight into `object.matrix` instead of `object.position`/`object.quaternion`,
     * and turns off three's own per-object `Object3D.matrixAutoUpdate`, skipping its automatic
     * matrix recompute entirely. Only correct when this `<RigidBody>`'s parent transform never
     * changes (the scene root, or a group that never moves/rotates/scales) - see
     * `bodyState.matrixAutoUpdate`. Default `true` (three's normal behavior, unchanged).
     */
    matrixAutoUpdate?: boolean;
}
export interface RigidBodyContext {
    body: BodyState | undefined;
    type: BodyType | undefined;
    // These four are the RigidBody's own props passed straight through, so they are the props'
    // `number[]` shape - not THREE.Vector3/Quaternion, which is what this interface used to
    // claim behind a blanket suppression on the value it was assigned (issue #11).
    position: number[] | undefined;
    rotation: number[] | undefined;
    scale: number[] | undefined;
    quaternion: number[] | undefined;
    // methods
    setActiveShape: (shape: Jolt.Shape | undefined) => void;
    /**
     * Tell the body its shape changed underneath it (#108: a `<Shape dynamic>` edits its
     * `MutableCompoundShape` in place rather than handing over a new shape, so `setActiveShape`
     * never fires and the body would keep the bounds and mass properties it was created with).
     */
    notifyShapeChanged?: (previousCenterOfMass?: [number, number, number]) => void;
    /**
     * #155: a collider announces itself, and whether it wants to be a sensor. Jolt's sensor flag
     * is per *body* (`Body::SetIsSensor`), so the body is the only thing that can arbitrate:
     * every collider sensor or none. Returns an unsubscribe.
     */
    declareCollider?: (token: object, info: { sensor?: boolean }) => () => void;
}
export const RigidBodyContext = createContext<RigidBodyContext | undefined>(undefined!);

/**
 * `<RigidBody colliders>` - `false` for "no automatic shape", or a rapier shape name.
 * See {@link RigidBodyProps.colliders}.
 */
export type RigidBodyColliders = false | 'cuboid' | 'ball' | 'hull' | 'trimesh';

/** rapier's collider names -> this library's {@link AutoShape} names. */
const COLLIDERS_TO_AUTO_SHAPE = {
    cuboid: 'box',
    ball: 'sphere',
    hull: 'convex',
    trimesh: 'trimesh'
} as const satisfies Record<Exclude<RigidBodyColliders, false>, AutoShape>;

/** Does this subtree contain anything that would produce an automatic shape? */
const hasMeshes = (object: Object3D): boolean => {
    let found = false;
    object.traverse((child) => {
        if (!found && child instanceof THREE.Mesh && child.geometry) found = true;
    });
    return found;
};

/** A child descriptor that sits at the body's origin needs no compound to hold it in place. */
const isAtOrigin = (descriptor: ShapeDescriptor): boolean => {
    const [x = 0, y = 0, z = 0] = descriptor.position ?? [];
    const [qx = 0, qy = 0, qz = 0, qw = 1] = descriptor.rotation ?? [];
    return x === 0 && y === 0 && z === 0 && qx === 0 && qy === 0 && qz === 0 && qw === 1;
};

/** Whether a body of this motion type is simulated (and so cannot hold a mesh shape - #112). */
const isDynamicType = (type: BodyType | undefined) =>
    type === undefined || type === 'dynamic' || type === 'rig';

/** A `<Shape>` or one of the named collider components - both carry the `isJoltShape` marker. */
type ShapeElement = React.ReactElement<{ position?: unknown; rotation?: unknown }>;
const isShapeElement = (child: ReactNode): child is ShapeElement => {
    const type = (child as { type?: { isJoltShape?: boolean; displayName?: string } })?.type;
    return !!type && (type.isJoltShape === true || type.displayName === 'Shape');
};

/**
 * Direct children, with fragments flattened. `Children.toArray` flattens arrays but not `<>...</>`
 * (it hands back the fragment element), and `<RigidBody>{cond ? <><A/><B/></> : <C/>}</RigidBody>`
 * is exactly how colliders get written - so a scan that stopped at the fragment would not see
 * them at all.
 */
const flattenChildren = (children: ReactNode, depth = 0): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const child of Children.toArray(children)) {
        const element = child as { type?: unknown; props?: { children?: ReactNode } };
        if (depth < 4 && element?.type === React.Fragment)
            out.push(...flattenChildren(element.props?.children, depth + 1));
        else out.push(child);
    }
    return out;
};

/**
 * Does this body have to *combine* several shapes into one compound, or can a single child own
 * the body's shape outright (which is what `<Shape>` has always done, and what keeps a
 * `<Shape dynamic>`'s `MutableCompoundShape` editable in place - #108)?
 *
 * Decided from the rendered children, so it is stable for a given tree and the answer never
 * changes underneath a child that has already mounted.
 */
const needsCompound = (children: ReactNode, colliders: RigidBodyColliders | undefined): boolean => {
    const all = flattenChildren(children);
    const shapes = all.filter(isShapeElement);
    if (shapes.length === 0) return false;
    if (shapes.length > 1) return true;
    // one collider with an offset: a root shape's transform is ignored (it would move the centre
    // of mass), so it only means anything inside a compound
    const { position, rotation } = shapes[0].props;
    if (position !== undefined || rotation !== undefined) return true;
    // one collider plus something that might draw: mesh shapes and the collider combine
    return colliders !== false && all.length > shapes.length;
};

// the ridgedBody is a forwardRef so we can pass props directly
// inital version from r3/rapier
export const RigidBody: React.FC<RigidBodyProps> = memo(
    forwardRef((props, forwardedRef) => {
        const {
            children,

            type,
            shape,
            colliders,
            dynamicMeshStrategy,
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
            restitution,
            gravityFactor,
            group,
            subGroup,
            activateOnChange,
            matrixAutoUpdate,

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

        //* Child colliders (issue #155) ----------------------
        // A <RigidBody> is a compound *host* when it has to combine several shapes: sibling
        // colliders, or a collider that has to sit alongside the shapes detected from the meshes.
        // Each child then registers a plain `ShapeDescriptor` here instead of every one of them
        // calling `setActiveShape` and the last one silently winning.
        //
        // When there is nothing to combine (the common case: one <Shape>, or meshes only) no
        // ShapeContext is provided at all and the child owns the body's shape exactly as before -
        // which is what keeps a `<Shape dynamic>` directly under a body editable in place (#108).
        const combining = needsCompound(children, colliders);

        /** `colliders` in this library's {@link AutoShape} spelling; `shape` is the older name. */
        const autoShape: AutoShape | undefined =
            colliders === false
                ? undefined
                : colliders
                  ? COLLIDERS_TO_AUTO_SHAPE[colliders]
                  : shape;

        const subShapes = useRef<(ShapeDescriptor | undefined)[]>([]);
        const [subShapeVersion, setSubShapeVersion] = React.useState(0);
        /** The compound this component built and owns one reference on. */
        const composedShape = useRef<Jolt.Shape | undefined>(undefined);
        const composedKey = useRef<string | undefined>(undefined);
        const composedDescriptor = useRef<ShapeDescriptor | undefined>(undefined);
        /** Whether the composed shape wraps its children (so a child really is a sub shape). */
        const wrappedInCompound = useRef(false);

        const addShape = useCallback((descriptor: ShapeDescriptor) => {
            const index = subShapes.current.length;
            subShapes.current.push(descriptor);
            setSubShapeVersion((version) => version + 1);
            return index;
        }, []);
        const modifyShape = useCallback((index: number, descriptor: ShapeDescriptor) => {
            const current = subShapes.current[index];
            // an unchanged child must not churn the body's shape
            if (current && descriptorKey(current) === descriptorKey(descriptor)) return;
            subShapes.current[index] = descriptor;
            setSubShapeVersion((version) => version + 1);
        }, []);
        const removeShape = useCallback((index: number) => {
            subShapes.current[index] = undefined;
            setSubShapeVersion((version) => version + 1);
        }, []);
        /** #13: is the child at `index` the body's whole shape rather than one sub shape? */
        const isSoleShape = useCallback(
            (index: number | undefined) =>
                !wrappedInCompound.current &&
                index !== undefined &&
                subShapes.current[index] !== undefined,
            []
        );

        //* Sensor policy (issue #155) ------------------------
        // Jolt has no per-sub-shape sensor, so every collider on a body has to agree.
        const declaredColliders = useRef(new Map<object, { sensor?: boolean }>());
        const [colliderVersion, setColliderVersion] = React.useState(0);
        const declareCollider = useCallback((token: object, info: { sensor?: boolean }) => {
            declaredColliders.current.set(token, info);
            setColliderVersion((version) => version + 1);
            return () => {
                declaredColliders.current.delete(token);
                setColliderVersion((version) => version + 1);
            };
        }, []);

        //* Composing the body's shape ------------------------
        // Declared before the body effect below so that on the very first commit - where child
        // effects have already registered their descriptors - the shape exists by the time the
        // body is created, rather than a render later.
        useEffect(() => {
            if (!combining) return;
            const registered = subShapes.current.filter(Boolean) as ShapeDescriptor[];
            if (!registered.length) return;
            const parts: ShapeDescriptor[] = [];
            // the meshes first, so a body's automatic shape keeps sub shape index 0
            if (colliders !== false && objectRef.current && hasMeshes(objectRef.current))
                parts.push(describeObject(objectRef.current, { type: autoShape }));
            parts.push(...registered);

            const compound = parts.length > 1 || !isAtOrigin(parts[0]);
            const composed: ShapeDescriptor = compound
                ? { type: 'staticCompound', children: parts }
                : parts[0];
            // #112/#211: jolt cannot simulate a dynamic body holding a mesh shape. The automatic
            // path in `generateBodySettings` does this for itself (and reads the same fallback
            // chain - see `BodySystem.createBody`); a shape we hand over here is ours to convert.
            const descriptor = isDynamicType(type)
                ? makeDescriptorDynamicSafe(
                      composed,
                      dynamicMeshStrategy ?? bodySystem.defaultDynamicMeshStrategy
                  )
                : composed;

            const key = descriptorKey(descriptor);
            if (key === composedKey.current) return;
            // one reference, ours, released when it is replaced or the body unmounts
            const next = generateShape(descriptor);
            releaseShape(composedShape.current);
            composedShape.current = next;
            composedKey.current = key;
            composedDescriptor.current = descriptor;
            wrappedInCompound.current = compound;
            // #13: keep the description beside the shape it built, so a contact's SubShapeID can
            // be traced back to the collider that produced it
            const state = rigidBodyRef.current as BodyState | undefined;
            if (state) state.shapeDescriptor = descriptor;
            setActiveShape(next);
        }, [
            combining,
            subShapeVersion,
            colliders,
            autoShape,
            type,
            rigidBodyRef,
            dynamicMeshStrategy,
            bodySystem
        ]);

        // the body is created after the shape, so it misses the assignment above exactly once
        useEffect(() => {
            if (body && composedDescriptor.current)
                body.shapeDescriptor = composedDescriptor.current;
        }, [body]);

        //* Load the body -------------------------------------
        // todo: we cant use useMount here because we need the shape dependencies
        useEffect(() => {
            if (!bodySystem || bodyLoaded.current) return;
            // detect if any of the children are shapes. The ref is the truth (a collider rendered
            // by somebody else's component is not visible to a scan of our own children); the
            // scan still runs so a shape that has declared itself but not yet registered - or a
            // combining body, whose shape arrives a render later - is waited for.
            let hasShapes = subShapes.current.some(Boolean);
            if (!hasShapes && children) hasShapes = flattenChildren(children).some(isShapeElement);
            // if the children are shapes, we will wait for them to mount
            if (hasShapes && !activeShape) return;
            // #155: `colliders={false}` means "the meshes are decoration"; with no collider
            // children there is nothing left to build a body out of.
            if (!activeShape && colliders === false) {
                devWarn(
                    'react-three-jolt: <RigidBody colliders={false}> has no collider children, ' +
                        'so there is no shape to create a body from. Add a <CuboidCollider> (or ' +
                        'another collider), or drop `colliders={false}`.'
                );
                return;
            }
            // todo: is this protection needed?
            if (objectRef.current) {
                //handle options from props
                const options: GenerateBodyOptions = {
                    group: group,
                    subGroup: subGroup,
                    shape: activeShape,
                    bodyType: type,
                    shapeType: autoShape,
                    shapeDescriptor: composedDescriptor.current,
                    // #211: reaches `generateBodySettings` for the plain "auto shape from meshes,
                    // no compound" case; when `activeShape` is already set, the compound effect
                    // above already converted any trimesh, so this has nothing left to do there.
                    dynamicMeshStrategy
                };
                //put the initial position, rotation, scale, and quaternion in the options
                if (position) objectRef.current.position.copy(vec3.three(position));
                if (rotation) objectRef.current.rotation.setFromVector3(vec3.three(rotation));

                const bodyHandle = bodySystem.addBody(objectRef.current, options);
                const body = bodySystem.getBody(bodyHandle);
                if (!body) throw new Error('Body not found');
                rigidBodyRef.current = body;
                bodyLoaded.current = true;
                setBody(body);

                // for cycle reasons some stuff might have gotten missed
                // try setting the debug
                if (debug) body.debug = debug;
                // #167 / #168: set before `position`/`rotation`/`scale` below so their initial
                // writes already respect whatever activation/matrix behavior was asked for.
                if (activateOnChange !== undefined) body.activateOnChange = activateOnChange;
                if (matrixAutoUpdate !== undefined) body.matrixAutoUpdate = matrixAutoUpdate;
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
            // #155: the compound this component composed out of its colliders is ours to release
            releaseShape(composedShape.current);
            composedShape.current = undefined;
            composedKey.current = undefined;
            composedDescriptor.current = undefined;
        });

        //*/ Debugging -------------------------------------

        useEffect(() => {
            if (rigidBodyRef.current) (rigidBodyRef.current as BodyState).debug = debug;
        }, [debug, rigidBodyRef]);

        //* Activation & matrix sync opt-ins (issues #167, #168) ----------
        useEffect(() => {
            if (!rigidBodyRef.current) return;
            const body = rigidBodyRef.current as BodyState;
            if (activateOnChange !== undefined) body.activateOnChange = activateOnChange;
            if (matrixAutoUpdate !== undefined) body.matrixAutoUpdate = matrixAutoUpdate;
        }, [activateOnChange, matrixAutoUpdate, rigidBodyRef]);

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

        // Physics material and mass properties. Keyed on `body` (the state, not the ref) so this
        // runs on the pass that creates the body - a body with <Shape> children does not exist on
        // the first pass, and a ref read in a dep array is not reactive, which is how `friction`
        // and friends used to be dropped entirely (#198).
        //
        // `!== undefined` throughout, not truthiness: `friction={0}` (ice) and
        // `gravityFactor={0}` (floats) are perfectly good values.
        useEffect(() => {
            if (!body) return;
            if (mass !== undefined) body.mass = mass;
            if (linearDamping !== undefined) body.linearDamping = linearDamping;
            if (angularDamping !== undefined) body.angularDamping = angularDamping;
            if (friction !== undefined) body.friction = friction;
            if (restitution !== undefined) body.restitution = restitution;
            if (gravityFactor !== undefined) body.gravityFactor = gravityFactor;

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
            body,
            mass,
            allowObstruction,
            obstructionTimelimit,
            linearDamping,
            angularDamping,
            friction,
            restitution,
            gravityFactor,
            isSensor
        ]);

        //* Sensor colliders (issue #155) ---------------------
        // Jolt's sensor flag is per body: `Body::SetIsSensor`, not per sub shape. So a `sensor`
        // collider inside a body cannot be honoured on its own. The policy, deliberately loud:
        //  - every collider on the body is a sensor (and no mesh contributes a solid shape):
        //    warn, and make the whole body a sensor;
        //  - a mix: throw, because "some of this body passes through you" is not something this
        //    engine can do and quietly picking one meaning would be worse.
        // Declared after the property effect above so it has the last word on `SetIsSensor`.
        useEffect(() => {
            if (!body) return;
            const declared = [...declaredColliders.current.values()];
            const sensors = declared.filter((collider) => collider.sensor).length;
            if (sensors === 0) return;
            const solidMeshes =
                colliders !== false && !!objectRef.current && hasMeshes(objectRef.current);
            if (sensors < declared.length || solidMeshes)
                throw new Error(
                    'react-three-jolt: jolt has no per-sub-shape sensors - `SetIsSensor` is a ' +
                        `property of the whole body. This body has ${sensors} sensor collider(s) ` +
                        `out of ${declared.length}${solidMeshes ? ', plus solid mesh shapes' : ''}` +
                        ', so it cannot be both. Either mark every collider `sensor` (and use ' +
                        '`colliders={false}` so the meshes stay decorative), or move the sensor ' +
                        'into its own <RigidBody isSensor>.'
                );
            if (isSensor === false) {
                devWarn(
                    'react-three-jolt: every collider on this body asks to be a `sensor` but the ' +
                        'body sets `isSensor={false}`. The explicit prop wins.'
                );
                return;
            }
            if (isSensor === undefined)
                devWarn(
                    'react-three-jolt: `sensor` is a body property in jolt, so this body has been ' +
                        'made a sensor because every collider on it asked for it. Set ' +
                        '`<RigidBody isSensor>` to say so directly.'
                );
            body.body.SetIsSensor(true);
        }, [body, colliderVersion, colliders, isSensor]);

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
                notifyShapeChanged,
                declareCollider
            };
        }, [
            body,
            type,
            position,
            rotation,
            scale,
            quaternion,
            notifyShapeChanged,
            declareCollider
        ]);

        // #155: only provided when this body has to combine several shapes. A stable value
        // matters - a child's registration effect depends on it, so a new object every render
        // would have it re-register, bump our version, re-render us, and loop.
        const shapeContext = useMemo(
            () =>
                combining
                    ? {
                          shape: activeShape,
                          addShape,
                          modifyShape,
                          removeShape,
                          isBodyRoot: true,
                          isSoleShape,
                          declareCollider
                      }
                    : undefined,
            [
                combining,
                activeShape,
                addShape,
                modifyShape,
                removeShape,
                isSoleShape,
                declareCollider
            ]
        );

        return (
            <RigidBodyContext.Provider value={contextValue}>
                <ShapeContext.Provider value={shapeContext}>
                    <object3D ref={objectRef} {...objectProps}>
                        {children}
                    </object3D>
                </ShapeContext.Provider>
            </RigidBodyContext.Provider>
        );
    })
);
