import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Euler,
  Group,
  Object3D,
  Quaternion,
  Vector3,
} from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { VRMSpringBoneJoint } from "@pixiv/three-vrm";

const BONE_SYNONYMS: Record<string, string[]> = {
  hips: ["pelvis", "rootjoint", "root", "lowerback"],
  spine: ["spine0", "spine00", "middleback"],
  chest: ["spine1", "spine01"],
  upperchest: ["spine2", "spine02", "spine3", "upperback"],
  neck: ["neck1"],
  head: ["headjoint"],
  leftupperarm: ["leftarm", "upperarml", "larm"],
  rightupperarm: ["rightarm", "upperarmr", "rarm"],
  leftlowerarm: ["leftforearm", "lowerarml", "lforearm", "forearml"],
  rightlowerarm: ["rightforearm", "lowerarmr", "rforearm", "forearmr"],
  leftupperleg: ["leftupleg", "leftthigh", "upperlegl", "lthigh", "thighl", "uplegl"],
  rightupperleg: ["rightupleg", "rightthigh", "upperlegr", "rthigh", "thighr", "uplegr"],
  leftlowerleg: ["leftleg", "leftcalf", "leftshin", "lowerlegl", "lcalf", "calfl", "shinl", "legl"],
  rightlowerleg: ["rightleg", "rightcalf", "rightshin", "lowerlegr", "rcalf", "calfr", "shinr", "legr"],
  leftfoot: ["footl", "lfoot"],
  rightfoot: ["footr", "rfoot"],
};

const BONE_ALIAS_TO_CANONICAL = new Map<string, string>(
  Object.entries(BONE_SYNONYMS).flatMap(([canonical, aliases]) => [
    [canonical, canonical],
    ...aliases.map((alias) => [alias, canonical] as [string, string]),
  ]),
);

export const CANONICAL_HUMANOID_BONES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
];

const POSE_AUDIT_DERIVED_PHASES = new Set(["poseCommit+vrm"]);
type PoseWriteSpace = "normalized" | "raw";

function cleanBoneName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mixamorig:?/i, "")
    .replace(/^joint:?/i, "")
    .replace(/^armature:?/i, "")
    .replace(/\.[0-9]{3}$/, "")
    .replace(/[_\-\s]+0*[0-9]+$/, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/([a-z])0+([0-9]+)$/, "$1$2");
}

function canonicalBoneKey(name: string): string {
  const cleaned = cleanBoneName(name);
  return BONE_ALIAS_TO_CANONICAL.get(cleaned) ?? cleaned;
}

export class AvatarRig {
  readonly scene: Object3D;
  readonly model: Object3D;
  readonly vrm?: VRM;
  readonly mixer: AnimationMixer;
  private readonly normalizedHumanoidNodeNames = new Set<string>();
  private readonly rawHumanoidNodeNames = new Set<string>();
  private readonly boneCache = new Map<string, Object3D>();
  private readonly localBindCache = new Map<string, Quaternion>();
  private readonly visualBounds = new Box3();
  private readonly visualCenter = new Vector3();
  private readonly visualSize = new Vector3();
  private _windTime = 0;
  private _ambientWindDirection = new Vector3(1, 0, 0.3).normalize();
  private _ambientWindBaseStrength = 0.03;
  private _loggedMixerTargetCoverage = false;
  private _loggedNormalizedHumanoidSync = false;
  private _springBoneBaseGravities = new WeakMap<
    VRMSpringBoneJoint,
    { dir: Vector3; power: number }
  >();
  readonly desiredRetargetPose = new Map<string, { quaternion: Quaternion; position: Vector3 }>();
  private readonly poseAuditEnabled =
    new URLSearchParams(window.location.search).get("poseAudit") === "1";
  private poseAuditPhase: string | null = null;
  private poseAuditPhaseStart = new Map<string, string>();
  private readonly poseAuditWrites = new Map<string, Set<string>>();
  private poseAuditLastLogAt = 0;
  private poseWriteSpace: PoseWriteSpace = "normalized";
  private normalizedPoseDirty = false;

