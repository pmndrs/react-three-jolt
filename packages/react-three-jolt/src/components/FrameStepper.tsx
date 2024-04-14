import { useFrame } from '@react-three/fiber';
import React, { memo, useEffect, useRef } from 'react';
import { PhysicsProps } from './Physics';

interface FrameStepperProps {
    type?: PhysicsProps['updateLoop'];
    onStep: (dt: number) => void;
    updatePriority?: number;
}

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
//@ts-ignore fix missing type value on props
const FrameStepper = ({ onStep, type, updatePriority }: FrameStepperProps) => {
    return type === 'independent' ? (
        <RafStepper onStep={onStep} />
    ) : (
        <UseFrameStepper onStep={onStep} updatePriority={updatePriority} />
    );
};

export default memo(FrameStepper);

// Moved this hook here because it's only used in this file
export const useRaf = (callback: (dt: number) => void) => {
    const cb = useRef(callback);
    const raf = useRef(0);
    const lastFrame = useRef(0);

    useEffect(() => {
        cb.current = callback;
    }, [callback]);

    useEffect(() => {
        const loop = () => {
            const now = performance.now();
            const delta = now - lastFrame.current;

            raf.current = requestAnimationFrame(loop);
            cb.current(delta / 1000);
            lastFrame.current = now;
        };

        raf.current = requestAnimationFrame(loop);

        return () => cancelAnimationFrame(raf.current);
    }, []);
};
