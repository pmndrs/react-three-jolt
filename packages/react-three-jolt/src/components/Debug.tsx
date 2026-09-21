// The `<Physics debug>` wireframe collider overlay (issue #158).
//
// All of the work lives in `systems/debug-renderer.ts`; this is the react lifecycle around it.
// `<Physics debug>` renders one of these for you, but it is exported so it can be mounted on its
// own - e.g. `<Debug showContacts />` inside a `<Physics>` that is otherwise not in debug mode.

import { useFrame } from '@react-three/fiber';
import React, { useEffect, useState } from 'react';
import { useJolt } from '../hooks';
import { DebugRenderer, type DebugRendererOptions } from '../systems/debug-renderer';

export interface DebugProps extends DebugRendererOptions {
    /**
     * `useFrame` priority for the overlay update. Leave it alone unless `<Physics>` is running
     * with a non-zero `updatePriority`, in which case this has to be higher, so the overlay is
     * updated after the step that produced the poses it draws.
     * @default 0
     */
    updatePriority?: number;
}

/**
 * A wireframe of every collider in the world, coloured by motion type (grey static, blue
 * kinematic, green dynamic, yellow sleeping, magenta sensor), plus constraint anchors and -
 * with `showContacts` - contact points and normals.
 *
 * It is render-only: it reads body poses and shapes and writes three.js matrices, never the
 * other way round, so having it mounted cannot change the simulation.
 */
export function Debug({
    updatePriority = 0,
    colors,
    showConstraints,
    showContacts,
    contactNormalLength,
    maxContacts,
    depthTest
}: DebugProps) {
    const { physicsSystem } = useJolt();
    // Created in an effect rather than a `useMemo`, so StrictMode's mount/unmount/mount does not
    // leave a disposed renderer behind - and so the overlay's subscriptions are made and unmade
    // in the same phase.
    const [renderer, setRenderer] = useState<DebugRenderer>();

    useEffect(() => {
        if (!physicsSystem) return;
        const instance = new DebugRenderer(physicsSystem);
        setRenderer(instance);
        return () => {
            instance.dispose();
            setRenderer(undefined);
        };
    }, [physicsSystem]);

    // Options are pushed into the live renderer instead of rebuilding it: a colour change must
    // not throw away every cached geometry.
    useEffect(() => {
        renderer?.setOptions({
            colors,
            showConstraints,
            showContacts,
            contactNormalLength,
            maxContacts,
            depthTest
        });
    }, [
        renderer,
        colors,
        showConstraints,
        showContacts,
        contactNormalLength,
        maxContacts,
        depthTest
    ]);

    useFrame(() => {
        renderer?.update();
    }, updatePriority);

    if (!renderer) return null;
    return <primitive object={renderer.object} />;
}
