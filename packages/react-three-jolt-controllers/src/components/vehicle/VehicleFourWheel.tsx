import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useConst, useJolt, vec3 } from '@react-three/jolt';
import { VehicleSystem, VehicleFourWheelManager } from '../../systems/vehicles/';
import { useThree } from '@react-three/fiber';
import { useCommand } from '@react-three/jolt-addons';
type VehicleFourWheelProps = {
    children?: React.ReactNode;
    position?: THREE.Vector3 | number[];
    type?: string;
    name?: string;
};

//TODO make this a general vehicle component
export function VehicleFourWheel(props: VehicleFourWheelProps) {
    const { position = [0, 0, 0], type } = props;
    let { name } = props;
    // set the name if not passed
    if (!name) {
        switch (type) {
            case 'twoWheel':
                name = 'bike';
                break;
            default:
                name = 'car';
        }
    }
    const { physicsSystem } = useJolt();
    const { scene, camera, controls } = useThree();
    const vehicleSystem = useConst(() => new VehicleSystem(physicsSystem));
    const oldPosition = useConst(new THREE.Vector3());
    // TODO make this a const
    //TODO make this a general vehicle component
    const vehicle = useRef<VehicleFourWheelManager | null>(null);
    useEffect(() => {
        let newVehicle;
        switch (type) {
            case 'twoWheel':
                newVehicle = vehicleSystem.addVehicle(name, {
                    type: 'twoWheel'
                });
                break;
            default:
                newVehicle = vehicleSystem.addVehicle(name);
        }

        vehicle.current = newVehicle;
        scene.add(newVehicle.threeObject);
        // move the camera on update
        camera.position.set(-4, 4, 0);
        camera.lookAt(newVehicle.position);
        //controls?.target = newVehicle.position;
    }, [vehicleSystem]);

    useEffect(() => {
        if (!controls) return;
        vehicle.current!.onPreStep((_vehicleConstraint: any) => {
            const bodyPosition = vehicle.current?.position.clone();
            // console.log('controls', controls);
            //@ts-ignore
            controls.target = bodyPosition;
            camera.position.add(bodyPosition!.clone().sub(oldPosition));
            oldPosition.copy(bodyPosition!);
        });
    }, [controls]);

    //* Props triggering the class ========================
    // trigger position change
    useEffect(() => {
        if (!vehicle.current) return;
        //@ts-ignore
        vehicle.current.setPosition(vec3.three(position));
    }, [position]);

    // move things
    useCommand(
        'move',
        (info) => {
            if (!vehicle.current) return;
            //@ts-ignore
            const direction = new THREE.Vector3(info.value.x, info.value.y, 0);
            vehicle.current!.move(direction);
        },
        (_info) => {
            vehicle.current!.move(new THREE.Vector3(0, 0, 0));
        },
        { asVector: true, inverted: { y: true } }
    );

    return <group>{props.children}</group>;
}
