// Compile-time coverage for `<RigidBody ref>` (issues #49, #148).
//
// `RigidBody` used to be `React.FC<RigidBodyProps> = memo(forwardRef((props, forwardedRef) =>
// ...))`: a `forwardRef` wrapper around a `ref` that was already declared as a plain prop on
// `RigidBodyProps`, which is exactly the self-contradictory shape #49 asked to resolve. Converting
// it to a plain function component with `ref` as an ordinary prop must not change what a caller's
// `ref` is allowed to be.
//
// There is no `vitest --typecheck` runner wired up for this package (see `typed-helpers.test.ts`);
// `yarn test` runs `tsc -p tsconfig.test.json` before vitest, so a real type error below - an
// unused `@ts-expect-error`, or a genuine mismatch with none - fails the test run even though the
// `test()` bodies themselves do nothing at runtime.
import React, { useRef } from 'react';
import * as THREE from 'three';
import { test } from 'vitest';
import { RigidBody } from '../src/components/RigidBody';
import type { BodyState } from '../src/systems/body-state';

test('a useRef<BodyState>(null) is a valid <RigidBody ref>', () => {
    const ref = useRef<BodyState>(null);
    // `void` keeps this from being reported as an unused expression; nothing here is rendered.
    void (<RigidBody ref={ref} />);
});

test('a useRef<BodyState | undefined>(undefined) is a valid <RigidBody ref>', () => {
    // `RigidBodyProps.ref` is `React.Ref<BodyState | undefined>` specifically because the usual
    // `useRef<BodyState>()` (no initial value) produces this shape, not `RefObject<BodyState>`.
    const ref = useRef<BodyState | undefined>(undefined);
    void (<RigidBody ref={ref} />);
});

test('a ref of the wrong type is rejected', () => {
    const wrongType = useRef<number>(null);
    // @ts-expect-error -- a `number` ref cannot receive a `BodyState`
    void (<RigidBody ref={wrongType} />);

    const wrongObject = useRef<THREE.Object3D>(null);
    // @ts-expect-error -- an `Object3D` ref is not a `BodyState` ref either, even though
    // `<RigidBody>` renders an `<object3D>` internally
    void (<RigidBody ref={wrongObject} />);
});
