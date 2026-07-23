import { Color } from "three";
import type { AmbientLight, DirectionalLight, PointLight, Scene } from "three";

/** Time-of-day phases driving atmosphere transitions. */
interface TimePhase {
  background: string;
  ambientColor: string;
  ambientIntensity: number;
  directionalColor: string;
  directionalIntensity: number;
  pendantIntensity: number;
  projectorIntensity: number;
  serverIntensity: number;
  fogColor: string;
  fogDensity: number;
}

export type TimeOfDayPreset = "dawn" | "noon" | "dusk" | "night";

const DAWN: TimePhase = {
  background: "#1a1428", ambientColor: "#ffd4b8", ambientIntensity: 0.25,
  directionalColor: "#ffaa66", directionalIntensity: 0.3,
  pendantIntensity: 0.2, projectorIntensity: 0.1, serverIntensity: 0.05,
  fogColor: "#1a1428", fogDensity: 0.015,
};

const NOON: TimePhase = {
  background: "#b8cce0", ambientColor: "#fff8f0", ambientIntensity: 0.65,
  directionalColor: "#ffe8cc", directionalIntensity: 0.95,
  pendantIntensity: 0.15, projectorIntensity: 0.05, serverIntensity: 0.05,
  fogColor: "#c8d8e8", fogDensity: 0.005,
};

const DUSK: TimePhase = {
  background: "#2a1828", ambientColor: "#ffaa88", ambientIntensity: 0.35,
  directionalColor: "#ff8844", directionalIntensity: 0.5,
  pendantIntensity: 0.6, projectorIntensity: 0.3, serverIntensity: 0.15,
  fogColor: "#2a1828", fogDensity: 0.012,
};

const NIGHT: TimePhase = {
  background: "#080c14", ambientColor: "#8899cc", ambientIntensity: 0.12,
  directionalColor: "#334466", directionalIntensity: 0.08,
  pendantIntensity: 0.35, projectorIntensity: 0.2, serverIntensity: 0.25,
  fogColor: "#080c14", fogDensity: 0.025,
};

const TIME_PHASES: Record<TimeOfDayPreset, TimePhase> = {
  dawn: DAWN,
  noon: NOON,
  dusk: DUSK,
  night: NIGHT,
};

function lerpPhase(a: TimePhase, b: TimePhase, t: number): TimePhase {
  const ca = new Color(a.background);
  const cb = new Color(b.background);
  const cc = ca.clone().lerp(cb, t);
  return {
    background: `#${cc.getHexString()}`,
    ambientColor: `#${new Color(a.ambientColor).lerp(new Color(b.ambientColor), t).getHexString()}`,
    ambientIntensity: a.ambientIntensity + (b.ambientIntensity - a.ambientIntensity) * t,
    directionalColor: `#${new Color(a.directionalColor).lerp(new Color(b.directionalColor), t).getHexString()}`,
    directionalIntensity: a.directionalIntensity + (b.directionalIntensity - a.directionalIntensity) * t,
    pendantIntensity: a.pendantIntensity + (b.pendantIntensity - a.pendantIntensity) * t,
    projectorIntensity: a.projectorIntensity + (b.projectorIntensity - a.projectorIntensity) * t,
    serverIntensity: a.serverIntensity + (b.serverIntensity - a.serverIntensity) * t,
    fogColor: `#${new Color(a.fogColor).lerp(new Color(b.fogColor), t).getHexString()}`,
    fogDensity: a.fogDensity + (b.fogDensity - a.fogDensity) * t,
  };
}

export class TimeOfDaySystem {
  private scene: Scene;
  private ambient: AmbientLight;
  private directional: DirectionalLight;
  private pendant: PointLight;
  private projector: PointLight;
  private server: PointLight;
  private lastPhase: TimePhase | null = null;
  private enabled = true;
  private fixedPhase: TimePhase | null = null;
  private _disposed = false;

  constructor(
    scene: Scene,
    ambient: AmbientLight,
    directional: DirectionalLight,
    pendant: PointLight,
    projector: PointLight,
    server: PointLight,
  ) {
    this.scene = scene;
    this.ambient = ambient;
    this.directional = directional;
    this.pendant = pendant;
    this.projector = projector;
    this.server = server;
  }

  dispose(): void {
    this._disposed = true;
    this.enabled = false;
    this.fixedPhase = null;
    this.lastPhase = null;
  }

  /** Convert browser-local hour (0–24) to a phase blend. */
  private hourToPhase(hour: number): { phase: TimePhase; t: number; next: TimePhase } {
    if (hour >= 5 && hour < 8) return { phase: DAWN, t: 0, next: NOON };
    if (hour >= 8 && hour < 16) return { phase: NOON, t: 0, next: DUSK };
    if (hour >= 16 && hour < 19) return { phase: DUSK, t: 0, next: NIGHT };
    if (hour >= 19 || hour < 5) return { phase: NIGHT, t: 0, next: DAWN };
    return { phase: NOON, t: 0, next: DUSK };
  }

  private smoothHour(): number {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  }

  setFixedPhase(preset: TimeOfDayPreset | null): void {
    this.fixedPhase = preset ? TIME_PHASES[preset] : null;
    this.lastPhase = null;
    this.update();
  }

  update(): void {
    if (!this.enabled || this._disposed) return;
    const hour = this.smoothHour();
    const phase = this.fixedPhase ?? this.hourToPhase(hour).phase;
    
    // Only apply if changed to avoid thrashing
    if (this.lastPhase === phase) return;
    this.lastPhase = phase;

    // Apply phase
    this.scene.background = new Color(phase.background);
    if (this.scene.fog) {
      (this.scene.fog as any).color = new Color(phase.fogColor);
      (this.scene.fog as any).density = phase.fogDensity;
    }
    this.ambient.color = new Color(phase.ambientColor);
    this.ambient.intensity = phase.ambientIntensity;
    this.directional.color = new Color(phase.directionalColor);
    this.directional.intensity = phase.directionalIntensity;
    this.pendant.intensity = phase.pendantIntensity;
    this.projector.intensity = phase.projectorIntensity;
    this.server.intensity = phase.serverIntensity;
  }
}
