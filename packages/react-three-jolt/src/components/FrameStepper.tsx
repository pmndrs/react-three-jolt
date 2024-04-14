import { useFrame } from '@react-three/fiber';
import React, { memo, useEffect, useRef } from 'react';
import { PhysicsProps } from './Physics';

const useRaf = (callback: (dt: number) => void) => {
    const callbackRef = useRef(callback);
    const animationFrameRequest = useRef(0);
    const lastFrameTime = useRef(0);

    useEffect(() => {
        callbackRef.current = callback;
    }, [callback]);

    useEffect(() => {
        const loop = () => {
            const now = performance.now();
            const delta = now - lastFrameTime.current;

            animationFrameRequest.current = requestAnimationFrame(loop);
            callbackRef.current(delta / 1000);
            lastFrameTime.current = now;
        };

        animationFrameRequest.current = requestAnimationFrame(loop);

        return () => cancelAnimationFrame(animationFrameRequest.current);
    }, []);
};

type FrameStepperProps = {
    type?: PhysicsProps['updateLoop'];
    onStep: (dt: number) => void;
    updatePriority?: number;
};

const UseFrameStepper = ({ onStep, updatePriority }: FrameStepperProps) => {
    useFrame((_, dt) => {
        onStep(dt);
    }, updatePriority);

    return null;
};

const RafStepper = ({ onStep }: FrameStepperProps) => {
    useRaf((dt) => {
        onStep(dt);
    });

    return null;
};

export const FrameStepper = memo(({ onStep, type, updatePriority }: FrameStepperProps) => {
    return type === 'independent' ? (
        <RafStepper onStep={onStep} />
    ) : (
        <UseFrameStepper onStep={onStep} updatePriority={updatePriority} />
    );
});
