import { extractThreeAvatarRig } from './three-avatar-rig.js?v=6'

const NORMALIZATION_MARKER = 'somaFbxNormalization'

export function fbxUnitScaleToMeters(unitScaleFactor) {
  if (!Number.isFinite(unitScaleFactor) || unitScaleFactor <= 0) {
    throw new TypeError('FBX UnitScaleFactor must be a finite number greater than zero')
  }
  return unitScaleFactor / 100
}

function baseOptions({
  object,
  assetSignature,
  filename,
  importerVersion,
  rigSpace,
  basisCorrection,
  coordinateSystem,
}) {
  return {
    root: object,
    format: 'fbx',
    formatVersion: 'unknown',
    assetSignature,
    importer: 'three/FBXLoader',
    importerVersion,
    rigSpace,
    basisCorrection,
    coordinateSystem,
    rigId: `fbx:${filename}:${assetSignature.slice(7, 19)}`,
  }
}

export async function inspectThreeFbxAvatarRig(options) {
  return extractThreeAvatarRig(baseOptions({
    ...options,
    rigSpace: 'raw',
    basisCorrection: 'unresolved-user-declaration-required',
    coordinateSystem: {
      status: 'unresolved',
      handedness: 'unknown',
      up_axis: 'unknown',
      forward_axis: 'unknown',
      linear_unit: 'unknown',
    },
  }))
}

export async function normalizeAndExtractThreeFbxAvatarRig({
  object,
  assetSignature,
  filename,
  importerVersion,
  sourceFacing,
  unitScaleFactor,
}) {
  if (!object?.userData) throw new TypeError('FBX object must be a Three.js Object3D')
  if (object.userData[NORMALIZATION_MARKER]) {
    throw new Error('FBX object has already been normalized; re-import it to change the declaration')
  }
  if (!['+Z', '-Z'].includes(sourceFacing)) {
    throw new TypeError('FBX source facing must be declared as "+Z" or "-Z"')
  }

  const metersPerUnit = fbxUnitScaleToMeters(unitScaleFactor)
  const originalScale = object.scale.clone()
  const originalQuaternion = object.quaternion.clone()
  try {
    object.scale.multiplyScalar(metersPerUnit)
    if (sourceFacing === '-Z') object.rotation.y += Math.PI
    object.userData[NORMALIZATION_MARKER] = {
      source_facing: sourceFacing,
      unit_scale_factor_cm: unitScaleFactor,
      meters_per_unit: metersPerUnit,
    }
    object.updateMatrixWorld(true)

    const yawCorrection = sourceFacing === '-Z' ? 'scene-yaw-180' : 'none'
    return await extractThreeAvatarRig(baseOptions({
      object,
      assetSignature,
      filename,
      importerVersion,
      rigSpace: 'normalized',
      basisCorrection:
        `declared-fbx(unit-scale:${unitScaleFactor}cm,yaw:${yawCorrection})`,
      coordinateSystem: {
        status: 'declared',
        handedness: 'right',
        up_axis: '+Y',
        forward_axis: '+Z',
        linear_unit: 'meter',
      },
    }))
  } catch (error) {
    object.scale.copy(originalScale)
    object.quaternion.copy(originalQuaternion)
    delete object.userData[NORMALIZATION_MARKER]
    object.updateMatrixWorld(true)
    throw error
  }
}
