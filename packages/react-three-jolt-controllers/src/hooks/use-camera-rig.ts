import { useThree } from '@react-three/fiber';
import { useJolt } from '@react-three/jolt';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { CameraRigManager } from '../systems/camera-rig/camera-rig-system';

export function useCameraRig() {
    const { physicsSystem } = useJolt();
    //@ts-ignore
    const { camera, scene, controls } = useThree();
    const { set } = useThree(({ get, set }) => ({ get, set }));
    //@ts-ignore disable the active controls
    controls.enabled = false;
    // core rig
    const cameraRig = useMemo(() => {
        return new CameraRigManager(scene, physicsSystem);
    }, [physicsSystem]);
    const originalCamera = useRef(camera);
    const updateCamera = (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
        set({ camera: camera });
    };

    useEffect(() => {
        // create the camera listener first
        const cameraListener = cameraRig.onCamera((camera: THREE.PerspectiveCamera) => {
            updateCamera(camera);
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
