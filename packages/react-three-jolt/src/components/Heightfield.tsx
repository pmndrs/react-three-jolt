import { useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';

import { useJolt } from '../hooks';

import {
    imageUrlToImageData,
    applyHeightmapToPlane
} from '../heightField/Generators';
import React from 'react';

type HeightfieldProps = {
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

    const { bodySystem } = useJolt();
    // try and load the url as a texture
    const urlTexture = useTexture(url);

    // if an image is passed use the drei image loader
    useEffect(() => {
        if (!planeRef.current) return;
        // because this could be updated in a frame loop we do this here
        // if texture use that, otherwise use the url texture
        if (!texture && urlTexture) {
            planeRef.current!.material.map = urlTexture;
        }
        planeRef.current.geometry.rotateX(-Math.PI / 2);

        /* copilot generated code
        if (texture) {
            const loader = new THREE.TextureLoader();
            loader.load(texture, (texture) => {
                urlTexture.image = texture.image;
                urlTexture.needsUpdate = true;
            });
            */
        async function getImageData() {
            if (url) {
                await applyHeightmapToPlane(
                    planeRef.current as THREE.Mesh,
                    url,
                    displacementScale
                );
                // generate the jolt heightfield with the newly made three heightfield
                bodySystem.addHeightfield(planeRef.current as THREE.Mesh);
            }
        }
        getImageData();
    }, [url, urlTexture, texture, displacementScale, bodySystem]);

    return (
        <>
            <mesh ref={planeRef} {...props}>
                <planeGeometry args={[width, height, size - 1, size - 1]} />
                <meshStandardMaterial
                    transparent={true}
                    //opacity={0.2}
                    color="#8F2D56"
                    side={THREE.DoubleSide}
                />
            </mesh>
        </>
    );
}