  constructor(model: { scene: Object3D, vrm?: VRM }) {
    this.model = model.scene;
    this.scene = new Group();
    this.scene.name = "AvatarRoot";
    this.scene.add(this.model);
    this.vrm = model.vrm;
    this.mixer = new AnimationMixer(this.model);

    if (this.vrm?.humanoid) {
      // Normal VRM/procedural motion writes the normalized humanoid rig.
      // Explicit raw BVH/FBX compatibility clips switch the frame to raw writes.
      // Keep automatic sync off so commitPose remains the only sync boundary.
      this.vrm.humanoid.autoUpdateHumanBones = false;
      this.cacheHumanoidNodeNames();
      this.logMixerRootTargetCoverage();
    }

    this.model.traverse((obj) => {
      const lowerName = obj.name.toLowerCase();
      const isBone =
        (obj as any).isBone ||
        obj.type === "Bone" ||
        lowerName.includes("joint") ||
        lowerName.includes("bone") ||
        lowerName.includes("mixamorig") ||
        lowerName.includes("spine") ||
        lowerName.includes("arm") ||
        lowerName.includes("leg") ||
        lowerName.includes("hip") ||
        lowerName.includes("neck") ||
        lowerName.includes("head") ||
        lowerName.includes("foot") ||
        lowerName.includes("hand") ||
        lowerName.includes("toe");

      if (isBone) {
        const clean = cleanBoneName(obj.name);
        const canonical = canonicalBoneKey(obj.name);
        this.boneCache.set(clean, obj);
        if (!this.boneCache.has(canonical)) {
          this.boneCache.set(canonical, obj);
        }
        this.localBindCache.set(clean, obj.quaternion.clone().normalize());
        if (!this.localBindCache.has(canonical)) {
          this.localBindCache.set(canonical, obj.quaternion.clone().normalize());
        }
      }
    });
    if (this.vrm?.humanoid) {
      this.cacheVrmHumanoidBinds();
    } else {
      this.inferStandardHumanoidAliases();
    }
  }

  advanceAnimation(dt: number): void {
    this.normalizedPoseDirty = false;
    this.mixer.update(dt);
    this.poseWriteSpace =
      this.hasActiveRawHumanoidAction() && !this.hasActiveNormalizedHumanoidAction()
        ? "raw"
        : "normalized";
  }

  commitPose(dt: number): void {
    this.syncNormalizedHumanoidPose();
    this.captureDesiredRetargetPose();
    if (this.vrm) this.vrm.update(dt);
    if (this.vrm?.springBoneManager) {
      this.vrm.springBoneManager.update(dt);
      this._updateAmbientWind(dt);
    }
  }

  beginPoseAuditFrame(): void {
    if (!this.poseAuditEnabled) return;
    this.poseAuditPhase = null;
    this.poseAuditPhaseStart.clear();
    this.poseAuditWrites.clear();
  }

  beginPoseAuditPhase(phase: string): void {
    if (!this.poseAuditEnabled) return;
    this.poseAuditPhase = phase;
    this.poseAuditPhaseStart = this.captureHumanoidPoseAuditSnapshot();
  }

  endPoseAuditPhase(): void {
    if (!this.poseAuditEnabled || !this.poseAuditPhase) return;
    const end = this.captureHumanoidPoseAuditSnapshot();
    for (const [key, value] of end) {
      if (this.poseAuditPhaseStart.get(key) === value) continue;
      let phases = this.poseAuditWrites.get(key);
      if (!phases) {
        phases = new Set<string>();
        this.poseAuditWrites.set(key, phases);
      }
      phases.add(this.poseAuditPhase);
    }
    this.poseAuditPhase = null;
    this.poseAuditPhaseStart.clear();
  }

