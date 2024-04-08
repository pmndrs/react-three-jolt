// This is the core component that manages and stores the simulation
import * as THREE from 'three';
import Jolt from 'jolt-physics';
//import InitJolt from 'jolt-physics/wasm-compat'
import { suspend } from 'suspend-react';
import { Raw, initJolt } from '../raw';

import {
  createContext,
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useConst } from '../hooks';
// library imports
import FrameStepper from './FrameStepper';

// physics system import
import { PhysicsSystem } from '../systems/physics-system';
import { BodySystem } from '../systems/body-system';

// TODO: Move this to a better place
declare module 'three' {
  interface Mesh {
    shape: string;
  }
}

// stepping state object
export interface SteppingState {
  accumulator: number;
  previousState: Map<
    Jolt.Body,
    {
      position: THREE.Vector3;
      quaternion: THREE.Quaternion;
    }
  >;
}

// Context object
export interface JoltContext {
  jolt: typeof Jolt;
  physicsSystem: PhysicsSystem;
  bodySystem: BodySystem;
  joltInterface: Jolt.JoltInterface;
  beforeStepCallbacks: WorldStepCallbackSet;
  afterStepCallbacks: WorldStepCallbackSet;
  paused: boolean;
  debug: boolean;
  step: (dt: number) => void;
}

export const joltContext = createContext<JoltContext | undefined>(undefined);

// Core component

export const Physics: FC<PhysicsProps> = (props) => {
  const {
    defaultBodySettings,
    // TODO: determine and apply/remove these defaults
    children,
    gravity = [0, -9.81, 0],

    paused = false,
    interpolate = true,
    updatePriority,
    updateLoop = 'follow',
    debug = false,
  } = props;
  const beforeStepCallbacks = useConst<WorldStepCallbackSet>(() => new Set());
  const afterStepCallbacks = useConst<WorldStepCallbackSet>(() => new Set());

  // =================================================

  suspend(() => initJolt(), []);
  const jolt = Raw.module;
  const physicsSystem = useConst(() => new PhysicsSystem());
  // we have to pass this here to catch before body creation
  if (defaultBodySettings)
    physicsSystem.bodySystem.defaultBodySettings = defaultBodySettings;
  // setup the step
  const step = useCallback((dt: number) => {
    physicsSystem.onUpdate(dt);
  }, []);

  // These will be effects for props to send to the correct systems

  useEffect(() => {
    // if (gravity != null) physicsSystem.setGravity(gravity);
  }, [gravity]);

  const context: JoltContext = useMemo(
    () => ({
      jolt,
      physicsSystem,
      bodySystem: physicsSystem.bodySystem,
      joltInterface: physicsSystem.joltInterface,
      beforeStepCallbacks,
      afterStepCallbacks,
      paused,
      debug,
      step,
    }),
    [
      afterStepCallbacks,
      beforeStepCallbacks,
      debug,
      jolt,
      paused,
      physicsSystem,
      step,
    ]
  );

  return (
    <joltContext.Provider value={context}>
      <FrameStepper
        type={updateLoop}
        onStep={step}
        updatePriority={updatePriority}
      />
      {children}
    </joltContext.Provider>
  );
};
