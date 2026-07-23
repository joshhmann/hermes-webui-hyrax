import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import type { AvatarRig } from "../rig/AvatarRig";
import type { AttentionTarget } from "../types";

export class GazeSystem {
  private target: AttentionTarget | null = null;
  private readonly leftEyeRest = new Quaternion();
  private readonly rightEyeRest = new Quaternion();
  private hasRestPos = false;

  // Saccade state
  private saccadeTimer = 0;
  private saccadeOffset = new Euler();
  private nextSaccadeIn = 0;

  // Gaze smoothing
  private currentGazeEuler = new Euler();
  private targetGazeEuler = new Euler();

  // Eye wander (when no target)
  private wanderTimer = 0;
  private wanderTarget = new Vector3();
  private wanderNextChange = 0;
  private _disposed = false;

  constructor() {}

  dispose(): void {
    this._disposed = true;
    this.target = null;
    this.hasRestPos = false;
  }

  setTarget(target: AttentionTarget | null): void {
    this.target = target;
  }

  update(rig: AvatarRig, dt: number): void {
    const leftEye = rig.getPoseBone("leftEye");
    const rightEye = rig.getPoseBone("rightEye");
    if (!leftEye || !rightEye) return;

    if (!this.hasRestPos) {
      this.leftEyeRest.copy(leftEye.quaternion);
      this.rightEyeRest.copy(rightEye.quaternion);
      this.hasRestPos = true;
    }

    this.updateSaccade(dt);
    this.updateWander(rig, dt);
    this.updateGaze(rig, leftEye, dt);

    // Apply combined rotation to both eyes
    const finalLeft = new Quaternion().setFromEuler(
      new Euler(
        this.currentGazeEuler.x + this.saccadeOffset.x,
        this.currentGazeEuler.y + this.saccadeOffset.y,
        0
      )
    );
    const finalRight = finalLeft.clone();

    leftEye.quaternion.copy(this.leftEyeRest).multiply(finalLeft);
    rightEye.quaternion.copy(this.rightEyeRest).multiply(finalRight);
    rig.markPoseWrite();
  }

  private updateSaccade(dt: number): void {
    this.saccadeTimer += dt;
    if (this.saccadeTimer >= this.nextSaccadeIn) {
      this.saccadeTimer = 0;
      this.nextSaccadeIn = 0.2 + Math.random() * 1.8;
      const amplitude = MathUtils.degToRad(Math.random() * 8);
      const angle = Math.random() * Math.PI * 2;
      this.saccadeOffset.x = Math.sin(angle) * amplitude;
      this.saccadeOffset.y = Math.cos(angle) * amplitude;
    }
    this.saccadeOffset.x *= 0.9;
    this.saccadeOffset.y *= 0.9;
  }

  private updateWander(rig: AvatarRig, dt: number): void {
    if (this.target && this.target.weight > 0) return;
    this.wanderTimer += dt;
    if (this.wanderTimer >= this.wanderNextChange) {
      this.wanderTimer = 0;
      this.wanderNextChange = 4 + Math.random() * 6;
      // Generate a point in front of the character, 1-3m away, within 40 degree cone
      const dist = 1.5 + Math.random() * 2;
      const yaw = (Math.random() - 0.5) * MathUtils.degToRad(25);
      const pitch = (Math.random() - 0.5) * MathUtils.degToRad(15);
      this.wanderTarget.set(
        Math.sin(yaw) * dist,
        1.6 + Math.sin(pitch) * dist,
        Math.cos(yaw) * dist
      );
      // Convert from character-local to world space so the gaze math
      // (which uses world-space eye positions) produces correct angles.
      this.wanderTarget.applyQuaternion(rig.scene.quaternion);
      const rootWorldPos = new Vector3();
      rig.scene.getWorldPosition(rootWorldPos);
      this.wanderTarget.add(rootWorldPos);
    }
  }

  private updateGaze(rig: AvatarRig, eyeBone: any, dt: number): void {
    if (!this.target || this.target.weight <= 0) {
      // Use wander target
      const eyeWorldPos = new Vector3();
      eyeBone.getWorldPosition(eyeWorldPos);
      const rel = this.wanderTarget.clone().sub(eyeWorldPos);
      const localRel = rel.clone().applyQuaternion(rig.scene.quaternion.clone().invert());
      const limit = MathUtils.degToRad(25);
      this.targetGazeEuler.x = MathUtils.clamp(Math.atan2(localRel.y, Math.sqrt(localRel.x * localRel.x + localRel.z * localRel.z)), -limit, limit);
      this.targetGazeEuler.y = MathUtils.clamp(-Math.atan2(localRel.x, localRel.z), -limit, limit);
    } else {
      const eyeWorldPos = new Vector3();
      eyeBone.getWorldPosition(eyeWorldPos);
      const targetPos = new Vector3(
        this.target.position.x,
        this.target.position.y || 1.6,
        this.target.position.z
      );
      const rel = targetPos.clone().sub(eyeWorldPos);
      const charForward = new Vector3(0, 0, 1).applyQuaternion(rig.scene.quaternion);
      const dot = charForward.dot(rel.clone().normalize());
      if (dot > 0.5) {
        const localRel = rel.clone().applyQuaternion(rig.scene.quaternion.clone().invert());
        const yaw = -Math.atan2(localRel.x, localRel.z);
        const pitch = Math.atan2(localRel.y, Math.sqrt(localRel.x * localRel.x + localRel.z * localRel.z));
        const limit = MathUtils.degToRad(25);
        this.targetGazeEuler.x = MathUtils.clamp(pitch, -limit, limit);
        this.targetGazeEuler.y = MathUtils.clamp(yaw, -limit, limit);
      } else {
        this.targetGazeEuler.set(0, 0, 0);
      }
    }
    const lerpFactor = Math.min(1, dt * 8);
    this.currentGazeEuler.x += (this.targetGazeEuler.x - this.currentGazeEuler.x) * lerpFactor;
    this.currentGazeEuler.y += (this.targetGazeEuler.y - this.currentGazeEuler.y) * lerpFactor;
  }
}
