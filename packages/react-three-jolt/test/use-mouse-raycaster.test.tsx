// issue #47: useMouseRaycaster should build a world-space ray from the pointer/camera every
// frame and run a real Raycaster with it, exposing the result through a mutable ref (no React
// state churn) instead of forcing a re-render on every pointer/frame update.
//
// This mounts <Physics> for real (see use-constraint.test.tsx for the pattern) with a static box
// centered in front of r3f's default camera, points the (test-renderer) pointer at the canvas
// centre, advances one frame, and asserts the hook found the box.

import { useThree } from '@react-three/fiber';
import { create } from '@react-three/test-renderer';
import React, { act, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { assert, test } from 'vitest';
import { Physics } from '../src/components/Physics';
import { useJolt } from '../src/hooks';
import { useMouseRaycaster } from '../src/hooks/use-raycasters';
import type { RaycastHit } from '../src/systems/queries/raycasters';

// r3f's test renderer drives React directly, so opt in to act's queue flushing
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** `<Physics>` suspends while the wasm module loads, so let the tree settle first */
const settle = async (isReady: () => boolean) => {
    for (let i = 0; i < 100 && !isReady(); i++)
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
};

type Ready = {
    pointer: THREE.Vector2;
    hit: { current: RaycastHit | RaycastHit[] | undefined };
};

type HarnessProps = { onReady: (ready: Ready) => void };

/**
 * A static 2x2x2 box centered on the origin sits directly in front of r3f's default camera
 * (PerspectiveCamera at (0, 0, 5) looking toward -Z). A freshly created body doesn't need a
 * physics step to be raycastable (see raycasters.test.ts), so useMouseRaycaster should find it
 * as soon as the pointer points at the canvas centre.
 */
const Harness = ({ onReady }: HarnessProps) => {
    const { physicsSystem } = useJolt();
    const bodyCreated = useRef(false);
    if (!bodyCreated.current) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
        mesh.position.set(0, 0, 0);
        physicsSystem.bodySystem.addBody(mesh, { bodyType: 'static' });
        bodyCreated.current = true;
    }

    const pointer = useThree((state) => state.pointer);
    const { hit } = useMouseRaycaster();

    useEffect(() => {
        onReady({ pointer, hit });
    }, [pointer, hit]);

    return null;
};

test('useMouseRaycaster finds a body centered under the pointer (issue #47)', async () => {
    let ready: Ready | undefined;
    const renderer = await create(
        <Physics>
            <Harness onReady={(r) => (ready = r)} />
        </Physics>
    );

    await settle(() => ready !== undefined);
    assert.isDefined(ready, 'Physics never mounted its children');

    // point the pointer at the canvas centre - r3f's pointer already defaults to (0, 0) (NDC
    // centre), but set it explicitly so the test doesn't depend on that default.
    ready!.pointer.set(0, 0);

    // useMouseRaycaster's default mode ('frame') recasts every rendered frame
    await act(async () => {
        await renderer.advanceFrames(1, 1 / 60);
    });

    const hit = ready!.hit.current as RaycastHit | undefined;
    assert.isDefined(hit, 'expected the centered box to be hit from the canvas centre');
    // the default camera sits at (0, 0, 5) looking toward -Z; a 2x2x2 box at the origin presents
    // its +Z face at z = 1
    assert.closeTo(
        hit!.position.z,
        1,
        0.25,
        'expected the hit to land on the box face closest to the camera'
    );

    await renderer.unmount();
});
