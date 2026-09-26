// Pointer-drag helper for the examples app (#305): none of the constraint/motor demos could be
// touched, so it was hard to see how a joint actually holds. Wrap a scene's <RigidBody> content
// in <Grabber> and every *dynamic* body becomes draggable: pointer down grabs the mesh at the
// hit point, drag moves it along a plane facing the camera, pointer up lets go. Not library code
// (examples-only helper for now, see the issue) - built entirely from the public API:
// `useConstraint('point', ...)` and `BodyState.setKinematicTarget`.
import { type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { type BodyState, RigidBody, useConstraint, useJolt } from '@react-three/jolt';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

const ANCHOR_RADIUS = 0.15;

/**
 * Walk up from the mesh the pointer actually hit to the nearest `<RigidBody>` it belongs to.
 * `BodyState`'s constructor stamps `userData.bodyHandle` onto the object3D it wraps (see
 * `body-state.ts`), which sits *above* whatever mesh/group the raycast reports as `event.object`.
 */
function findBodyHandle(object: THREE.Object3D | null): number | undefined {
    let current: THREE.Object3D | null = object;
    for (let depth = 0; current && depth < 8; depth++) {
        const handle = current.userData?.bodyHandle;
        if (handle !== undefined) return handle as number;
        current = current.parent;
    }
    return undefined;
}

/**
 * Mounted only while a body is being dragged. A kinematic anchor is point-constrained to the
 * body at the exact spot it was grabbed, then driven every frame at wherever the pointer now
 * projects onto the drag plane (see `Grabber`'s pointer handling below).
 *
 * Unmounting (drag end, or the page itself unmounting) tears the constraint down first and the
 * anchor body second: this component's own `useConstraint` cleanup runs before its child
 * `<RigidBody>`'s, because passive effects clean up parent-before-child - the reverse of the
 * child-before-parent order they were fired in. `BodySystem.removeBody` also drops any
 * constraint still referencing a body as a safety net (issue #82), so this is never load bearing,
 * just tidy.
 */
function DragAnchor({
    targetBody,
    initialPoint,
    pointerPoint
}: {
    targetBody: BodyState;
    initialPoint: [number, number, number];
    pointerPoint: { current: THREE.Vector3 };
}) {
    const anchorRef = useRef<BodyState | null>(null);
    // a plain ref, not a <RigidBody ref> - the target body already exists, this just hands
    // useConstraint something BodyStateRef-shaped to read.
    const targetRef = useRef<BodyState | null>(targetBody);
    targetRef.current = targetBody;

    // a point constraint fixes the anchor's origin to the exact point on the body that was
    // clicked, but leaves rotation free - dragging pinches the body at that one spot rather than
    // welding its whole orientation to the pointer.
    useConstraint('point', anchorRef, targetRef, { point1: initialPoint });

    useFrame(() => {
        anchorRef.current?.setKinematicTarget(pointerPoint.current);
    });

    return (
        <RigidBody ref={anchorRef} type="kinematic" isSensor position={initialPoint}>
            <mesh>
                <sphereGeometry args={[ANCHOR_RADIUS, 12, 12]} />
                <meshStandardMaterial color="#ffcc00" emissive="#ffaa00" emissiveIntensity={0.6} />
            </mesh>
        </RigidBody>
    );
}

interface DragState {
    body: BodyState;
    initialPoint: [number, number, number];
    /** camera-facing plane through the grabbed point, fixed for the duration of this drag */
    plane: THREE.Plane;
}

/** `useThree().controls` is typed as a bare `EventDispatcher` - camera-controls' `enabled` isn't
 * part of that type, same reason `App.tsx`'s `ControlWrapper` needs its own `@ts-expect-error`. */
type EnableToggle = { enabled: boolean };

/**
 * Wrap a scene's `<RigidBody>` content in this to make every *dynamic* body pointer-draggable
 * (#305). `CameraControls` (this app's `makeDefault`, read back through `useThree().controls`)
 * is disabled for the duration of a drag so dragging doesn't also orbit the camera.
 */
export function Grabber({ children }: { children: ReactNode }) {
    const { camera, gl, controls } = useThree();
    const { bodySystem } = useJolt();
    const [drag, setDrag] = useState<DragState | null>(null);
    const pointerPoint = useRef(new THREE.Vector3());
    const raycaster = useRef(new THREE.Raycaster());
    const capturedPointerId = useRef<number | null>(null);

    const setControlsEnabled = useCallback(
        (enabled: boolean) => {
            if (controls) (controls as unknown as EnableToggle).enabled = enabled;
        },
        [controls]
    );

    const projectToPlane = useCallback(
        (plane: THREE.Plane, clientX: number, clientY: number) => {
            const rect = gl.domElement.getBoundingClientRect();
            const ndc = new THREE.Vector2(
                ((clientX - rect.left) / rect.width) * 2 - 1,
                -((clientY - rect.top) / rect.height) * 2 + 1
            );
            raycaster.current.setFromCamera(ndc, camera);
            raycaster.current.ray.intersectPlane(plane, pointerPoint.current);
        },
        [camera, gl]
    );

    const endDrag = useCallback(() => {
        setDrag(null);
        setControlsEnabled(true);
        if (capturedPointerId.current !== null) {
            gl.domElement.releasePointerCapture(capturedPointerId.current);
            capturedPointerId.current = null;
        }
    }, [gl, setControlsEnabled]);

    // Native DOM listeners on the canvas, not r3f pointer props: once a drag starts the pointer
    // routinely leaves every raycastable mesh (empty background, the floor, ...) and r3f only
    // dispatches events for things the ray actually hits. `setPointerCapture` (called on grab,
    // below) keeps these targeted at the canvas even once the pointer strays outside it.
    useEffect(() => {
        if (!drag) return;
        const handleMove = (event: PointerEvent) =>
            projectToPlane(drag.plane, event.clientX, event.clientY);
        const handleUp = () => endDrag();
        const canvas = gl.domElement;
        canvas.addEventListener('pointermove', handleMove);
        canvas.addEventListener('pointerup', handleUp);
        canvas.addEventListener('pointercancel', handleUp);
        return () => {
            canvas.removeEventListener('pointermove', handleMove);
            canvas.removeEventListener('pointerup', handleUp);
            canvas.removeEventListener('pointercancel', handleUp);
        };
    }, [drag, gl, projectToPlane, endDrag]);

    // if the page unmounts mid drag (route change), hand the camera controls back
    useEffect(() => () => setControlsEnabled(true), [setControlsEnabled]);

    const handlePointerDown = useCallback(
        (event: ThreeEvent<PointerEvent>) => {
            if (drag || event.button !== 0) return;
            const handle = findBodyHandle(event.object);
            const body = handle !== undefined ? bodySystem.getBody(handle) : undefined;
            // only a dynamic body can be dragged - grabbing a static floor or a kinematic
            // platform would either do nothing (statics never move like this) or fight whatever
            // is already driving it.
            if (!body?.body.IsDynamic()) return;
            event.stopPropagation();

            const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
                cameraDirection,
                event.point
            );
            pointerPoint.current.copy(event.point);
            capturedPointerId.current = event.pointerId;
            gl.domElement.setPointerCapture(event.pointerId);
            setControlsEnabled(false);
            setDrag({
                body,
                initialPoint: event.point.toArray() as [number, number, number],
                plane
            });
        },
        [drag, bodySystem, camera, gl, setControlsEnabled]
    );

    return (
        <group onPointerDown={handlePointerDown}>
            {children}
            {drag && (
                <DragAnchor
                    targetBody={drag.body}
                    initialPoint={drag.initialPoint}
                    pointerPoint={pointerPoint}
                />
            )}
        </group>
    );
}
