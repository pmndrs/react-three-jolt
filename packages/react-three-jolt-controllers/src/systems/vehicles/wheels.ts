import * as THREE from 'three';
//import type Jolt from 'jolt-physics';

import { Raw, vec3, quat, joltPropName } from '@react-three/jolt';

//* Types ====================================
export type VehicleFourWheelSettings = {
    type?: string;
    bodyPosition: Vector;
    castType: string;
    wheelRadius?: number;
    wheelWidth?: number;
    vehicleLength?: number;
    vehicleWidth?: number;
    vehicleHeight?: number;
    fourWheelDrive?: boolean;
    frontBackLimitedSlipRatio?: number;
    leftRightLimitedSlipRatio?: number;
    antiRollbar?: boolean;
    vehicleMass?: number;
    maxEngineTorque?: number;
    clutchStrength?: number;
    previousForward?: number;

    // DS additional Settings
    splitEngineTorqueFront?: number;
    splitEngineTorqueRear?: number;
    //rollbar stiffness
    frontRollBarStiffness?: number;
    rearRollBarStiffness?: number;
    wheels: WheelSettingsFourWheelOveride;
};
export type Vector = [number, number, number];
// see https://jrouwe.github.io/JoltPhysics/class_wheel_settings_w_v.html
export interface WheelSettings {
    inertia?: number;
    angularDamping?: number;
    width?: number;
    radius?: number;
    //attachment point to the body in local space [0,0,0]
    position?: Vector;
    // where force is applied, best to be center of wheel [0,0,0]
    suspensionForcePoint?: Vector;
    // should point down [0, -1, 0]
    suspensionDirection?: Vector;
    //think like a bike suspension pointing towards the bike [0,1,0]
    steeringAxis?: Vector;
    // can be used to give camber
    wheelUp?: Vector;
    //can be used to give toe
    wheelForward?: Vector;
    suspensionMinLength?: number; //0.3
    suspensionMaxLength?: number; //0.5
    //gives the springs more bounce
    suspensionPreloadLength?: number; //0.0
    //DONT USE THIS
    enableSuspensionForcePoint?: boolean;
    //springs
    SuspensionSpring?: { frequency: number; damping: number };
}
export interface WheelSettingsFourWheel extends WheelSettings {
    // Four WHeel settings
    maxSteerAngle?: number; //1.22 radians(70 degrees
    //Longitudinal Friction amd Lateral Friction are in curves
    // not messing with them for now
    maxBrakeTorque?: number; // 1500
    maxHandBrakeTorque?: number; // 4000
}
interface WheelSettingsFourWheelOveride extends WheelSettingsFourWheel {
    fl: WheelSettingsFourWheel;
    fr: WheelSettingsFourWheel;
    bl: WheelSettingsFourWheel;
    br: WheelSettingsFourWheel;
}

//* End Types ====================================
export class WheelState {
    index: number;
    constraint;
    threeObject = new THREE.Object3D();
    //@ts-ignore ts bug, created in createDebugWheel
    debugObject: THREE.Mesh;
    // because jolt isnt ready we'll put these here
    wheelRight = new Raw.module.Vec3(0, 1, 0);
    wheelUp = new Raw.module.Vec3(1, 0, 0);
    //true for now
    //TODO change this to default to false
    private isDebugging = true;
    set debug(value) {
        this.isDebugging = value;
        if (value) this.debugObject.visible = true;
        else this.debugObject.visible = false;
    }
    get debug() {
        return this.isDebugging;
    }
    // Im not sure we need this but I'll leave it for now
    wheelSettings;
    joltWheel;
    constructor(constraint: any, wheelIndex: number) {
        this.constraint = constraint;
        this.index = wheelIndex;
        this.joltWheel = constraint.GetWheel(wheelIndex);
        this.wheelSettings = this.joltWheel.GetSettings();
        this.createDebugWheel();
    }
    createDebugWheel() {
        const geometry = new THREE.CylinderGeometry(
            this.wheelSettings.mRadius,
            this.wheelSettings.mRadius,
            this.wheelSettings.mWidth,
            20,
            1
        );
        const mesh = new THREE.Mesh(geometry, getWheelMaterial());
        this.debugObject = mesh;
        this.threeObject.add(mesh);
        return mesh;
    }
    add(object: THREE.Object3D) {
        this.threeObject.add(object);
    }
    // set the wheel position and rotation
    updateLocalTransform() {
        if (!this.threeObject) return;
        const transform = this.constraint.GetWheelLocalTransform(
            this.index,
            this.wheelRight,
            this.wheelUp
        );

        this.threeObject.position.copy(vec3.three(transform.GetTranslation()));
        this.threeObject.quaternion.copy(quat.joltToThree(transform.GetRotation().GetQuaternion()));
    }
}
// create a wheel from input settinsg
export function createWheelSettings(baseSettings: any, corner?: any, type = 'wv') {
    let wheel: any;
    switch (type) {
        case 'tv':
            break;
        default:
            wheel = new Raw.module.WheelSettingsWV();
            break;
    }
    // we need the width from setitings
    const halfVehicleWidth = baseSettings.vehicleWidth / 2;
    //strip out optional settings
    const { fl, fr, bl, br, ...defaultWheelSettings } = baseSettings.wheels;
    const isFront = corner === 'fl' || corner === 'fr';
    const isLeft = corner === 'fl' || corner === 'bl';
    // remerge based on corner
    const wheelSettings = {
        ...defaultWheelSettings,
        ...baseSettings.wheels[corner]
    };
    // set the position based on corner
    wheel.mPosition = new Raw.module.Vec3(
        isLeft ? halfVehicleWidth : -halfVehicleWidth,
        -wheelSettings.wheelOffsetVertical,
        isFront ? wheelSettings.wheelOffsetHorizontal : -wheelSettings.wheelOffsetHorizontal
    );
    // loop over the settings and set them on the wheel with the jolt prop name
    // some settings don't exist. hopefully jolt ignores them
    Object.keys(wheelSettings).forEach((key) => {
        //@ts-ignore
        wheel[joltPropName(key)] = wheelSettings[key];
    });
    return wheel;
}

//creates basic crashtest style wheel texture
function getWheelMaterial() {
    // Create material for wheel
    const texLoader = new THREE.TextureLoader();
    const texture = texLoader.load(
        'data:image/gif;base64,R0lGODdhAgACAIABAAAAAP///ywAAAAAAgACAAACA0QCBQA7'
    );
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.offset.set(0, 0);
    texture.repeat.set(1, 1);
    texture.magFilter = THREE.NearestFilter;
    const wheelMaterial = new THREE.MeshPhongMaterial({ color: 0x666666 });
    wheelMaterial.map = texture;
    return wheelMaterial;
}
