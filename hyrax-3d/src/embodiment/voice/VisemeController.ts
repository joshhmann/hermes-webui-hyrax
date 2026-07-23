import type { AvatarRig } from "../rig/AvatarRig";

/** Maps phonemes to VRM blendshape preset names. */
const VISEME_MAP: Record<string, string> = {
  aa: "A", ae: "I", ah: "I", ao: "O", aw: "U",
  ay: "A", b: "B", ch: "E", d: "E", dh: "E",
  eh: "E", er: "E", ey: "A", f: "F", g: "E",
  hh: "A", ih: "I", iy: "I", jh: "E", k: "E",
  l: "E", m: "B", n: "E", ng: "E", ow: "O",
  oy: "O", p: "B", r: "E", s: "E", sh: "E",
  t: "E", th: "E", uh: "U", uw: "U", v: "F",
  w: "U", y: "I", z: "E", zh: "E", sil: "_",
};

/** Viseme target sent from Hermes audio streaming. */
interface VisemeTarget {
  phoneme: string;
  start: number;
  end: number;
  weight?: number;
}

export class VisemeController {
  private queue: VisemeTarget[] = [];
  private active: VisemeTarget | null = null;
  private time = 0;
  private _disposed = false;

  enqueue(visemes: VisemeTarget[]): void {
    if (this._disposed) return
    this.queue.push(...visemes);
  }

  clear(): void {
    this.queue = [];
    this.active = null;
    this.time = 0;
  }

  dispose(): void {
    this._disposed = true;
    this.clear();
  }

  update(rig: AvatarRig, dt: number): void {
    if (this._disposed) return
    this.time += dt;
    
    // Check active viseme expiry
    if (this.active && this.time > this.active.end) {
      this.active = null;
    }
    
    // Pop next viseme
    if (!this.active && this.queue.length > 0) {
      this.active = this.queue.shift()!;
      this.time = 0;
    }
    
    if (!this.active) {
      // Reset mouth when silent
      const vrm = (rig as any).vrm;
      if (vrm?.expressionManager) {
        vrm.expressionManager.setValue("A", 0);
        vrm.expressionManager.setValue("I", 0);
        vrm.expressionManager.setValue("U", 0);
        vrm.expressionManager.setValue("E", 0);
        vrm.expressionManager.setValue("O", 0);
      }
      return;
    }
    
    const blendName = VISEME_MAP[this.active.phoneme] || "A";
    const weight = this.active.weight ?? 1.0;
    const vrm = (rig as any).vrm;
    
    if (vrm?.expressionManager) {
      // Reset all, set active
      ["A", "I", "U", "E", "O"].forEach(k => vrm.expressionManager.setValue(k, 0));
      vrm.expressionManager.setValue(blendName, weight);
    }
  }

  get isTalking(): boolean {
    return this.active !== null || this.queue.length > 0;
  }
}