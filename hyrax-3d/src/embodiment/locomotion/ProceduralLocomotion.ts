import { Euler, MathUtils, Vector3, type Object3D } from "three";

import type { AvatarRig } from "../rig/AvatarRig";
import type { LocomotionState } from "../types";

type ProceduralLocomotionInput = {
  velocity: Vector3;
  speed: number;
  locomotionState: LocomotionState;
  preserveLowerBody?: boolean;
  preserveUpperBody?: boolean;
  crouchIntensity?: number;
  kickSide?: "left" | "right";
  balanceSide?: "left" | "right";
  jumpingJacks?: boolean;
  jumping?: boolean;
  bendIntensity?: number;
};

function readParam(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const val = new URLSearchParams(window.location.search).get(key);
  if (val === null) return fallback;
  const num = parseFloat(val);
  return Number.isFinite(num) ? num : fallback;
}

export type ProceduralTuning = {
  maxWalkSpeed: number;
  strideScale: number;
  armDrop: number;
  armSwing: number;
  legSwing: number;
  legDirection: 1 | -1;
  kneeBend: number;
  breathScale: number;
  torsoTwist: number;
  idleLife: number;
};

export const DEFAULT_PROCEDURAL_TUNING: ProceduralTuning = {
  maxWalkSpeed: readParam("procMaxWalkSpeed", 1.2),
  strideScale: readParam("procStrideScale", 0.72),
  armDrop: readParam("procArmDrop", 1.32),
  armSwing: readParam("procArmSwing", 0.18),
  legSwing: readParam("procLegSwing", 0.72),
  legDirection: readParam("procLegDirection", 1) >= 0 ? 1 : -1,
  kneeBend: readParam("procKneeBend", 0.56),
  breathScale: readParam("procBreathScale", 0.055),
  torsoTwist: readParam("procTorsoTwist", 0.08),
  idleLife: readParam("procIdleLife", 0.035),
};

export class ProceduralLocomotion {
  private phase = 0;
  private crouchTime = 0;
  private wasCrouching = false;
  private kickTime = 0;
  private wasKicking = false;
  private balanceTime = 0;
  private wasBalancing = false;
  private jumpingJackTime = 0;
  private wasJumpingJacks = false;
  private jumpTime = 0;
  private wasJumping = false;
  private bendTime = 0;
  private wasBending = false;
  private readonly bindPositions = new WeakMap<Object3D, Vector3>();
  private _disposed = false;

  private tuning: ProceduralTuning;

  constructor(private readonly rig: AvatarRig, tuning: Partial<ProceduralTuning> = {}) {
    this.tuning = { ...DEFAULT_PROCEDURAL_TUNING, ...tuning };
  }

  dispose(): void {
    this._disposed = true;
  }

  setTuning(tuning: Partial<ProceduralTuning>): void {
    this.tuning = { ...this.tuning, ...tuning };
  }

  getTuning(): ProceduralTuning {
    return { ...this.tuning };
  }

