/* We do this as a class so it's not bound to a react component
so much and can be reused for things like NPC's */

import * as THREE from 'three';
import { MathUtils } from 'three';
import Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { Layer } from '../constants'
import { PhysicsSystem } from './physics-system';
import { _matrix4, _position, _quaternion, _rotation, _scale, _vector3 } from '../tmp';
import { quat, vec3 } from '../utils';
import { generateBodySettings } from './body-system';

export class characterControllerSystem {
    joltInterface: Jolt.JoltInterface;
    physicsSystem;
    bodySystem;

    private actionListeners = [];

    // configurable options

    characterHeightStanding = 2;
    characterRadiusStanding = 1;
    characterHeightCrouching = 1;
    characterRadiusCrouching = 0.8;

    // Character movement properties
    controlMovementDuringJump = true; ///< If false the character cannot change movement direction in mid air
    characterSpeed = 6;
    characterSpeedCrouched = 3.0;
    characterSpeedTired = 2.0;
    jumpSpeed = 15.0;

    enableCharacterInertia = true;

    upRotationX = 0;
    upRotationZ = 0;
    maxSlopeAngle = MathUtils.degToRad(45.0);
    maxStrength = 100.0;
    characterPadding = 0.02;
    penetrationRecoverySpeed = 1.0;
    predictiveContactDistance = 0.1;
    enableWalkStairs = true;
    enableStickToFloor = true;
    // if the body turns on move input
    rotateOnMove = true;
    direction = new THREE.Vector3(0, 0, 0);
    velocity = new THREE.Vector3(0, 0, 0);

    public threeObject: any;

    // **Primary Holder Object ***
    character: any;
    //rig anchor
    anchor: any;
    anchorID: any;
    // State properties ------------------------------
    isCrouched = false;
    allowSliding = false;
    allowSprinting = false;
    jumpLimit = 2;
    jumpDegradeFactor = 0.5;
    // to be removed --------------------------------
    geometry = new THREE.BoxGeometry(1, 1, 1);
    material = new THREE.MeshPhongMaterial({ color: 0xffff00 });
    threeCharacter = new THREE.Mesh(this.geometry, this.material);
    //-------------------------------------------

    private updateSettings = new Raw.module.ExtendedUpdateSettings();

    private objectVsBroadPhaseLayerFilter;
    private objectLayerPairFilter;
    private movingBPFilter;
    private movingLayerFilter;
    private bodyFilter = new Raw.module.BodyFilter();
    private shapeFilter = new Raw.module.ShapeFilter();

    // private properties
    //active speed allows variable running speeds
    private activeSpeed = 6;
    // shapes of the character
    private standingShape: any;
    private crouchingShape: any;

    private characterContactListener: any;
    // Rotation properties
    currentRotation = new THREE.Quaternion();
    targetRotation = new THREE.Quaternion();
    maxRotationSpeed = 0.1; //radians per frame
    currentRotationSlerp = 0;
    isRotating = false;

    // movement vectors
    private movementInput = new THREE.Vector3();
    private desiredVelocity = new THREE.Vector3();
    //private jumpBlocked = false;
    private jumpCounter = 0;
    private isJumping = false;

    // testing props
    oldPosition = new THREE.Vector3();

    constructor(physicsSystem: PhysicsSystem) {
        this.physicsSystem = physicsSystem;
        this.joltInterface = physicsSystem.joltInterface;
        this.bodySystem = physicsSystem.bodySystem;
        this.objectVsBroadPhaseLayerFilter = this.joltInterface.GetObjectVsBroadPhaseLayerFilter();
        this.objectLayerPairFilter = this.joltInterface.GetObjectLayerPairFilter();
        this.movingBPFilter = new Raw.module.DefaultBroadPhaseLayerFilter(
            this.objectVsBroadPhaseLayerFilter,
            Layer.MOVING
        );
        this.movingLayerFilter = new Raw.module.DefaultObjectLayerFilter(
            this.objectLayerPairFilter,
            Layer.MOVING
        );

        //this.initCharacterContactListener();
        // Set a default shape size (know it will be overwritten by the user
        this.setCapsule(1, 2);
        this.initCharacter();
        this.physicsSystem.addPreStepListener((deltaTime: number) =>
            this.prePhysicsUpdate(deltaTime)
        );
    }
    //* Contact Listeners =================================