  endPoseAuditFrame(): void {
    if (!this.poseAuditEnabled) return;
    const phaseConflicts = Array.from(this.poseAuditWrites.entries())
      .map(([key, phases]) => ({
        key,
        phases: Array.from(phases).filter((phase) => !POSE_AUDIT_DERIVED_PHASES.has(phase)),
      }))
      .filter(({ phases }) => phases.length > 1);
    const crossSpaceWrites = CANONICAL_HUMANOID_BONES.flatMap((name) => {
      const rawPhases = this.poseAuditWrites.get(`raw:${name}`);
      const normalizedPhases = this.poseAuditWrites.get(`normalized:${name}`);
      if (!rawPhases || !normalizedPhases) return [];
      const directRawPhases = Array.from(rawPhases)
        .filter((phase) => !POSE_AUDIT_DERIVED_PHASES.has(phase));
      const directNormalizedPhases = Array.from(normalizedPhases)
        .filter((phase) => !POSE_AUDIT_DERIVED_PHASES.has(phase));
      if (directRawPhases.length === 0 || directNormalizedPhases.length === 0) return [];
      return [{
        bone: name,
        rawPhases: directRawPhases,
        normalizedPhases: directNormalizedPhases,
      }];
    });
    const now = performance.now();
    if (
      (phaseConflicts.length > 0 || crossSpaceWrites.length > 0) &&
      now - this.poseAuditLastLogAt > 1000
    ) {
      this.poseAuditLastLogAt = now;
      console.warn("[Pose Ownership Audit] uncontrolled humanoid writes", {
        phaseConflicts,
        crossSpaceWrites,
      });
    }
  }

  private captureHumanoidPoseAuditSnapshot(): Map<string, string> {
    const snapshot = new Map<string, string>();
    const humanoid = this.vrm?.humanoid;
    for (const name of CANONICAL_HUMANOID_BONES) {
      const raw = humanoid?.getRawBoneNode(name as any) ?? this.getBone(name);
      const normalized = humanoid?.getNormalizedBoneNode(name as any);
      if (raw) snapshot.set(`raw:${name}`, this.quaternionAuditKey(raw.quaternion));
      if (normalized) {
        snapshot.set(`normalized:${name}`, this.quaternionAuditKey(normalized.quaternion));
      }
    }
    return snapshot;
  }

  private quaternionAuditKey(q: Quaternion): string {
    return `${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)},${q.w.toFixed(5)}`;
  }

