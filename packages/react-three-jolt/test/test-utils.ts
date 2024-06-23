import ReactThreeTestRenderer from '@react-three/test-renderer';
import React, { useEffect } from 'react';
import { JoltContext, useJolt } from '../src';

export const JoltTestMount = ({ ready }: { ready: (context: JoltContext) => void }) => {
    const result = useJolt();

    useEffect(() => {
        ready(result);
    }, []);

    return null;
};

export const create = async (fn: (onReady: () => void) => React.ReactNode) => {
    let renderer: Awaited<ReturnType<typeof ReactThreeTestRenderer.create>> | null = null;

    const joltContext = await new Promise<JoltContext>(async (resolve, reject) => {
        try {
            renderer = await ReactThreeTestRenderer.create(fn(resolve as () => void));

            return;
        } catch (e) {
            reject(e);
        }
    });

    return { joltContext, renderer: renderer! };
};
