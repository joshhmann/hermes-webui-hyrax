import { adaptMotionJson } from '../calibration-studio/adapters/soma-motion-json.js?v=4'
import {
  extractThreeVrmAvatarRigVariants,
} from '../calibration-studio/adapters/three-vrm-avatar-rig.js?v=3'
import { indexThreeRigObjects } from '../calibration-studio/adapters/three-avatar-rig.js?v=6'
import {
  applyPoseToThreeObject,
  createRetargetSession,
} from '../calibration-studio/core/retarget.js?v=10'
import { sha256Signature } from '../calibration-studio/core/sha256.js?v=1'

export const STUDIO_PROFILE_SCHEMA = 'soma.avatar-calibration'

export function isStudioCalibrationProfile(value) {
  return value?.schema === STUDIO_PROFILE_SCHEMA
}

export function viewerMotionJson(motion) {
  if (!motion) throw new TypeError('viewer motion must be loaded')
  return {
    skeleton: motion.skeleton,
    source_skeleton: motion.sourceSkeleton ?? motion.skeleton,
    rotation_space: motion.rotationSpace ?? 'global',
    fps: motion.fps,
    joints: structuredClone(motion.joints),
    parents: motion.parentIdx.map((parent) => (
      parent < 0 ? null : motion.joints[parent]
    )),
    global_rot_mats: structuredClone(motion.rot),
    root_positions: structuredClone(motion.root),
    rest_offsets_m: structuredClone(motion.offsets),
    foot_contacts: structuredClone(motion.contacts),
  }
}

export async function adaptViewerMotion(motion, canonicalSkeleton) {
  const source = viewerMotionJson(motion)
  // Shape-aware carrier dispatch (payload joint count, not skeleton id alone):
  // somaskel30/somaskel77 with a 30-joint payload expands via the soma30
  // adapter; a true lossless 77-joint carrier keeps the strict pass-through.
  return adaptMotionJson(source, canonicalSkeleton)
}

export async function resolveStudioVrmRig({
  vrm,
  avatarBytes,
  avatarFilename,
  profile,
  roleCatalog,
}) {
  if (!vrm?.scene) throw new TypeError('a loaded VRM is required')
  if (!(avatarBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(avatarBytes)) {
    throw new TypeError('the original avatar bytes are required for signature verification')
  }
  const assetSignature = await sha256Signature(avatarBytes)
  if (assetSignature !== profile.avatar.asset_signature) {
    throw new Error(
      `avatar asset signature mismatch: profile expects `
      + `${profile.avatar.asset_signature}, loaded ${assetSignature}`,
    )
  }

  const version = String(vrm.meta?.metaVersion ?? 'unknown')
  const basisCorrection = version === '0'
    ? 'VRMUtils.rotateVRM0(scene-yaw-180)'
    : 'none'
  if (!avatarFilename) throw new TypeError('the imported avatar filename is required')
  const displayPosition = vrm.scene.position.clone()
  const displayParent = vrm.scene.parent
  if (displayParent) displayParent.remove(vrm.scene)
  vrm.scene.position.set(0, 0, 0)
  vrm.scene.updateMatrixWorld(true)
  let resolved
  try {
    const variants = await extractThreeVrmAvatarRigVariants({
      vrm,
      assetSignature,
      formatVersion: version,
      importerVersion: '3.0.0',
      basisCorrection,
      coordinateSystem: {
        status: 'declared',
        handedness: 'right',
        up_axis: '+Y',
        forward_axis: version === '0'
          ? '-Z-scene-local-after-normalization'
          : '+Z',
        linear_unit: 'meter',
      },
      rigId: `vrm:${avatarFilename}:${assetSignature.slice(7, 19)}`,
      detailedSemanticNames: roleCatalog.roles.map((role) => role.semantic),
    })
    const avatarRig = [variants.detailed, variants.core].find(
      (candidate) => candidate.rig_signature === profile.avatar.rig_signature,
    )
    if (!avatarRig) {
      throw new Error(
        `avatar rig signature mismatch: profile expects ${profile.avatar.rig_signature}; `
        + `loaded variants are ${variants.detailed.rig_signature} and ${variants.core.rig_signature}`,
      )
    }
    resolved = {
      avatarRig,
      objectByRigId: indexThreeRigObjects(vrm.scene, avatarRig),
    }
  } finally {
    vrm.scene.position.copy(displayPosition)
    if (displayParent) displayParent.add(vrm.scene)
    vrm.scene.updateMatrixWorld(true)
  }
  return resolved
}

export function createStudioViewerRetargeter({
  profile,
  avatarRig,
  motion,
  canonicalSkeleton,
  objectByRigId,
  commitPose = null,
}) {
  let session = createRetargetSession({
    profile,
    avatarRig,
    motion,
    canonicalSkeleton,
    requireValidated: true,
  })
  let previousFrame = -1
  let lastPose = null

  function reset() {
    session.reset()
    previousFrame = -1
    lastPose = null
  }

  function solveThrough(frame) {
    if (frame !== previousFrame + 1) reset()
    for (let cursor = previousFrame + 1; cursor <= frame; cursor += 1) {
      lastPose = session.solve(cursor)
    }
    previousFrame = frame
    applyPoseToThreeObject(lastPose, objectByRigId)
    commitPose?.()
    return lastPose
  }

  return {
    get lastPose() {
      return lastPose
    },
    applyFrame: solveThrough,
    onReset: reset,
  }
}