    initCharacterContactListener() {
        this.characterContactListener = new Raw.module.CharacterContactListenerJS();
        this.characterContactListener.OnAdjustBodyVelocity = (
            _character: Jolt.CharacterVirtual,
            body2: Jolt.Body,
            linearVelocity: Jolt.Vec3,
            _angularVelocity: Jolt.Vec3
        ) => {
            //@ts-ignore wrapPointer TS error
            body2 = Raw.module.wrapPointer(body2, Raw.module.Body);
            //@ts-ignore
            linearVelocity = Raw.module.wrapPointer(linearVelocity, Raw.module.Vec3);
            // this is where the movement from conveyor belts and other things can be added
        };
        this.characterContactListener.OnContactValidate = (
            character: Jolt.CharacterVirtual,
            bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID
        ) => {
            //@ts-ignore wrapPointer TS error
            bodyID2 = Raw.module.wrapPointer(bodyID2, Raw.module.Body);
            //@ts-ignore wrapPointer TS error
            character = Raw.module.wrapPointer(character, Raw.module.Body);
            // this seems to be a space to trigger sensors
            return true;
        };
        this.characterContactListener.OnContactAdded = (
            _character: Jolt.CharacterVirtual,
            _bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID,
            _contactPosition: Jolt.Vec3,
            _contactNormal: Jolt.Vec3,
            _settings: any
        ) => {
            // not using this at the moment
        };
        this.characterContactListener.OnContactSolve = (
            character: any,
            _bodyID2: Jolt.BodyID,
            _subShapeID2: Jolt.SubShapeID,
            _contactPosition: Jolt.Vec3,
            contactNormal: Jolt.Vec3,
            contactVelocity: Jolt.Vec3,
            _contactMaterial: Jolt.PhysicsMaterial,
            _characterVelocity: Jolt.Vec3,
            newCharacterVelocity: Jolt.Vec3
        ) => {
            character = Raw.module.wrapPointer(character, Raw.module.Body);
            //@ts-ignore wrapPointer TS error
            contactVelocity = Raw.module.wrapPointer(contactVelocity, Raw.module.Vec3);
            //@ts-ignore
            newCharacterVelocity = Raw.module.wrapPointer(newCharacterVelocity, Raw.module.Vec3);
            //@ts-ignore
            contactNormal = Raw.module.wrapPointer(contactNormal, Raw.module.Vec3);

            if (
                !this.allowSliding &&
                contactVelocity.IsNearZero() &&
                !this.character.IsSlopeTooSteep(contactNormal)
            ) {
                // Dont allow the character to slide
                newCharacterVelocity.SetX(0);
                newCharacterVelocity.SetY(0);
                newCharacterVelocity.SetZ(0);
            }
        };
    }
    // create the core character
    initCharacter() {
        const settings = new Raw.module.CharacterVirtualSettings();
        settings.mMass = 1000;
        settings.mMaxSlopeAngle = this.maxSlopeAngle;
        settings.mMaxStrength = this.maxStrength;
        settings.mShape = this.standingShape;
        settings.mBackFaceMode = Raw.module.EBackFaceMode_CollideWithBackFaces;
        settings.mCharacterPadding = this.characterPadding;
        settings.mPenetrationRecoverySpeed = this.penetrationRecoverySpeed;
        settings.mPredictiveContactDistance = this.predictiveContactDistance;
        settings.mSupportingVolume = new Raw.module.Plane(
            Raw.module.Vec3.prototype.sAxisY(),
            -this.characterRadiusStanding
        );
        this.character = new Raw.module.CharacterVirtual(
            settings,
            Raw.module.RVec3.prototype.sZero(),
            Raw.module.Quat.prototype.sIdentity(),
            this.physicsSystem.physicsSystem
        );
        this.character.SetListener(this.characterContactListener);

        //this.threeCharacter.geometry = this.threeStandingGeometry;
        this.threeCharacter.userData.body = this.character;
        // see if the issue is a shape issue
        this.character.SetShape(
            this.standingShape,
            1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
            this.movingBPFilter,
            this.movingLayerFilter,
            this.bodyFilter,
            this.shapeFilter,
            this.joltInterface.GetTempAllocator()
        );
        // create the rig anchor
        this.createAnchor();
        // TODO: Destroy all the jolt stuff now its created
    }
    // create the anchor object for rigs
    private createAnchor() {
        console.log('creating anchor');
        const shapeSettings = new Raw.module.SphereShapeSettings(0.5);
        const bodySettings = generateBodySettings(shapeSettings, {
            bodyType: 'rig'
        });
        const anchor = this.physicsSystem.bodyInterface.CreateBody(bodySettings);
        this.anchorID = anchor.GetID();
        // we have to generate a correct bodyState
        const anchorHandle = this.physicsSystem.bodySystem.addExistingBody(
            new THREE.Object3D(),
            anchor
        );
        this.anchor = this.physicsSystem.bodySystem.getBody(anchorHandle);

        // cleanup
        Raw.module.destroy(shapeSettings);
        Raw.module.destroy(bodySettings);
    }
    // set the capsule shape for the character
    setCapsule(radius: number, height: number) {
        this.characterHeightStanding = height;
        this.characterRadiusStanding = radius;
        this.characterHeightCrouching = height * 0.5;
        this.characterRadiusCrouching = radius * 0.5;
        const positionStanding = new Raw.module.Vec3(
            0,
            0.5 * this.characterHeightStanding + this.characterRadiusStanding,
            0
        );
        const positionCrouching = new Raw.module.Vec3(
            0,
            0.5 * this.characterHeightCrouching + this.characterRadiusCrouching,
            0
        );
        const rotation = Raw.module.Quat.prototype.sIdentity();
        // TODO: prettier butchers this
        this.standingShape = new Raw.module.RotatedTranslatedShapeSettings(
            positionStanding,
            rotation,
            new Raw.module.CapsuleShapeSettings(
                0.5 * this.characterHeightStanding,
                this.characterRadiusStanding
            )
        )
            .Create()
            .Get();
        this.crouchingShape = new Raw.module.RotatedTranslatedShapeSettings(
            positionCrouching,
            rotation,
            new Raw.module.CapsuleShapeSettings(
                0.5 * this.characterHeightCrouching,
                this.characterRadiusCrouching
            )
        )
            .Create()
            .Get();
        // TODO: Destroy all the jolt stuff now its created
    }