  update(dt: number, input: ProceduralLocomotionInput): void {
    if (this._disposed) return
    const walkWeight = MathUtils.clamp(input.speed / this.tuning.maxWalkSpeed, 0, 1);
    const walking =
      input.locomotionState === "walking" ||
      input.locomotionState === "startingMove" ||
      input.locomotionState === "stopping";

    const phaseRate = walking ? 3.8 + walkWeight * 3.4 : 1.25;
    this.phase += dt * phaseRate;
    const crouchIntensity = MathUtils.clamp(input.crouchIntensity ?? 0, 0, 1);
    this.crouchTime = crouchIntensity > 0 ? this.crouchTime + dt : 0;
    this.kickTime = input.kickSide ? this.kickTime + dt : 0;
    this.balanceTime = input.balanceSide ? this.balanceTime + dt : 0;
    this.jumpingJackTime = input.jumpingJacks ? this.jumpingJackTime + dt : 0;
    this.jumpTime = input.jumping ? this.jumpTime + dt : 0;
    const bendIntensity = MathUtils.clamp(input.bendIntensity ?? 0, 0, 1);
    this.bendTime = bendIntensity > 0 ? this.bendTime + dt : 0;

    if (crouchIntensity > 0) {
      this.applyCrouch(crouchIntensity);
    } else if (input.kickSide) {
      this.resetHipsPosition();
      this.applyKick(input.kickSide);
    } else if (input.balanceSide) {
      this.resetHipsPosition();
      this.applyBalance(input.balanceSide);
    } else if (input.jumpingJacks) {
      this.applyJumpingJacks();
    } else if (input.jumping) {
      this.applyJump();
    } else if (bendIntensity > 0) {
      this.resetHipsPosition();
      this.applyBend(bendIntensity);
    } else {
      if (
        this.wasCrouching ||
        this.wasKicking ||
        this.wasBalancing ||
        this.wasJumpingJacks ||
        this.wasJumping ||
        this.wasBending ||
        !input.preserveLowerBody
      ) {
        this.resetHipsPosition();
      }
      this.applyTorso(
        walkWeight,
        walking,
        input.preserveLowerBody,
        input.preserveUpperBody,
      );
    }
    if (input.jumpingJacks) {
      this.applyJumpingJackArms();
    } else if (input.jumping) {
      this.applyJumpArms();
    } else if (!input.preserveUpperBody) {
      this.applyArms(walkWeight, walking);
    }
    if (
      crouchIntensity <= 0 &&
      !input.kickSide &&
      !input.balanceSide &&
      !input.jumpingJacks &&
      !input.jumping &&
      bendIntensity <= 0 &&
      !input.preserveLowerBody
    ) {
      this.applyLegs(walkWeight, walking);
    }
    this.wasCrouching = crouchIntensity > 0;
    this.wasKicking = Boolean(input.kickSide);
    this.wasBalancing = Boolean(input.balanceSide);
    this.wasJumpingJacks = Boolean(input.jumpingJacks);
    this.wasJumping = Boolean(input.jumping);
    this.wasBending = bendIntensity > 0;
  }

