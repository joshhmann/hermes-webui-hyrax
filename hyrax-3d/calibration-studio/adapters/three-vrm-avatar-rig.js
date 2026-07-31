import { extractThreeAvatarRig } from './three-avatar-rig.js?v=6'

export const MVP_HUMANOID_SEMANTICS = Object.freeze([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
])

/**
 * Format-specific wrapper for an already-loaded three-vrm avatar.
 *
 * Loading and VRM-0 scene correction remain the importer's responsibility.
 * This wrapper records those decisions and extracts normalized humanoid bones;
 * it does not apply or infer a facing correction.
 */
export async function extractThreeVrmAvatarRig({
  vrm,
  assetSignature,
  formatVersion,
  importerVersion,
  basisCorrection,
  coordinateSystem,
  semanticNames = MVP_HUMANOID_SEMANTICS,
  rigId = null,
}) {
  if (!vrm?.scene || !vrm?.humanoid?.getNormalizedBoneNode) {
    throw new TypeError('vrm must expose scene and normalized humanoid bones')
  }
  const semanticBones = {}
  for (const semantic of semanticNames) {
    const node = vrm.humanoid.getNormalizedBoneNode(semantic)
    if (node) semanticBones[semantic] = node
  }
  if (!semanticBones.hips) throw new Error('VRM normalized humanoid has no hips bone')

  return extractThreeAvatarRig({
    root: vrm.scene,
    format: 'vrm',
    formatVersion,
    assetSignature,
    importer: '@pixiv/three-vrm',
    importerVersion,
    rigSpace: 'normalized',
    basisCorrection,
    coordinateSystem,
    semanticBones,
    bones: Object.values(semanticBones),
    rigId,
  })
}

/**
 * Extract compatibility and detailed views from the same normalized VRM rig.
 *
 * The core call is intentionally identical to the historical extractor so a
 * previously signed 22-bone profile can still resolve its exact rig signature.
 */
export async function extractThreeVrmAvatarRigVariants({
  coreSemanticNames = MVP_HUMANOID_SEMANTICS,
  detailedSemanticNames,
  ...options
}) {
  if (!Array.isArray(detailedSemanticNames) || detailedSemanticNames.length === 0) {
    throw new TypeError('detailedSemanticNames must be a non-empty array')
  }
  const [core, detailed] = await Promise.all([
    extractThreeVrmAvatarRig({
      ...options,
      semanticNames: coreSemanticNames,
    }),
    extractThreeVrmAvatarRig({
      ...options,
      semanticNames: detailedSemanticNames,
    }),
  ])
  return { core, detailed }
}
