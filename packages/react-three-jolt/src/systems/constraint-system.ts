// class to control and manage constraints
// designed to be used from the body system although it can be accessed directly

import Jolt from 'jolt-physics';
import { Raw } from '../raw';
import { vec3, quat } from '../utils';

type ConstraintSettings =
    | Jolt.ConstraintSettings
    | Jolt.FixedConstraintSettings
    | Jolt.DistanceConstraintSettings
    | Jolt.PointConstraintSettings
    | Jolt.HingeConstraintSettings
    | Jolt.SliderConstraintSettings
    | Jolt.SixDOFConstraintSettings
    | Jolt.ConeConstraintSettings
    | Jolt.SwingTwistConstraintSettings;

export class ConstraintSystem {
    physicsSystem;
    joltPhysicsSystem: Jolt.PhysicsSystem;

    constructor(physicSystem) {
        this.physicsSystem = physicSystem;
        this.joltPhysicsSystem = physicSystem.physicsSystem;
    }

    addConstraint(type, body1, body2, options?) {
        // TODO: Get the type working here
        let constraintSettings;
        let skipPointSetting = false;
        let hasSpring = false;

        // for sixDOF constraints
        const freeTranslationAxis = ['x', 'y', 'z'];
        const freeRotationAxis = ['x', 'y', 'z'];
        let fixedTranslationAxis: string[] = [];
        let fixedRotationAxis: string[] = [];
        let limitedTranslationAxis: string[] = [];
        let limitedRotationAxis: string[] = [];
        //console.log('Creating constraint:', type, body1, body2, options);
        switch (type) {
            //* Fixed -------------------------------------
            case 'fixed':
                constraintSettings = new Raw.module.FixedConstraintSettings();
                if (!options?.point1 && !options?.point2) {
                    skipPointSetting = true;
                    constraintSettings.mAutoDetectPoint = true;
                }
                break;

            //* Point -------------------------------------
            // point constraints fix movement but NOT rotation
            case 'point':
                constraintSettings = new Raw.module.PointConstraintSettings();
                // we are going to help with setting a point2 if there isnt one
                if (options?.point1 && !options?.point2)
                    options.point2 = options.point1;
                break;

            //* Distance ----------------------------------
            case 'distance':
                constraintSettings =
                    new Raw.module.DistanceConstraintSettings();
                // this constraint does not do autoPoints
                // if there is no min set, use the distance between the two points
                constraintSettings.mMinDistance = options?.min || -1;
                // max is totally optional
                if (options?.max) constraintSettings.mMaxDistance = options.max;
                hasSpring = true;
                break;

            //* Revolute/Hinge -----------------------------
            case 'revolute':
            case 'hinge':
                constraintSettings = new Raw.module.HingeConstraintSettings();
                // we are going to help with setting a point2 if there isnt one
                if (options?.point1 && !options?.point2)
                    options.point2 = options.point1;
                // the axis is from the point. so which item its rotating on
                constraintSettings.mHingeAxis1 =
                    constraintSettings.mHingeAxis2 = options?.axis
                        ? vec3.jolt(options?.axis)
                        : new Raw.module.Vec3(1, 0, 0);
                // I dont know why we set the normal axis
                constraintSettings.mNormalAxis1 =
                    constraintSettings.mNormalAxis2 = options?.normal
                        ? vec3.jolt(options.normal)
                        : new Raw.module.Vec3(0, 1, 0);
                // the rest of these are optional
                // In Radians
                if (options?.min) constraintSettings.mLimitsMin = options.min;
                if (options?.max) constraintSettings.mLimitsMax = options.max;
                if (options?.maxFrictionTorque)
                    constraintSettings.mMaxFrictionTorque =
                        options.maxFrictionTorque;

                //TODO add motor settings
                hasSpring = true;
                break;

            //* Slider/Prismatic ---------------------------
            case 'prismatic':
            case 'slider':
                constraintSettings = new Raw.module.SliderConstraintSettings();
                // we are going to help with setting a point2 if there isnt one
                if (options?.point1 && !options?.point2)
                    options.point2 = options.point1;
                // the axis to slide along. This really is required but we'll add a fallback
                constraintSettings.mSliderAxis1 =
                    constraintSettings.mSliderAxis2 = options?.axis
                        ? vec3.threeToJolt(options.axis).Normalized()
                        : new Raw.module.Vec3(0, -1, 1).Normalized();
                // the normal axis is perpendecular to the slider axis
                constraintSettings.mNormalAxis1 =
                    constraintSettings.mNormalAxis2 =
                        constraintSettings.mSliderAxis1.GetNormalizedPerpendicular();
                // the rest of these are optional
                // In Radians
                if (options.min) constraintSettings.mLimitsMin = options.min;
                if (options.max) constraintSettings.mLimitsMax = options.max;
                if (options.maxFrictionForce)
                    constraintSettings.mMaxFrictionForce =
                        options.maxFrictionForce;
                //TODO add motor settings
                hasSpring = true;
                break;

            //* Cone -------------------------------------
            case 'cone':
                constraintSettings = new Raw.module.ConeConstraintSettings();
                // we are going to help with setting a point2 if there isnt one
                if (options?.point1 && !options?.point2)
                    options.point2 = options.point1;
                constraintSettings.mTwistAxis1 =
                    constraintSettings.mTwistAxis2 = options?.twistAxis
                        ? vec3.threeToJolt(options.twistAxis)
                        : new Raw.module.Vec3(0, 1, 0);
                if (options.angle)
                    constraintSettings.mHalfConeAngle = options.angle / 2;
                break;

            //* SwingTwist --------------------------------
            //This one is pretty complex
            case 'swingTwist':
                constraintSettings =
                    new Raw.module.SwingTwistConstraintSettings();
                constraintSettings.mPosition1 = constraintSettings.mPosition2 =
                    options?.position
                        ? vec3.threeToJolt(options.position)
                        : new body1.body.GetPosition();
                constraintSettings.mTwistAxis1 =
                    constraintSettings.mTwistAxis2 = options?.twistAxis
                        ? vec3.threeToJolt(options.twistAxis)
                        : new Raw.module.Vec3(0, 1, 0);
                constraintSettings.mPlaneAxis1 =
                    constraintSettings.mPlaneAxis2 = options?.planeAxis
                        ? vec3.threeToJolt(options.planeAxis)
                        : new Raw.module.Vec3(1, 0, 0);
                // all angles are in radians
                if (options.normalConeAngle)
                    constraintSettings.mNormalHalfConeAngle =
                        options.normalConeAngle / 2;
                if (options.planeConesAngle)
                    constraintSettings.mPlaneHalfConeAngle =
                        options.planeConesAngle / 2;
                if (options.twistMin)
                    constraintSettings.mTwistMinAngle = options.twistMin;
                if (options.twistMax)
                    constraintSettings.mTwistMaxAngle = options.twistMax;

                if (options.maxFrictionTorque)
                    constraintSettings.mMaxFrictionTorque =
                        options.maxFrictionTorque;
                // TODO: motor settings
                break;

            //*** */ This is the most complex standard constraint
            case 'sixDOF':
                constraintSettings = new Raw.module.SixDOFConstraintSettings();
                constraintSettings.mPosition1 = constraintSettings.mPosition2 =
                    options?.position
                        ? vec3.threeToJolt(options.position)
                        : body1.body.GetPosition();
                //not sure these need to be changable so we will fix them
                constraintSettings.mAxisX1 = constraintSettings.mAxisX2 =
                    new Raw.module.Vec3(0, 0, 1);
                constraintSettings.mAxisY1 = constraintSettings.mAxisY2 =
                    new Raw.module.Vec3(1, 0, 0);

                // go over the options for fixed and limited constraints, remove from free
                if (options.fixedTranslationAxis) {
                    options.fixedTranslationAxis.forEach((axis) => {
                        freeTranslationAxis.splice(
                            freeTranslationAxis.indexOf(axis),
                            1
                        );
                    });
                    fixedTranslationAxis = options.fixedTranslationAxis;
                }
                if (options.fixedRotationAxis) {
                    options.fixedRotationAxis.forEach((axis) => {
                        freeRotationAxis.splice(
                            freeRotationAxis.indexOf(axis),
                            1
                        );
                    });
                    fixedRotationAxis = options.fixedRotationAxis;
                }
                // Now we loop over the lists and set them by type
                freeTranslationAxis.forEach((axis) => {
                    constraintSettings.MakeFreeAxis(this.getEaxis(axis));
                });
                freeRotationAxis.forEach((axis) => {
                    constraintSettings.MakeFreeAxis(
                        this.getEaxis(axis, 'rotation')
                    );
                });
                fixedTranslationAxis.forEach((axis) => {
                    constraintSettings.MakeFixedAxis(this.getEaxis(axis));
                });
                fixedRotationAxis.forEach((axis) => {
                    constraintSettings.MakeFixedAxis(
                        this.getEaxis(axis, 'rotation')
                    );
                });
                // limited axis are a bit different
                limitedTranslationAxis.forEach((axis) => {
                    const min = options.limits[`min${axis.toUpperCase()}`] || 0;
                    const max = options.limits[`max${axis.toUpperCase()}`] || 0;
                    constraintSettings.SetLimitedAxis(
                        this.getEaxis(axis),
                        min,
                        max
                    );
                });
                limitedRotationAxis.forEach((axis) => {
                    const min =
                        options.limits[`minAngle${axis.toUpperCase()}`] || 0;
                    const max =
                        options.limits[`maxAngle${axis.toUpperCase()}`] || 0;
                    constraintSettings.SetLimitedAxis(
                        this.getEaxis(axis, 'rotation'),
                        min,
                        max
                    );
                });
                // sixDOF has friction but it's weird.
                if (options?.friction)
                    // because I'm lazy, im making the user do a full array
                    options.friction.forEach((value, index) =>
                        constraintSettings.set_mMaxFriction(index, value)
                    );

                // if the limiter is a pyramid
                if (options?.limitShape === 'pyramid')
                    constraintSettings.mSwingType =
                        Raw.module.ESwingType_Pyramid;
                hasSpring = true;
                break;
        }
        //* Default Options -----------------------------
        // Add spring limits
        if (hasSpring && options?.spring) {
            constraintSettings.mLimitsSpringSettings =
                this.createSpringSettings(
                    options.spring.strength,
                    options.spring.damping,
                    options.spring.mode
                );
        }
        // set the points, replicates autoPoints with body position
        if (!skipPointSetting) {
            //  console.log('setting points', body1, body2, type, options);
            constraintSettings.mPoint1 = options?.point1
                ? vec3.threeToJolt(options.point1)
                : body1.body.GetPosition();
            constraintSettings.mPoint2 = options?.point2
                ? vec3.threeToJolt(options.point2)
                : body2.body.GetPosition();
        }

        // WARNING: Messing with space is dangerous and requires understanding
        // It WILL break stuff switching to local space
        if (options?.space === 'local')
            constraintSettings.mSpace =
                Raw.module.EConstraintSpace_LocalToBodyCOM;
        const constraint = constraintSettings.Create(body1.body, body2.body);
        this.joltPhysicsSystem.AddConstraint(constraint);
        // TODO should we destroy the settings now?
        Raw.module.destroy(constraintSettings);
        return constraint;
    }
    // apply spring settings to a constraint
    createSpringSettings(strength = 1, damping = 0.5, mode = 'frequency') {
        const springSettings = new Raw.module.SpringSettings();

        springSettings.mDamping = damping;
        // the default mode is frequency, only change if we want stiffness
        //NOTE: According to jolt docs, stiffness needs to be ALOT
        if (mode === 'stiffness') {
            springSettings.mMode = Raw.module.ESpringMode_StiffnessAndDamping;
            springSettings.mStiffness = strength;
        } else springSettings.mFrequency = strength;
        return springSettings;
    }
    // helper to get sixDof EAxis
    getEaxis(axis, type = 'translation') {
        switch (axis) {
            case 'x':
                return type === 'translation'
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationX
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationX;
                break;
            case 'y':
                return type === 'translation'
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationY
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationY;
                break;
            case 'z':
                return type === 'translation'
                    ? Raw.module.SixDOFConstraintSettings_EAxis_TranslationZ
                    : Raw.module.SixDOFConstraintSettings_EAxis_RotationZ;
                break;
        }
    }
    // create a motor for a constraint
    // TODO: DO this. it's going to take time
    //https://jrouwe.github.io/JoltPhysics/index.html#constraint-motors
    createMotorSettings(settings) {
        const motorSettings = new Raw.module.MotorSettings();
        motorSettings.mMaxForce = maxForce;
        motorSettings.mSpeed = speed;
        return motorSettings;
    }
}
