import { useTexture } from '@react-three/drei';
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { applyHeightmapToPlane } from '../heightField/Generators';
import { useJolt, useUnmount } from '../hooks';

export type HeightfieldProps = {
    url?: string;
    texture?: string;
    width?: number;
    height?: number;
    size?: number;
    displacementScale?: number;
};

export function Heightfield({
    url,
    texture,
    width = 128,
    height = 128,
    size = 256,
    displacementScale = 256 * 0.1,
    ...props
}: HeightfieldProps) {
    const planeRef = useRef<THREE.Mesh>(null);
    const activeBody: React.MutableRefObject<number | null> = useRef(null);

    const { bodySystem } = useJolt();
    // try and load the url as a texture
    //@ts-ignore
    const urlTexture = useTexture(url);

    // if an image is passed use the drei image loader
    useEffect(() => {
        if (!planeRef.current) return;
        // because this could be updated in a frame loop we do this here
        // if texture use that, otherwise use the url texture
        if (!texture && urlTexture) {
            //@ts-ignore
            planeRef.current!.material.map = urlTexture;
        }
        planeRef.current.geometry.rotateX(-Math.PI / 2);

        // TODO: why did I do this async?
        async function getImageData() {
            if (url) {
                await applyHeightmapToPlane(planeRef.current as THREE.Mesh, url, displacementScale);
                // succeeded, if there's an existing body, remove it but keep the three object
                if (activeBody.current) bodySystem.removeBody(activeBody.current, true);

                // generate the jolt heightfield with the newly made three heightfield
                activeBody.current = bodySystem.addHeightfield(planeRef.current as THREE.Mesh);
            }
        }
        getImageData();
    }, [url, urlTexture, texture, displacementScale, bodySystem]);

    useUnmount(() => {
        if (activeBody.current) {
            bodySystem.removeBody(activeBody.current);
        }
    });

    return (
        <>
            <mesh ref={planeRef} {...props}>
                <planeGeometry args={[width, height, size - 1, size - 1]} />
                <meshStandardMaterial transparent={true} color="#8F2D56" side={THREE.DoubleSide} />
            </mesh>
        </>
    );
}