    prePhysicsUpdate(deltaTime: number) {
        // locks the character in a up position
        const characterUp = vec3.joltToThree(this.character.GetUp());
        // TODO: consider angular velocity to slightly rotate (wolfram GDC2014)
        this.applyRotation();
        this.applyMovement(deltaTime);
        // Most of the next few actions are applying gravity/force to the character
        // prevents odd hovering
        if (!this.enableStickToFloor) {
            this.updateSettings.mStickToFloorStepDown = Raw.module.Vec3.prototype.sZero();
        } else {
            const vec = characterUp
                .clone()
                .multiplyScalar(-this.updateSettings.mStickToFloorStepDown.Length());
            this.updateSettings.mStickToFloorStepDown.Set(vec.x, vec.y, vec.z);
        }

        if (!this.enableWalkStairs) {
            this.updateSettings.mWalkStairsStepUp = Raw.module.Vec3.prototype.sZero();
        } else {
            const vec = characterUp
                .clone()
                .multiplyScalar(this.updateSettings.mWalkStairsStepUp.Length());
            this.updateSettings.mWalkStairsStepUp.Set(vec.x, vec.y, vec.z);
        }
        characterUp.multiplyScalar(-this.physicsSystem.physicsSystem.GetGravity().Length());

        this.character.ExtendedUpdate(
            deltaTime,
            this.character.GetUp(),
            this.updateSettings,
            this.movingBPFilter,
            this.movingLayerFilter,
            this.bodyFilter,
            this.shapeFilter,
            this.joltInterface.GetTempAllocator()
        );

        // move the three object
        this.threeCharacter.position.copy(vec3.joltToThree(this.character.GetPosition()));
        this.threeCharacter.quaternion.copy(quat.joltToThree(this.character.GetRotation()));
        // update the anchor
        this.physicsSystem.bodyInterface.SetPositionAndRotation(
            this.anchorID,
            this.character.GetPosition(),
            this.character.GetRotation(),
            Raw.module.EActivation_Activate
        );
    }
    // Movement Functions ------------------------------
    setRotation(rotation: THREE.Quaternion) {
        this.targetRotation = rotation;
        this.currentRotationSlerp = 0;
        this.isRotating = true;
    }
    private applyRotation() {
        if (this.isRotating) {
            this.currentRotationSlerp += this.maxRotationSpeed;
            if (this.currentRotationSlerp >= 1) {
                this.currentRotationSlerp = 1;
                this.isRotating = false;
            }
            this.currentRotation.slerp(this.targetRotation, this.currentRotationSlerp);

            this.character.SetRotation(quat.threeToJolt(this.currentRotation));
        }
    }
    // set the movement input
    move(direction: THREE.Vector3) {
        this.movementInput = direction;
        // rotate based on the direction
        if (this.rotateOnMove && direction.length() > 0)
            this.setRotation(
                new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction)
            );
    }

    // move the character in space
    private applyMovement(deltaTime = 1) {
        //TODO: resolve a way to remove this clone
        const movementDirection = this.movementInput.clone();
        //const jump = this.isJumping;
        const _tmpVec3 = new Raw.module.Vec3();
        // can the user defy physics and move while airborne
        // also if the user passes a direction (allows jump without direction input)
        const playerControlsHorizontalVelocity =
            this.controlMovementDuringJump || this.character.IsSupported();
        if (playerControlsHorizontalVelocity) {
            // True if the player intended to move
            this.allowSliding = !(movementDirection.length() < 1.0e-12);
            // Smooth the player input
            if (this.enableCharacterInertia) {
                this.desiredVelocity.multiplyScalar(0.75);
                //TODO this add is why we need the clone
                this.desiredVelocity.add(movementDirection.multiplyScalar(0.25 * this.activeSpeed));
            } else {
                this.desiredVelocity.copy(movementDirection).multiplyScalar(this.activeSpeed);
            }
        } else {
            // While in air we allow sliding
            this.allowSliding = true;
        }
        // Maintain the up orientation
        _tmpVec3.Set(this.upRotationX, 0, this.upRotationZ);
        const characterUpRotation = Raw.module.Quat.prototype.sEulerAngles(_tmpVec3);
        this.character.SetUp(characterUpRotation.RotateAxisY());
        // this is overriding our existing rotation
        //this.character.SetRotation(characterUpRotation);
        const upRotation = quat.joltToThree(characterUpRotation);

        this.character.UpdateGroundVelocity();
        const characterUp = vec3.joltToThree(this.character.GetUp());
        const linearVelocity = vec3.joltToThree(this.character.GetLinearVelocity());
        const currentVerticalVelocity = characterUp
            .clone()
            .multiplyScalar(linearVelocity.dot(characterUp));
        const groundVelocity = vec3.joltToThree(this.character.GetGroundVelocity());
        const gravity = vec3.joltToThree(this.physicsSystem.physicsSystem.GetGravity());

        let newVelocity;
        const movingTowardsGround = currentVerticalVelocity.y - groundVelocity.y < 0.1;

        // If on ground and not moving away from ground
        if (
            this.character.GetGroundState() == Raw.module.EGroundState_OnGround && // If on ground
            (this.enableCharacterInertia
                ? movingTowardsGround // Inertia enabled: And not moving away from ground
                : !this.character.IsSlopeTooSteep(this.character.GetGroundNormal()))
        ) {
            // reset the jump counter
            this.jumpCounter = 0;
            // Inertia disabled: And not on a slope that is too steep
            // Assume velocity of ground when on ground
            newVelocity = groundVelocity;
        } else newVelocity = currentVerticalVelocity.clone();

        //
        // JUMP. Double jump or on the ground
        //
        if (this.isJumping) {
            if (this.jumpCounter < this.jumpLimit) {
                this.jumpCounter++;
                console.log('jumping, jump count:', this.jumpCounter);
                this.triggerActionListeners('jump', this.jumpCounter);

                newVelocity.add(characterUp.multiplyScalar(this.jumpSpeed));
                this.isJumping = false;
            }
        }

        // Gravity
        newVelocity.add(gravity.multiplyScalar(deltaTime | 1).applyQuaternion(upRotation));

        if (playerControlsHorizontalVelocity) {
            // Player input
            // console.log('player velocity', this.desiredVelocity);
            newVelocity.add(this.desiredVelocity.clone().applyQuaternion(upRotation));
        } else {
            // Preserve horizontal velocity
            const currentHorizontalVelocity = linearVelocity.sub(currentVerticalVelocity);
            newVelocity.add(currentHorizontalVelocity);
        }

        _tmpVec3.Set(newVelocity.x, newVelocity.y, newVelocity.z);
        //const difference = newVelocity.clone().sub(this.oldPosition);
        //console.log('difference', difference);
        // console.log('new velocity', newVelocity);
        this.character.SetLinearVelocity(_tmpVec3);
        //this.oldPosition = newVelocity.clone();
    }
    // TODO Fix this
    setCrouched = (crouched: boolean, forceUpdate: boolean) => {
        if (crouched != this.isCrouched || forceUpdate) {
            let newShape;
            //let newGeometry;
            if (crouched) {
                newShape = this.crouchingShape;
                //newGeometry = this.threeCrouchingGeometry;
            } else {
                newShape = this.standingShape;
                //newGeometry = this.threeStandingGeometry;
            }
            if (
                this.character.SetShape(
                    newShape,
                    1.5 * this.physicsSystem.physicsSystem.GetPhysicsSettings().mPenetrationSlop,
                    this.movingBPFilter,
                    this.movingLayerFilter,
                    this.bodyFilter,
                    this.shapeFilter,
                    this.joltInterface.GetTempAllocator()
                )
            ) {
                // Accept the new shape only when the SetShape call was successful
                this.isCrouched = crouched;
                //threeCharacter.geometry = newGeometry;
            }
        }
    };

    // Primary Movement functions =============================
    jump() {
        this.isJumping = true;
        // TODO, is this still needed?
        setTimeout(() => {
            this.isJumping = false;
        }, 100);
    }
    startRunning(speed?: any) {
        const newSpeed = speed || this.characterSpeed * 2;
        this.activeSpeed = newSpeed;
        //notify
        this.triggerActionListeners('startRunning', newSpeed);
    }
    stopRunning() {
        this.activeSpeed = this.characterSpeed;
        this.triggerActionListeners('stopRunning');
    }
    // Action Listener Functions ----------------------------
    addActionListener = (listener: any) => {
        //@ts-ignore
        this.actionListeners.push(listener);
    };
    removeActionListener = (listener: any) => {
        this.actionListeners = this.actionListeners.filter((l) => l !== listener);
    };
    triggerActionListeners = (action: any, payload?: any) => {
        //@ts-ignore
        this.actionListeners.forEach((listener) => listener(action, payload));
    };
    // watch function takes an action and a callback and adds the correct listener
    watch = (action: any, callback: any) => {
        const listener = (a: any) => {
            if (a === action) callback();
        };
        this.addActionListener(listener);
        return () => this.removeActionListener(listener);
    };

    // Util functions ----------------------------------

    teleport(position: THREE.Vector3) {
        const _tmpRVec3 = new Raw.module.RVec3();
        _tmpRVec3.Set(position.x, position.y, position.z);
        this.character.SetPosition(_tmpRVec3);
    }
}