  private cacheHumanoidNodeNames(): void {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) {
      return;
    }
    for (const name of CANONICAL_HUMANOID_BONES) {
      const normalizedNode = humanoid.getNormalizedBoneNode(name as any);
      if (normalizedNode?.name) {
        this.normalizedHumanoidNodeNames.add(normalizedNode.name);
      }
      const rawNode = humanoid.getRawBoneNode(name as any);
      if (rawNode?.name) {
        this.rawHumanoidNodeNames.add(rawNode.name);
      }
    }
  }

  private syncNormalizedHumanoidPose(): boolean {
    const humanoid = this.vrm?.humanoid;
    if (
      !humanoid ||
      (!this.normalizedPoseDirty && !this.hasActiveNormalizedHumanoidAction())
    ) {
      return false;
    }
    // VRMA clips target normalized humanoid nodes. Three-VRM only copies those
    // normalized poses to raw/skinned bones when autoUpdateHumanBones is true.
    // Keep the global default off for raw BVH/procedural paths, but enable it
    // for this one sync step while a normalized-target mixer action is active.
    const previousAutoUpdate = humanoid.autoUpdateHumanBones;
    humanoid.autoUpdateHumanBones = true;
    humanoid.update();
    humanoid.autoUpdateHumanBones = previousAutoUpdate;
    this.normalizedPoseDirty = false;
    if (!this._loggedNormalizedHumanoidSync) {
      this._loggedNormalizedHumanoidSync = true;
      console.log("[VRMA DEBUG] synced normalized humanoid pose to raw bones", {
        mixerRoot: this.describeObject3D(this.mixer.getRoot() as Object3D),
        normalizedHumanoidNodeCount: this.normalizedHumanoidNodeNames.size,
        autoUpdateHumanBones: humanoid.autoUpdateHumanBones,
        temporaryAutoUpdateHumanBones: true,
      });
    }
    return true;
  }

  private hasActiveNormalizedHumanoidAction(): boolean {
    return this.hasActiveHumanoidActionTargeting(this.normalizedHumanoidNodeNames);
  }

  private hasActiveRawHumanoidAction(): boolean {
    return this.hasActiveHumanoidActionTargeting(this.rawHumanoidNodeNames);
  }

  private hasActiveHumanoidActionTargeting(targetNames: Set<string>): boolean {
    const actions = (((this.mixer as any)._actions || []) as Array<{
      enabled?: boolean;
      paused?: boolean;
      getEffectiveWeight?: () => number;
      getClip?: () => AnimationClip;
      _clip?: AnimationClip;
    }>);
    return actions.some((action) => {
      if (!action?.enabled) {
        return false;
      }
      const weight = action.getEffectiveWeight?.() ?? 0;
      if (weight <= 0.001) {
        return false;
      }
      const clip = action.getClip?.() ?? action._clip ?? null;
      return clip ? this.clipTargetsHumanoidNodes(clip, targetNames) : false;
    });
  }

  private clipTargetsHumanoidNodes(clip: AnimationClip, targetNames: Set<string>): boolean {
    return clip.tracks.some((track) => {
      const dotIndex = track.name.lastIndexOf(".");
      const targetName = dotIndex > 0 ? track.name.slice(0, dotIndex) : track.name;
      return targetNames.has(targetName);
    });
  }

  private logMixerRootTargetCoverage(): void {
    if (this._loggedMixerTargetCoverage || !this.vrm?.humanoid) {
      return;
    }
    this._loggedMixerTargetCoverage = true;
    const mixerRoot = this.mixer.getRoot() as Object3D;
    const normalizedRoot = this.vrm.humanoid.normalizedHumanBonesRoot as Object3D | undefined;
    console.log("[VRMA DEBUG] mixer root target coverage", {
      mixerRoot: this.describeObject3D(mixerRoot),
      modelRoot: this.describeObject3D(this.model),
      vrmScene: this.describeObject3D(this.vrm.scene),
      normalizedHumanoidRoot: this.describeObject3D(normalizedRoot),
      mixerRootContainsNormalizedHumanoidRoot:
        Boolean(normalizedRoot && this.containsObject(mixerRoot, normalizedRoot)),
      normalizedHumanoidNodes: Array.from(this.normalizedHumanoidNodeNames),
      autoUpdateHumanBones: this.vrm.humanoid.autoUpdateHumanBones,
      normalizedPoseSync: "manual_at_final_pose_commit",
    });
  }

  private containsObject(root: Object3D, target: Object3D): boolean {
    let cursor: Object3D | null = target;
    while (cursor) {
      if (cursor === root) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }

  private describeObject3D(object: Object3D | null | undefined): string {
    if (!object) {
      return "(none)";
    }
    return `${object.name || "(unnamed)"}:${object.type}:${object.uuid}`;
  }

  captureDesiredRetargetPose(): void {
    for (const name of CANONICAL_HUMANOID_BONES) {
      const bone = this.getBone(name);
      if (bone) {
        let pose = this.desiredRetargetPose.get(name);
        if (!pose) {
          pose = { quaternion: new Quaternion(), position: new Vector3() };
          this.desiredRetargetPose.set(name, pose);
        }
        pose.quaternion.copy(bone.quaternion);
        pose.position.copy(bone.position);
      }
    }
  }

  getBone(name: string): Object3D | null {
    const target = cleanBoneName(name);
    const canonical = canonicalBoneKey(name);
    if (this.vrm?.humanoid) {
      return (
        this.vrm.humanoid.getRawBoneNode(canonical as any) ??
        this.vrm.humanoid.getNormalizedBoneNode(canonical as any) ??
        this.vrm.humanoid.getRawBoneNode(name as any) ??
        this.vrm.humanoid.getNormalizedBoneNode(name as any) ??
        null
      );
    }
    if (this.boneCache.has(canonical)) return this.boneCache.get(canonical)!;
    if (this.boneCache.has(target)) return this.boneCache.get(target)!;
    const synonyms = BONE_SYNONYMS[canonical] || BONE_SYNONYMS[target] || [];
    for (const syn of synonyms) {
      const cleanSyn = cleanBoneName(syn);
      if (this.boneCache.has(cleanSyn)) return this.boneCache.get(cleanSyn)!;
    }
    return this.scene.getObjectByName(name) || null;
  }

  getPoseBone(name: string): Object3D | null {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid) {
      return this.getBone(name);
    }
    const canonical = canonicalBoneKey(name);
    return this.poseWriteSpace === "normalized"
      ? humanoid.getNormalizedBoneNode(canonical as any) ??
        humanoid.getNormalizedBoneNode(name as any) ??
        humanoid.getRawBoneNode(canonical as any) ??
        humanoid.getRawBoneNode(name as any)
      : humanoid.getRawBoneNode(canonical as any) ??
        humanoid.getRawBoneNode(name as any) ??
        humanoid.getNormalizedBoneNode(canonical as any) ??
        humanoid.getNormalizedBoneNode(name as any);
  }

  getPoseBindQuaternion(name: string): Quaternion | null {
    return this.poseWriteSpace === "normalized" && this.vrm?.humanoid
      ? new Quaternion()
      : this.getLocalBindQuaternion(name);
  }

  private inferStandardHumanoidAliases(): void {
    const hips = this.boneCache.get("hips");
    const neck = this.boneCache.get("neck");
    if (hips && neck) {
      const chain: Object3D[] = [];
      let cursor: Object3D | null = neck.parent;
      while (cursor && cursor !== hips && chain.length < 8) {
        if ((cursor as any).isBone || cursor.type === "Bone") {
          chain.push(cursor);
        }
        cursor = cursor.parent;
      }
      if (cursor === hips && chain.length) {
        chain.reverse();
        this.cacheCanonicalBone("spine", chain[0]);
        this.cacheCanonicalBone("chest", chain[Math.min(1, chain.length - 1)]);
        if (chain.length > 2) {
          this.cacheCanonicalBone("upperchest", chain[chain.length - 1]);
        }
      }
    }
  }

  private cacheVrmHumanoidBinds(): void {
    for (const name of CANONICAL_HUMANOID_BONES) {
      const bone =
        this.vrm?.humanoid?.getRawBoneNode(name as any) ??
        this.vrm?.humanoid?.getNormalizedBoneNode(name as any) ??
        null;
      if (bone) {
        this.cacheCanonicalBone(canonicalBoneKey(name), bone);
      }
    }
  }

  private cacheCanonicalBone(key: string, bone: Object3D): void {
    this.boneCache.set(key, bone);
    this.localBindCache.set(key, bone.quaternion.clone().normalize());
  }

  getLocalBindQuaternion(name: string): Quaternion | null {
    const target = cleanBoneName(name);
    const canonical = canonicalBoneKey(name);
    return (
      this.localBindCache.get(target)?.clone() ??
      this.localBindCache.get(canonical)?.clone() ??
      this.getBone(name)?.quaternion.clone().normalize() ??
      null
    );
  }

  setExpression(name: string, value: number): void {
    if (this.vrm?.expressionManager) {
      try { this.vrm.expressionManager.setValue(name, value); } catch {}
    }
  }

  setRootPosition(x: number, z: number): void { this.scene.position.set(x, 0, z); }
  stopAllActions(): void { this.mixer.stopAllAction() }
  dispose(): void {
    this.mixer.stopAllAction()
    this.boneCache.clear()
    this.localBindCache.clear()
    this.desiredRetargetPose.clear()
    this.poseAuditWrites.clear()
    this.poseAuditPhaseStart.clear()
  }
  getVisualBounds(): Box3 { return this.visualBounds.setFromObject(this.model); }
  getVisualCenter(): Vector3 { this.getVisualBounds().getCenter(this.visualCenter); return this.visualCenter.clone(); }
  getVisualSize(): Vector3 { this.getVisualBounds().getSize(this.visualSize); return this.visualSize.clone(); }

  getViewTarget(mode: "follow" | "portrait" = "follow"): Vector3 {
    const bounds = this.getVisualBounds();
    const height = Math.max(this.getVisualSize().y, 1.2);
    const yRatio = mode === "portrait" ? 0.72 : 0.58;
    return new Vector3(this.scene.position.x, bounds.min.y + height * yRatio, this.scene.position.z);
  }

  getMotionViewTarget(mode: "follow" | "portrait" = "follow"): Vector3 {
    const bounds = this.visualBounds.setFromObject(this.model, true);
    const center = bounds.getCenter(this.visualCenter);
    const height = Math.max(bounds.getSize(this.visualSize).y, 1.2);
    const yRatio = mode === "portrait" ? 0.72 : 0.58;
    return new Vector3(center.x, bounds.min.y + height * yRatio, center.z);
  }

  setFacingYaw(yaw: number): void {
    this.scene.rotation.y = yaw;
  }

  applyAdditiveBoneRotation(boneName: string, euler: Euler, weight = 1): void {
    const q = new Quaternion().setFromEuler(euler);
    if (weight < 1) {
      q.slerp(new Quaternion(), 1 - weight);
    }

    const bone = this.getPoseBone(boneName);
    if (bone) {
      bone.quaternion.multiply(q);
      this.markPoseWrite();
    }
  }

  setBonePoseOffset(boneName: string, euler: Euler, weight = 1): void {
    const q = new Quaternion().setFromEuler(euler);
    if (weight < 1) {
      q.slerp(new Quaternion(), 1 - weight);
    }

    const bone = this.getPoseBone(boneName);
    if (bone) {
      const bind = this.getPoseBindQuaternion(boneName);
      if (bind) {
        bone.quaternion.copy(bind).multiply(q);
        this.markPoseWrite();
      }
    }
  }

  convergeBonePoseOffset(
    boneName: string,
    euler: Euler,
    dt: number,
    response = 4.5,
  ): void {
    const bone = this.getPoseBone(boneName);
    const bind = this.getPoseBindQuaternion(boneName);
    if (!bone || !bind) {
      return;
    }
    const desired = bind.multiply(new Quaternion().setFromEuler(euler));
    const alpha = 1 - Math.exp(-Math.max(0, response) * Math.max(0, dt));
    bone.quaternion.slerp(desired, alpha);
    this.markPoseWrite();
  }

  markPoseWrite(): void {
    if (this.poseWriteSpace === "normalized" && this.vrm?.humanoid) {
      this.normalizedPoseDirty = true;
    }
  }

  setSpringBoneWind(
    windDirection: { x: number; y: number; z: number },
    strength: number,
  ): void {
    const dir = new Vector3(
      windDirection.x,
      windDirection.y,
      windDirection.z,
    ).normalize();
    this._applyWindToSpringBones(dir, strength);
  }

  private _updateAmbientWind(dt: number): void {
    if (!this.vrm?.springBoneManager) {
      return;
    }
    this._windTime += dt;
    const t = this._windTime;
    const strength =
      this._ambientWindBaseStrength *
      (Math.sin(t * 0.5) * 0.5 +
        Math.sin(t * 1.3) * 0.3 +
        Math.sin(t * 2.1) * 0.2);
    this._applyWindToSpringBones(this._ambientWindDirection, strength);
  }

  private _applyWindToSpringBones(direction: Vector3, strength: number): void {
    const manager = this.vrm?.springBoneManager;
    if (!manager) {
      return;
    }
    for (const joint of manager.joints) {
      let base = this._springBoneBaseGravities.get(joint);
      if (!base) {
        base = {
          dir: joint.settings.gravityDir.clone(),
          power: joint.settings.gravityPower,
        };
        this._springBoneBaseGravities.set(joint, base);
      }
      const combined = base.dir
        .clone()
        .multiplyScalar(base.power)
        .add(direction.clone().multiplyScalar(strength));
      const power = combined.length();
      if (power > 0.0001) {
        joint.settings.gravityDir.copy(combined).divideScalar(power);
        joint.settings.gravityPower = power;
      }
    }
  }
}