  private applyCrouch(intensity: number): void {
    const transition = MathUtils.smoothstep(this.crouchTime, 0, 0.8);
    const weight = transition * intensity;
    const hips = this.rig.getPoseBone("hips");
    if (hips) {
      const bind = this.bindPosition(hips);
      hips.position.copy(bind);
      hips.position.y -= 0.23 * weight;
      this.rig.markPoseWrite();
    }

    // Keep the torso nearly straight while the hips and knees own the descent.
    this.rig.setBonePoseOffset("hips", new Euler(-0.08 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("spine", new Euler(-0.08 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("chest", new Euler(-0.04 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("leftUpperLeg", new Euler(0.72 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("rightUpperLeg", new Euler(0.72 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("leftLowerLeg", new Euler(-1.12 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerLeg", new Euler(-1.12 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("leftFoot", new Euler(0.4 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("rightFoot", new Euler(0.4 * weight, 0, 0), 1);
  }

  private resetHipsPosition(): void {
    const hips = this.rig.getPoseBone("hips");
    if (!hips) return;
    hips.position.copy(this.bindPosition(hips));
    this.rig.markPoseWrite();
  }

  private applyKick(side: "left" | "right"): void {
    const lift = MathUtils.smoothstep(this.kickTime, 0, 0.45);
    const extend = MathUtils.smoothstep(this.kickTime, 0.3, 0.8);
    const kickLeg = side === "left" ? "left" : "right";
    const supportLeg = side === "left" ? "right" : "left";
    this.rig.setBonePoseOffset("hips", new Euler(-0.08 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset(`${kickLeg}UpperLeg`, new Euler(0.92 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset(
      `${kickLeg}LowerLeg`,
      new Euler(-0.78 * lift * (1 - extend * 0.82), 0, 0),
      1,
    );
    this.rig.setBonePoseOffset(`${kickLeg}Foot`, new Euler(-0.18 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset(`${supportLeg}UpperLeg`, new Euler(-0.08 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset(`${supportLeg}LowerLeg`, new Euler(-0.12 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset(`${supportLeg}Foot`, new Euler(0.1 * lift, 0, 0), 1);
  }

  private applyBalance(supportSide: "left" | "right"): void {
    const weight = MathUtils.smoothstep(this.balanceTime, 0, 0.65);
    const liftedSide = supportSide === "left" ? "right" : "left";
    const supportSign = supportSide === "left" ? 1 : -1;

    this.rig.setBonePoseOffset("hips", new Euler(-0.04 * weight, 0, 0.1 * supportSign * weight), 1);
    this.rig.setBonePoseOffset("spine", new Euler(0, 0, -0.06 * supportSign * weight), 1);
    this.rig.setBonePoseOffset("chest", new Euler(0, 0, -0.04 * supportSign * weight), 1);
    this.rig.setBonePoseOffset(`${supportSide}UpperLeg`, new Euler(-0.05 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset(`${supportSide}LowerLeg`, new Euler(-0.12 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset(`${supportSide}Foot`, new Euler(0.1 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset(`${liftedSide}UpperLeg`, new Euler(0.62 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset(`${liftedSide}LowerLeg`, new Euler(-1.12 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset(`${liftedSide}Foot`, new Euler(0.38 * weight, 0, 0), 1);
  }

  private jumpingJackOpen(): number {
    const transition = MathUtils.smoothstep(this.jumpingJackTime, 0, 0.4);
    return transition * (0.5 - 0.5 * Math.cos(this.jumpingJackTime * Math.PI * 1.6));
  }

  private applyJumpingJacks(): void {
    const open = this.jumpingJackOpen();
    const hips = this.rig.getPoseBone("hips");
    if (hips) {
      hips.position.copy(this.bindPosition(hips));
      hips.position.y += 0.1 * open;
      this.rig.markPoseWrite();
    }
    this.rig.setBonePoseOffset("hips", new Euler(-0.04 * open, 0, 0), 1);
    this.rig.setBonePoseOffset("spine", new Euler(0.03 * open, 0, 0), 1);
    this.rig.setBonePoseOffset("chest", new Euler(0.04 * open, 0, 0), 1);
    this.rig.setBonePoseOffset("leftUpperLeg", new Euler(0, 0, 0.48 * open), 1);
    this.rig.setBonePoseOffset("rightUpperLeg", new Euler(0, 0, -0.48 * open), 1);
    this.rig.setBonePoseOffset("leftLowerLeg", new Euler(-0.1 * open, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerLeg", new Euler(-0.1 * open, 0, 0), 1);
    this.rig.setBonePoseOffset("leftFoot", new Euler(0.08 * open, 0, -0.2 * open), 1);
    this.rig.setBonePoseOffset("rightFoot", new Euler(0.08 * open, 0, 0.2 * open), 1);
  }

  private applyJumpingJackArms(): void {
    const open = this.jumpingJackOpen();
    this.rig.setBonePoseOffset("leftShoulder", new Euler(0, 0, -0.12 * open), 1);
    this.rig.setBonePoseOffset("rightShoulder", new Euler(0, 0, 0.12 * open), 1);
    this.rig.setBonePoseOffset(
      "leftUpperArm",
      new Euler(-0.08 * open, 0, MathUtils.lerp(this.tuning.armDrop, -1.42, open)),
      1,
    );
    this.rig.setBonePoseOffset(
      "rightUpperArm",
      new Euler(-0.08 * open, 0, MathUtils.lerp(-this.tuning.armDrop, 1.42, open)),
      1,
    );
    this.rig.setBonePoseOffset("leftLowerArm", new Euler(0.08, 0, 0.08 * open), 1);
    this.rig.setBonePoseOffset("rightLowerArm", new Euler(0.08, 0, -0.08 * open), 1);
    this.rig.setBonePoseOffset("leftHand", new Euler(0, 0, 0.05 * open), 1);
    this.rig.setBonePoseOffset("rightHand", new Euler(0, 0, -0.05 * open), 1);
  }

  private jumpPhase(): { lift: number; compression: number } {
    const progress = MathUtils.clamp(this.jumpTime / 1.35, 0, 1);
    const lift = Math.sin(progress * Math.PI);
    const takeoffCompression = Math.sin(Math.min(1, progress * 2.6) * Math.PI);
    const landingCompression =
      progress > 0.72
        ? Math.sin(MathUtils.clamp((progress - 0.72) / 0.28, 0, 1) * Math.PI)
        : 0;
    return {
      lift,
      compression: Math.max(takeoffCompression, landingCompression) * (1 - lift * 0.62),
    };
  }

  private applyJump(): void {
    const { lift, compression } = this.jumpPhase();
    const hips = this.rig.getPoseBone("hips");
    if (hips) {
      hips.position.copy(this.bindPosition(hips));
      hips.position.y += 0.18 * lift - 0.055 * compression;
      this.rig.markPoseWrite();
    }
    this.rig.setBonePoseOffset("hips", new Euler(-0.08 * compression, 0, 0), 1);
    this.rig.setBonePoseOffset("spine", new Euler(0.04 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset("chest", new Euler(0.06 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset("leftUpperLeg", new Euler(0.34 * compression, 0, 0), 1);
    this.rig.setBonePoseOffset("rightUpperLeg", new Euler(0.34 * compression, 0, 0), 1);
    this.rig.setBonePoseOffset("leftLowerLeg", new Euler(-0.58 * compression, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerLeg", new Euler(-0.58 * compression, 0, 0), 1);
    this.rig.setBonePoseOffset("leftFoot", new Euler(0.22 * compression - 0.08 * lift, 0, 0), 1);
    this.rig.setBonePoseOffset("rightFoot", new Euler(0.22 * compression - 0.08 * lift, 0, 0), 1);
  }

  private applyJumpArms(): void {
    const { lift, compression } = this.jumpPhase();
    const swing = lift * 0.34 + compression * 0.12;
    this.rig.setBonePoseOffset("leftShoulder", new Euler(0, 0, -0.04 * swing), 1);
    this.rig.setBonePoseOffset("rightShoulder", new Euler(0, 0, 0.04 * swing), 1);
    this.rig.setBonePoseOffset("leftUpperArm", new Euler(-0.42 * swing, -0.12, this.tuning.armDrop - 0.18 * swing), 1);
    this.rig.setBonePoseOffset("rightUpperArm", new Euler(-0.42 * swing, 0.12, -this.tuning.armDrop + 0.18 * swing), 1);
    this.rig.setBonePoseOffset("leftLowerArm", new Euler(0.15 + 0.18 * swing, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerArm", new Euler(0.15 + 0.18 * swing, 0, 0), 1);
    this.rig.setBonePoseOffset("leftHand", new Euler(0, 0, 0), 1);
    this.rig.setBonePoseOffset("rightHand", new Euler(0, 0, 0), 1);
  }

  private applyBend(intensity: number): void {
    const weight = MathUtils.smoothstep(this.bendTime, 0, 0.75) * intensity;
    // Hinge at the spine base. Rotating the humanoid hips also carries the
    // entire leg hierarchy and makes planted feet sweep through the floor.
    this.rig.setBonePoseOffset("hips", new Euler(0, 0, 0), 1);
    this.rig.setBonePoseOffset("spine", new Euler(-0.62 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("chest", new Euler(-0.28 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("leftUpperLeg", new Euler(0, 0, 0), 1);
    this.rig.setBonePoseOffset("rightUpperLeg", new Euler(0, 0, 0), 1);
    this.rig.setBonePoseOffset("leftLowerLeg", new Euler(-0.08 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerLeg", new Euler(-0.08 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("leftFoot", new Euler(0.08 * weight, 0, 0), 1);
    this.rig.setBonePoseOffset("rightFoot", new Euler(0.08 * weight, 0, 0), 1);
  }

  private bindPosition(bone: Object3D): Vector3 {
    let position = this.bindPositions.get(bone);
    if (!position) {
      position = bone.position.clone();
      this.bindPositions.set(bone, position);
    }
    return position;
  }

  private applyTorso(
    walkWeight: number,
    walking: boolean,
    preserveLowerBody?: boolean,
    preserveUpperBody?: boolean,
  ): void {
    const breathe = Math.sin(this.phase * 0.55) * this.tuning.breathScale;
    const sway = walking ? Math.sin(this.phase) * 0.06 * walkWeight : 0;
    const lean = walking ? -0.08 * walkWeight : 0;
    const twist = walking ? Math.sin(this.phase) * this.tuning.torsoTwist * walkWeight : 0;
    const idleLife = !walking ? Math.sin(this.phase * 0.4) * this.tuning.idleLife : 0;

    if (!preserveLowerBody) {
      this.rig.setBonePoseOffset("hips", new Euler(0, twist * 0.35, sway * 0.35), 1);
    } else if (walking) {
      this.applyGeneratedLowerBodyWeight(walkWeight);
    }
    if (preserveUpperBody) {
      return;
    }
    this.rig.setBonePoseOffset(
      "spine",
      new Euler(lean + breathe * 0.5, -twist * 0.5, -sway * 0.25 + idleLife),
      1,
    );
    this.rig.setBonePoseOffset(
      "chest",
      new Euler(lean * 0.45 + breathe, twist, -sway * 0.2 - idleLife * 0.65),
      1,
    );
  }

  private applyGeneratedLowerBodyWeight(walkWeight: number): void {
    const hips = this.rig.getPoseBone("hips");
    if (hips) {
      const bind = this.bindPosition(hips);
      const compression = (0.5 + 0.5 * Math.cos(this.phase * 2)) * 0.02 * walkWeight;
      hips.position.copy(bind);
      hips.position.y -= compression;
      this.rig.markPoseWrite();
    }
    const loadShift = Math.sin(this.phase) * 0.028 * walkWeight;
    this.rig.setBonePoseOffset("hips", new Euler(-0.02 * walkWeight, 0, loadShift), 1);
  }

  private applyArms(walkWeight: number, walking: boolean): void {
    const swing = walking ? Math.sin(this.phase) * this.tuning.armSwing * walkWeight : 0;
    const leftElbowPulse = walking ? Math.max(0, -Math.sin(this.phase)) * 0.1 * walkWeight : 0;
    const rightElbowPulse = walking ? Math.max(0, Math.sin(this.phase)) * 0.1 * walkWeight : 0;
    const settle = walking ? 0.82 : 0.95;
    const idleForearmBend = 0.08;
    const walkingForearmBend = 0.18 + walkWeight * 0.08;

    this.rig.setBonePoseOffset("leftShoulder", new Euler(0, 0, 0), settle);
    this.rig.setBonePoseOffset("rightShoulder", new Euler(0, 0, 0), settle);

    this.rig.setBonePoseOffset(
      "leftUpperArm",
      new Euler(walking ? swing : -0.08, walking ? 0 : -0.12, this.tuning.armDrop),
      settle,
    );
    this.rig.setBonePoseOffset(
      "rightUpperArm",
      new Euler(walking ? -swing : -0.08, walking ? 0 : 0.12, -this.tuning.armDrop),
      settle,
    );
    this.rig.setBonePoseOffset(
      "leftLowerArm",
      new Euler((walking ? walkingForearmBend + leftElbowPulse : idleForearmBend), walking ? 0 : -0.08, 0.14),
      settle,
    );
    this.rig.setBonePoseOffset(
      "rightLowerArm",
      new Euler((walking ? walkingForearmBend + rightElbowPulse : idleForearmBend), walking ? 0 : 0.08, -0.14),
      settle,
    );
    this.rig.setBonePoseOffset("leftHand", new Euler(walking ? 0.03 : -0.04, 0, 0.03), 0.55);
    this.rig.setBonePoseOffset("rightHand", new Euler(walking ? 0.03 : -0.04, 0, -0.03), 0.55);
  }

  private applyLegs(walkWeight: number, walking: boolean): void {
    const stride = walking ? Math.sin(this.phase) * this.tuning.legSwing * this.tuning.strideScale * walkWeight : 0;
    const leftLift = walking ? Math.max(0, Math.sin(this.phase)) * this.tuning.kneeBend * walkWeight : 0;
    const rightLift = walking ? Math.max(0, -Math.sin(this.phase)) * this.tuning.kneeBend * walkWeight : 0;

    this.rig.setBonePoseOffset("leftUpperLeg", new Euler(stride * this.tuning.legDirection, 0, 0), 1);
    this.rig.setBonePoseOffset("rightUpperLeg", new Euler(-stride * this.tuning.legDirection, 0, 0), 1);
    this.rig.setBonePoseOffset("leftLowerLeg", new Euler(-leftLift, 0, 0), 1);
    this.rig.setBonePoseOffset("rightLowerLeg", new Euler(-rightLift, 0, 0), 1);
    this.rig.setBonePoseOffset("leftFoot", new Euler(leftLift * 0.25, 0, 0), 0.9);
    this.rig.setBonePoseOffset("rightFoot", new Euler(rightLift * 0.25, 0, 0), 0.9);
  }
}
