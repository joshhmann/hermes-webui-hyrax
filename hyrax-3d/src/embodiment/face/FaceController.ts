import { GazeSystem } from "./GazeSystem";
import type { AvatarRig } from "../rig/AvatarRig";
import type { AttentionTarget, MotionIntent } from "../types";

const EMOTION_EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised", "thinking"];

export class FaceController {
  private time = 0
  private blinkIn = 2.8
  private blinkFor = 0
  private microShift = 0
  private currentExpression = "neutral"
  private currentIntensity = 0.4
  private currentTalking = false
  private readonly gazeSystem = new GazeSystem()
  private _disposed = false

  applyIntent(intent: MotionIntent): void {
    if (this._disposed) return
    const face = intent.face
    this.currentExpression = String(face?.expression || "neutral")
    this.currentIntensity = Number(face?.intensity || 0.4)
    this.currentTalking = Boolean(face?.talking)
  }

  setAttentionTarget(target: AttentionTarget | null): void {
    if (this._disposed) return
    this.gazeSystem.setTarget(target)
  }

  update(rig: AvatarRig, dt: number): void {
    if (this._disposed) return
    this.time += dt
    this.updateBlink(dt)

    const micro = this.currentTalking
      ? 0.08 + Math.max(0, Math.sin(this.time * 7.5)) * 0.08
      : (Math.sin(this.time * 1.9) + 1) * 0.015;
    this.microShift += (micro - this.microShift) * Math.min(1, dt * 6);

    this.applyEmotion(rig);
    this.applyBlink(rig);
    this.applyMicroLife(rig);
    this.gazeSystem.update(rig, dt);
  }

  private updateBlink(dt: number): void {
    this.blinkIn -= dt;
    if (this.blinkFor > 0) {
      this.blinkFor -= dt;
      return;
    }
    if (this.blinkIn <= 0) {
      this.blinkFor = 0.12;
      // Normal: 2.5-6s. Thinking: 5-10s. Surprised/Anxious: 1.5-4s.
      const blinkScale = this.currentExpression === "thinking" ? 1.8 :
                         (this.currentExpression === "surprised" || this.currentIntensity > 0.7) ? 0.6 : 1.0;
      this.blinkIn = (2.4 + (Math.sin(this.time * 0.43) + 1) * 1.8) * blinkScale;
    }
  }

  private applyEmotion(rig: AvatarRig): void {
    for (const name of EMOTION_EXPRESSIONS) {
      if (name !== this.currentExpression) {
        rig.setExpression(name, 0);
      }
    }
    if (this.currentExpression !== "neutral") {
      rig.setExpression(this.currentExpression, Math.max(0.1, Math.min(1, this.currentIntensity)));
    }
  }

  private applyBlink(rig: AvatarRig): void {
    const blinkWeight = this.blinkFor > 0 ? Math.min(1, this.blinkFor / 0.06) : 0;
    rig.setExpression("blink", blinkWeight);
  }

  private applyMicroLife(rig: AvatarRig): void {
    const eyebrowTarget = Math.max(0, Math.min(0.22, this.microShift));
    const mouthTarget = this.currentTalking
      ? Math.max(0.08, Math.min(0.35, this.microShift * 1.3))
      : Math.max(0, Math.min(0.08, this.microShift * 0.5));

    rig.setExpression("relaxed", this.currentExpression === "relaxed" ? this.currentIntensity : eyebrowTarget);
    rig.setExpression("aa", mouthTarget);
  }

  dispose(): void {
    this._disposed = true
    this.gazeSystem.dispose()
    this.currentExpression = "neutral"
    this.currentIntensity = 0
    this.currentTalking = false
  }
}
