import { useMemo, useEffect } from 'react';
import { useJolt } from '@react-three/jolt';
import { useThree } from '@react-three/fiber';
import { CameraRigManager } from '../systems/camera-rig/camera-rig-system';
import * as THREE from 'three';

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
    const updateCamera = (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
        set({ camera: camera });
        console.log('controls', controls);
    };

    useEffect(() => {
        // create the camera listener first
        const cameraListener = cameraRig.onCamera((camera: THREE.PerspectiveCamera) => {
            console.log('updating camera', camera);
            updateCamera(camera);
        });
        return () => {
            cameraListener();
        };
    }, []);

    return cameraRig;
}
