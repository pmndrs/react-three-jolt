import { useThree } from '@react-three/fiber';
import { useJolt } from '@react-three/jolt';
import { useEffect, useMemo, useRef } from 'react';
import type * as THREE from 'three';
import { CameraRigManager, type CameraRigOptions } from '../systems/camera-rig/camera-rig-system';

/**
 * Create (and own) a {@link CameraRigManager}.
 *
 * `options` reach the manager's constructor, so the boom's length, pitch limits, collision
 * radius, follow target and smoothing are all set before the rig is ever stepped - issue #86 was
 * that the hook built a default rig, let it attach to the physics loop, and only then mutated it
 * into shape. Changing `options` afterwards updates the live rig through `setOptions()`; the
 * manager itself is memoised and is never rebuilt for a prop change.
 */
export function useCameraRig(options: CameraRigOptions = {}) {
    const { physicsSystem } = useJolt();
    //@ts-ignore
    const { camera, scene, controls } = useThree();
    const { set } = useThree(({ get, set }) => ({ get, set }));
    //@ts-ignore disable the active controls
    controls.enabled = false;

    // read inside useMemo so the first rig is built *with* the options without making the
    // manager's identity depend on a prop object that is new on every render
    const optionsRef = useRef(options);
    optionsRef.current = options;

    // core rig
    const cameraRig = useMemo(() => {
        return new CameraRigManager(scene, physicsSystem, optionsRef.current);
    }, [physicsSystem, scene]);

    // `options` is almost always a fresh object literal, so compare the values rather than the
    // identity: re-applying every render would fight the boom's own easing every frame.
    const appliedOptions = useRef(options);
    useEffect(() => {
        if (appliedOptions.current === options) return;
        if (shallowEqual(appliedOptions.current, options)) return;
        appliedOptions.current = options;
        cameraRig.setOptions(options);
    });

    const originalCamera = useRef(camera);
    const updateCamera = (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
        set({ camera: camera });
    };

    useEffect(() => {
        // create the camera listener first
        const cameraListener = cameraRig.onCamera((camera) => {
            if (camera) updateCamera(camera);
        });
        return () => {
            cameraListener();
            // reset the camera
            updateCamera(originalCamera.current);
            // the rig owns a CameraBoom (a raycaster, a shapecaster and a shape collider), its
            // rig-point bodies and a pre-step listener; nothing used to free any of it (#139)
            cameraRig.destroy();
        };
    }, [cameraRig]);

    return cameraRig;
}

const shallowEqual = (a: object, b: object) => {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) if (!Object.is(left[key], right[key])) return false;
    return true;
};
