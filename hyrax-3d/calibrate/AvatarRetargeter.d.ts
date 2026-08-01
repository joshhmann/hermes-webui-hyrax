// Type declarations for AvatarRetargeter.js (plain JS shared by the debug
// page and the loft's vite/TS build). The class is the single implementation
// of profile-driven retargeting; keep these declarations in sync with it.

/** Minimal structural view of the calibration profile JSON the retargeter reads. */
export interface AvatarRetargeterProfile {
  solve_order: string[]
  vrm_bone_parents: Record<string, string | null>
  skeleton_maps: Record<string, Record<string, string> | string>
  rest_pose: {
    default_src_hips_height_m?: number
    rest_frame_default?: number
    rest_frame_recommended?: Record<string, number>
    /**
     * Canonical source rest (settled T-pose world rotations, row-major 3x3
     * per joint) — the live stream has no T-pose settle, so rest offsets are
     * measured from this embedded reference instead of a stream frame.
     */
    source_rest?: {
      joints: string[]
      world_rot_mats: number[][]
      [key: string]: unknown
    }
  }
  [key: string]: unknown
}

/** Structural VRM view consumed by the retargeter (satisfied by VrmLike wrappers). */
export interface AvatarRetargeterVrm {
  humanoid: {
    getNormalizedBoneNode(name: string): any
    update?(): void
    resetNormalizedPose?(): void
  }
  scene: any
  meta?: { metaVersion?: string } | undefined
}

export interface AvatarRetargeterOptions {
  srcHipsHeight?: number
  restFrame?: number
}

export interface ApplyFrameOptions {
  groundY?: number
  contactSmoothing?: number
  /** false → an external owner writes the hips node position (loft RootMotionAdapter). */
  writeHipsPosition?: boolean
}

export declare class AvatarRetargeter {
  constructor(vrm: AvatarRetargeterVrm, profile: AvatarRetargeterProfile, opts?: AvatarRetargeterOptions)
  solveOrder: string[]
  vrmParent: Record<string, string | null>
  hipsScale: number
  boneMap: Record<string, string> | null
  readonly groundCorrection: number
  setMotion(motion: any): void
  /** Swap the posed motion WITHOUT re-measuring rest offsets (live stream after
   *  calibration against a canonical rest reference). */
  setPoseMotion(motion: any): void
  applyFrame(frame: number, opts?: ApplyFrameOptions): { quat: Record<string, any>; hipsPos: any } | null
  applyBatch(frameStart: number, frameCount: number): void
  onReset(): void
  getBoneQuaternion(boneName: string): any
  getHipsPosition(): any
  solveFootIK(frame: number, opts?: { maxIterations?: number; groundY?: number }): void
}
