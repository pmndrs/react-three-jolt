// Base demo copied from r3/rapier
//import * as THREE from 'three';
import { CameraControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { vec3 } from '@react-three/jolt';
import type Jolt from 'jolt-physics';
import { useControls } from 'leva';
import { Perf } from 'r3f-perf';
import type { JSX } from 'react';
import {
    createContext,
    //ReactNode,
    //StrictMode,
    Suspense,
    useContext,
    useEffect,
    useMemo,
    //useRef,
    //useEffect,
    useState
} from 'react';
import { NavLink, type NavLinkProps, Route, Routes, useLocation } from 'react-router';
import { BallBox } from './examples/BallBox';
import { CharacterVirtualDemo } from './examples/CharacterVirtualDemo';
import { Constraints } from './examples/Constraints';
import { CubeHeap } from './examples/CubeHeap';
import { FloatingPlatforms } from './examples/FloatingPlatforms';
import { FooterFunnel } from './examples/FooterFunnel';
import { FourWheelDemo } from './examples/FourWheelsWithHeightmap';
import { HeightfieldDemo } from './examples/Heightfield';
import { Impulses } from './examples/Impulses';
import { JustBoxes } from './examples/JustBoxes';
import { MotionSources } from './examples/motionSources';
import { OneWayPlatform } from './examples/OneWayPlatform';
import { PoweredRagdoll } from './examples/PoweredRagdoll';
import { Ragdolls } from './examples/Ragdolls';
//* All the examples ------------------------------
import { RaycastManyDemo } from './examples/RaycastManyDemo';
import { RaycastSimpleDemo } from './examples/RaycastSimpleDemo';
import { JoltMemoryReadout } from './JoltMemoryReadout';
import {
    getJoltFactory,
    JOLT_VARIANTS,
    type JoltVariant,
    readVariantFromLocation,
    setVariantInLocation
} from './joltModules';

const demoContext = createContext<{
    debug: boolean;
    paused: boolean;
    interpolate: boolean;
    physicsKey: number;
    /** The jolt-physics build variant `<Physics module>` should initialise (issue #22 / #54). */
    module: () => Promise<typeof Jolt>;
}>({
    debug: false,
    paused: false,
    interpolate: true,
    physicsKey: 0,
    module: getJoltFactory('wasm-compat')
});

export const useDemo = () => useContext(demoContext);

const ToggleButton = ({
    label,
    value,
    onClick
}: {
    label: string;
    value: boolean;
    onClick(): void;
}) => (
    <button
        style={{
            background: value ? 'red' : 'transparent',
            border: '2px solid red',
            color: value ? 'white' : 'red',
            borderRadius: 4
        }}
        onClick={onClick}
    >
        {label}
    </button>
);

//* Controls Wrapper. We have to do this to get root state
export function ControlWrapper(props: any) {
    const { position = [0, 10, 10], target = [0, 1, 0], transition = true, ...rest } = props;
    const { controls } = useThree();
    useEffect(() => {
        if (!controls) return;
        const newPosition = vec3.three(position);
        const newTarget = vec3.three(target);
        //@ts-expect-error can't get the types to work here
        controls.setLookAt(
            newPosition.x,
            newPosition.y,
            newPosition.z,
            newTarget.x,
            newTarget.y,
            newTarget.z,
            transition
        );
        // `controls` is included so that on a cold mount -- where CameraControls
        // registers itself into the r3f store *after* this effect's first run --
        // we retry once it becomes available instead of leaving the camera at
        // camera-controls' internal default framing forever (see #182).
    }, [position, controls]);
    return <CameraControls makeDefault {...rest} />;
}
// Renamed from `Routes` (pre-existing `lint/suspicious/noRedeclare`): it collided with
// react-router's own `Routes` component, imported above for the `<Routes>` JSX below.
type RouteMap = {
    [key: string]: {
        position?: number[];
        target?: number[];
        transition?: boolean;
        background?: string;
        element: JSX.Element;
        label?: string;
    };
};

const routes: RouteMap = {
    '': {
        position: [2, 5, 30],
        target: [0, 1, 10],
        background: '#f0544f',
        element: <RaycastSimpleDemo />
    },

    RaycastMany: {
        position: [0, 0, 5],
        target: [0, 0, 0],
        background: '#3d405b',
        element: <RaycastManyDemo />
    },
    Heightfield: {
        position: [150, 110, 150],
        target: [0, 0, 0],
        background: '#3d405b',
        element: <HeightfieldDemo />
    },
    CubeHeap: {
        position: [2, 25, 51],
        target: [0, 1, 10],
        background: '#3d405b',
        element: <CubeHeap />
    },
    FloatingPlatforms: {
        label: 'Floating Platforms',
        position: [0, 30, 60],
        target: [0, 5, 0],
        background: '#264653',
        element: <FloatingPlatforms />
    },
    OneWayPlatform: {
        label: 'One-Way Platform',
        position: [0, 14, 34],
        target: [0, 5, 0],
        background: '#1d3557',
        element: <OneWayPlatform />
    },
    Vehicle: {
        position: [2, 25, 51],
        target: [0, 1, 10],
        background: '#3d405b',
        element: <FourWheelDemo />
    },
    Character: {
        position: [2, 25, 51],
        target: [0, 1, 10],
        background: '#3d405b',
        element: <CharacterVirtualDemo />
    },
    // just for current dev purposes
    Boxes: {
        position: [-10, 5, 15],
        target: [0, 1, 10],
        background: '#3d405b',
        element: <JustBoxes />
    },
    Impulses: {
        position: [0, 0, 20],
        target: [0, 0, 0],
        background: '#141622',
        element: <Impulses />
    },
    MotionSources: {
        label: 'Motion Sources',
        position: [0, 25, 15],
        target: [0, 1, -15],
        background: '#C1839F',
        element: <MotionSources />
    },
    BallBoxes: {
        position: [0, 0, 30],
        target: [0, 0, 0],
        transition: false,
        background: '#141622',
        element: <BallBox />
    },
    Constraints: {
        position: [0, 34, 62],
        target: [0, 8, -8],
        background: '#3d405b',
        element: <Constraints />
    },
    FooterFunnel: {
        label: 'Footer Funnel',
        position: [0, 2, 40],
        target: [0, 2, 0],
        transition: false,
        background: '#141622',
        element: <FooterFunnel />
    },
    Ragdolls: {
        position: [6, 6, 12],
        target: [0, 2, 0],
        background: '#2b2138',
        element: <Ragdolls />
    },
    PoweredRagdoll: {
        label: 'Powered Ragdoll',
        position: [0, 4, 10],
        target: [0, 1.5, 0],
        background: '#2b2138',
        element: <PoweredRagdoll />
    }
};

export const App = () => {
    // state
    const [debug, setDebug] = useState<boolean>(false);
    const [perf, setPerf] = useState<boolean>(false);
    const [paused, setPaused] = useState<boolean>(false);
    const [interpolate, setInterpolate] = useState<boolean>(true);
    const [physicsKey, setPhysicsKey] = useState<number>(0);

    // Which jolt-physics build backs every <Physics> world this session (issue #22 / #54). Read
    // once from `?jolt=` - `initJolt` refuses to swap modules while a world exists, and every
    // route here mounts/unmounts its own world, so changing this after the fact means reloading
    // (see `setVariantInLocation`), not updating this piece of state.
    const [variant] = useState<JoltVariant>(() => readVariantFromLocation());
    const joltModule = useMemo(() => getJoltFactory(variant), [variant]);
    useControls('Jolt Module (reloads on change)', {
        build: {
            value: variant,
            options: JOLT_VARIANTS,
            onChange: (value: JoltVariant, _key, { initial }) => {
                if (initial || value === variant) return;
                setVariantInLocation(value);
            }
        }
    });

    // visuals
    const [background, setBackground] = useState<string>('#3d405b');
    const [cameraProps, setCameraProps] = useState<{
        position: any;
        target: any;
        transition: boolean;
    } | null>(null);
    const location = useLocation();

    // this triggers a reset of the physics world
    const updatePhysicsKey = () => {
        setPhysicsKey((current) => current + 1);
    };

    // when the route changes move the camera
    useEffect(() => {
        // set the camera position
        const route = routes[location.pathname.replace('/', '')];
        setCameraProps({
            position: route.position,
            target: route.target,
            transition: route.transition!
        });
        setBackground(route.background || '#3d405b');
    }, [location]);

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                fontFamily: 'sans-serif'
            }}
        >
            <Suspense fallback="Loading...">
                <Canvas
                    shadows
                    dpr={1}
                    camera={{ near: 1, fov: 45, position: cameraProps?.position }}
                >
                    <color attach="background" args={[background]} />

                    <ControlWrapper
                        position={cameraProps?.position}
                        target={cameraProps?.target}
                        transition={cameraProps?.transition}
                    />
                    <demoContext.Provider
                        value={{ debug, paused, interpolate, physicsKey, module: joltModule }}
                    >
                        <Routes>
                            {Object.keys(routes).map((key) => (
                                <Route path={key} key={key} element={routes[key].element} />
                            ))}
                        </Routes>
                    </demoContext.Provider>
                    {perf && <Perf position="top-left" minimal className="perf" />}
                </Canvas>
                <JoltMemoryReadout variant={variant} />
            </Suspense>

            <div
                style={{
                    position: 'absolute',
                    bottom: 24,
                    left: 24,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    maxWidth: 600
                }}
            >
                {Object.keys(routes).map((key) => (
                    <Link key={key} to={key} end>
                        {routes[key].label || key.replace(/-/g, ' ') || 'Raycaster'}
                    </Link>
                ))}

                <ToggleButton label="Debug" value={debug} onClick={() => setDebug((v) => !v)} />
                <ToggleButton label="Perf" value={perf} onClick={() => setPerf((v) => !v)} />
                <ToggleButton label="Paused" value={paused} onClick={() => setPaused((v) => !v)} />
                <ToggleButton
                    label="Interpolate"
                    value={interpolate}
                    onClick={() => setInterpolate((v) => !v)}
                />
                <ToggleButton label="Reset" value={false} onClick={updatePhysicsKey} />
            </div>
        </div>
    );
};

const Link = (props: NavLinkProps) => {
    return (
        <NavLink
            {...props}
            style={({ isActive }) => ({
                border: '2px solid #311847',
                textTransform: 'capitalize',
                borderRadius: 4,
                padding: 4,
                background: isActive ? '#311847' : 'transparent',
                textDecoration: 'none',
                color: isActive ? 'white' : '#311847'
            })}
        />
    );
};
