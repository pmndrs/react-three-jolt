// Demo: one-way platforms and per-sub-shape contact events (issue #13).
//
// Two things the contact pipeline gained are on show here:
//
//  - `onContactValidate` runs *synchronously inside* the physics step and its return value is
//    Jolt's answer, so returning false rejects the contact pair outright. A platform that
//    rejects anything approaching from below is the classic jump-through platform - and it is
//    a real rejection, not a collision that is undone afterwards, so nothing ever visibly
//    intersects.
//  - `<Shape userData name onCollisionEnter>` scopes a handler to one piece of a compound. The
//    lit-up panel is a single static body made of three `<Shape>` children; only the child that
//    was actually hit hears about it, via `payload.targetSubShape`.
import { Environment } from '@react-three/drei';
import { Physics, RigidBody, Shape, useJolt } from '@react-three/jolt';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useDemo } from '../App';

const PLATFORM_Y = 6;
const PANEL_COLORS = ['#e76f51', '#e9c46a', '#2a9d8f'];

export function OneWayPlatform() {
    const { debug, paused, interpolate, physicsKey, module } = useDemo();
    return (
        <Physics
            module={module}
            paused={paused}
            key={physicsKey}
            interpolate={interpolate}
            debug={debug}
        >
            <OneWayPlatformInner />
            <directionalLight castShadow position={[10, 20, 10]} shadow-bias={-0.0001} />
            <Environment preset="city" />
        </Physics>
    );
}

function OneWayPlatformInner() {
    // which panel of the compound floor was hit last, and how many times each has been hit
    const [hits, setHits] = useState<number[]>([0, 0, 0]);
    const bump = useCallback((panel: number) => {
        setHits((current) => current.map((n, i) => (i === panel ? n + 1 : n)));
    }, []);

    return (
        <>
            {/*
              The one-way platform. `onContactValidate` is the only handler in the library that
              runs inside `Step()`: it must be fast and must not touch bodies, so it does nothing
              but read the other body's velocity. Anything still moving upward is let through.
            */}
            <RigidBody
                type="static"
                position={[0, PLATFORM_Y, 0]}
                onContactValidate={(e) => {
                    const other = e.other.body;
                    if (!other) return true;
                    return other.velocity.y <= 0;
                }}
            >
                <mesh receiveShadow>
                    <boxGeometry args={[14, 0.4, 14]} />
                    <meshStandardMaterial color="#8ecae6" transparent opacity={0.65} />
                </mesh>
            </RigidBody>

            {/*
              One static body, one compound shape, three named children. Each <Shape> subscribes
              on the body and filters by its own sub shape, so a box landing on the middle panel
              only wakes the middle panel's handler.
            */}
            <RigidBody type="static" position={[0, -0.5, 0]}>
                <Shape>
                    {PANEL_COLORS.map((_, panel) => (
                        <Shape
                            key={panel}
                            name={`panel-${panel}`}
                            size={[8, 1, 24]}
                            position={[(panel - 1) * 8, 0, 0]}
                            onCollisionEnter={() => bump(panel)}
                        />
                    ))}
                </Shape>
            </RigidBody>

            {PANEL_COLORS.map((color, panel) => (
                <mesh
                    key={color}
                    position={[(panel - 1) * 8, -0.02, 0]}
                    rotation={[-Math.PI / 2, 0, 0]}
                >
                    <planeGeometry args={[7.6, 23.6]} />
                    <meshStandardMaterial
                        color={color}
                        emissive={color}
                        emissiveIntensity={Math.min(1, hits[panel] * 0.15)}
                    />
                </mesh>
            ))}

            <Launcher x={-8} />
            <Launcher x={0} />
            <Launcher x={8} />
        </>
    );
}

/**
 * A ball fired straight up through the platform. It passes on the way through and lands on it
 * coming back down, then is re-launched once it has settled - so the demo loops by itself.
 */
function Launcher({ x }: { x: number }) {
    const body = useRef<import('@react-three/jolt').BodyState | undefined>(undefined);
    const { physicsSystem } = useJolt();
    // The pending re-launch. Held so it can be cancelled: without this, navigating away left a
    // timer that fired ~700ms later and wrote `state.position` on a body whose world had already
    // been destroyed, which traps the wasm module ("memory access out of bounds").
    const relaunch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const launch = useCallback(() => {
        relaunch.current = undefined;
        const state = body.current;
        // the world can go away between the timer being set and it firing
        if (!state || physicsSystem.destroyed) return;
        state.position = new THREE.Vector3(x, 1, 0);
        state.velocity = new THREE.Vector3(0, 16, 0);
    }, [x, physicsSystem]);

    useEffect(
        () => () => {
            if (relaunch.current !== undefined) clearTimeout(relaunch.current);
            relaunch.current = undefined;
        },
        []
    );

    return (
        <RigidBody
            ref={body as never}
            position={[x, 1, 0]}
            // landing back on the floor is the cue to go round again
            onCollisionEnter={(e) => {
                if (!e.other.body || e.other.handle === undefined) return;
                // one pending launch at a time: the ball can report several contacts as it
                // settles, and each used to queue its own timer
                if (relaunch.current !== undefined) clearTimeout(relaunch.current);
                relaunch.current = setTimeout(launch, 700);
            }}
        >
            <mesh castShadow>
                <sphereGeometry args={[0.7, 24, 24]} />
                <meshStandardMaterial color="#264653" metalness={0.4} roughness={0.3} />
            </mesh>
        </RigidBody>
    );
}
