// <SoftBody> (issue #243): builds a Jolt soft body from a child mesh's BufferGeometry and keeps
// the two in sync every frame - the soft-body counterpart of <RigidBody>.
import React, {
    Children,
    cloneElement,
    isValidElement,
    type ReactElement,
    useEffect,
    useRef,
    useState
} from 'react';
import type { Mesh } from 'three';
import { useForwardedRef, useJolt, useSoftBodyEvent } from '../hooks';
import type { SoftBodyEventMap } from '../systems/events';
import type {
    SoftBodyBendType,
    SoftBodyFixed,
    SoftBodyOptions,
    SoftBodyState
} from '../systems/soft-body-system';
import { devWarn } from '../utils';

export interface SoftBodyProps {
    /** Exactly one `<mesh>` element. Its geometry is consumed (merged/indexed) and driven by the
     * simulation every frame; its `position`/`rotation` seed the body's initial pose. */
    children: ReactElement;
    /** Receives the {@link SoftBodyState} once the body exists. */
    ref?: React.Ref<SoftBodyState | undefined>;

    /** Inflation pressure. `0` (default) is an unpressurized membrane. */
    pressure?: number;
    /** Compliance (inverse stiffness) of the structural edges. `0` (default) is rigid. */
    compliance?: number;
    /** Shear compliance for `CreateConstraints`. Defaults to {@link compliance}. */
    shearCompliance?: number;
    /** Bend compliance for `CreateConstraints`. Default `0`. */
    bendCompliance?: number;
    /** See {@link SoftBodyBendType}. Default `'distance'`. */
    bendType?: SoftBodyBendType;
    /** PBD solver iterations per substep. Jolt's default is `2`. */
    numIterations?: number;
    /** Multiplier on world gravity. Default `1`. */
    gravityFactor?: number;
    /** Velocity lost per second to drag. */
    linearDamping?: number;
    /** Friction against other bodies. Jolt's default is `0.2`. */
    friction?: number;
    /** Bounciness against other bodies. Jolt's default is `0`. */
    restitution?: number;
    /** Collision radius around every vertex. Jolt's default is `0.05`. */
    vertexRadius?: number;
    /** Jolt object layer. Default `Layer.MOVING`. */
    layer?: number;
    /** Whether the body's origin re-centers on the simulated shape every step. Default `true`. */
    updatePosition?: boolean;
    /** Total mass in kg, spread across the unpinned vertices. Default `1`kg per vertex. */
    mass?: number;
    /** Vertices to pin (`mInvMass = 0`): indices into the geometry after `mergeVertices`, or a
     * predicate over each vertex's local rest position. */
    fixed?: SoftBodyFixed;

    //* Events (issue #245) -------------------------------------------
    /** This soft body started touching another body. */
    onCollisionEnter?: SoftBodyEventMap['collisionEnter'];
    /** The contact was maintained this step. */
    onCollisionPersist?: SoftBodyEventMap['collisionPersist'];
    /** This soft body stopped touching another body. */
    onCollisionExit?: SoftBodyEventMap['collisionExit'];
    onSensorEnter?: SoftBodyEventMap['sensorEnter'];
    onSensorExit?: SoftBodyEventMap['sensorExit'];
    /** Synchronous, inside the step. Return `false` to reject the contact. */
    onContactValidate?: SoftBodyEventMap['contactValidate'];
}

export const SoftBody = React.memo(function SoftBody(props: SoftBodyProps) {
    const {
        children,
        ref: forwardedRef,
        onCollisionEnter,
        onCollisionPersist,
        onCollisionExit,
        onSensorEnter,
        onSensorExit,
        onContactValidate,
        ...optionProps
    } = props;
    const options = optionProps as SoftBodyOptions;

    const meshRef = useRef<Mesh | null>(null);
    // A plain ref for the exposed `ref` prop, plus `softBody` state (issue #245) so the event
    // wiring effects below re-run once the body actually exists - a mutable ref alone never
    // re-renders, so nothing could subscribe on the pass that creates the body.
    const stateRef = useForwardedRef(forwardedRef ?? null);
    const [softBody, setSoftBody] = useState<SoftBodyState>();
    const { softBodySystem } = useJolt();

    const built = useRef(false);

    useEffect(() => {
        if (!softBodySystem || built.current) return;
        const mesh = meshRef.current;
        if (!mesh) return;
        if (!mesh.geometry) {
            devWarn('r3/jolt: <SoftBody> child has no geometry yet; skipping this pass.');
            return;
        }
        built.current = true;
        const handle = softBodySystem.addBody(mesh, options);
        const next = softBodySystem.getBody(handle);
        if (!next) throw new Error('r3/jolt: <SoftBody> failed to create its body');
        stateRef.current = next;
        setSoftBody(next);
        // Deliberately [softBodySystem] only: creation options are read once, at mount - exactly
        // like <RigidBody>'s body-creation effect. Reactive updates to individual options are out
        // of scope for v1 (#243); changing them has no effect after the body exists.
    }, [softBodySystem]);

    useEffect(() => {
        return () => {
            const current = stateRef.current as SoftBodyState | undefined;
            if (current) softBodySystem.removeBody(current.handle);
            built.current = false;
            setSoftBody(undefined);
        };
        // Deliberately [] - unmount-only teardown.
    }, []);

    useSoftBodyEvent(softBody, 'collisionEnter', onCollisionEnter);
    useSoftBodyEvent(softBody, 'collisionPersist', onCollisionPersist);
    useSoftBodyEvent(softBody, 'collisionExit', onCollisionExit);
    useSoftBodyEvent(softBody, 'sensorEnter', onSensorEnter);
    useSoftBodyEvent(softBody, 'sensorExit', onSensorExit);
    useSoftBodyEvent(softBody, 'contactValidate', onContactValidate);

    const onlyChild = Children.only(children);
    if (!isValidElement(onlyChild))
        throw new Error('r3/jolt: <SoftBody> needs exactly one <mesh> child');

    return cloneElement(onlyChild as ReactElement<{ ref?: React.Ref<Mesh> }>, {
        ref: meshRef
    });
});

// Re-exported so a consumer can build `SoftBodyOptions` without reaching into `systems/`.
export type { SoftBodyBendType, SoftBodyFixed, SoftBodyOptions, SoftBodyState };
