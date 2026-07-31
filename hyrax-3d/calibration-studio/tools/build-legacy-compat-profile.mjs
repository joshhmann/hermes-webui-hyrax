#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'

import { adaptConverterMotionJson } from '../adapters/soma-motion-json.js'
import {
  calibrateRoot,
  calibrateScale,
  captureRestCalibration,
} from '../core/calibration.js'
import {
  promoteValidatedProfile,
  validateCalibration,
} from '../core/validation.js'

const [contractPath, rigPath, draftPath, motionPath, profileOut, evidenceOut] =
  process.argv.slice(2)
if (!evidenceOut) {
  console.error(
    'usage: build-legacy-compat-profile.mjs CONTRACT RIG DRAFT MOTION PROFILE_OUT EVIDENCE_OUT',
  )
  process.exit(2)
}
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))
const contract = await load(contractPath)
const rig = await load(rigPath)
const draft = await load(draftPath)
const motion = await adaptConverterMotionJson(await load(motionPath), contract)

let profile = captureRestCalibration({
  profile: draft,
  avatarRig: rig,
  motion,
  frame: 0,
  canonicalSkeleton: contract,
})
profile = calibrateRoot({
  profile,
  avatarRig: rig,
  motion,
  frame: 0,
  canonicalSkeleton: contract,
})
profile = calibrateScale({
  profile,
  avatarRig: rig,
  motion,
  canonicalSkeleton: contract,
})
const hipsMapping = profile.mapping.find((entry) => entry.semantic === 'hips')
const hipsBone = rig.bones.find((bone) => bone.id === hipsMapping.target_bone_id)
profile.profile_id = 'tai-legacy-soma-vrm-v1'
profile.runtime_corrections = {
  mode: 'legacy-soma-vrm-v1',
  root_position_mode: 'legacy-replace-xz-add-y',
  translation_scale_override: hipsBone.rest_world.position[1] / 0.954,
  ground_contact: {
    enabled: true,
    ground_y: 0,
    contact_threshold: 0.5,
    smoothing_factor: 0.4,
    contact_channels: {
      leftFoot: 1,
      rightFoot: 3,
    },
  },
}
profile.authoring = {
  ...(profile.authoring ?? {}),
  runtime_compatibility_provenance:
    'Exact extraction from frozen SomaVrmRetargeter.js; calibration values remain measured.',
}
const evidence = await validateCalibration({
  profile,
  avatarRig: rig,
  motion,
  frames: [0, 37, 74, 111, 149],
  canonicalSkeleton: contract,
})
profile = promoteValidatedProfile({
  profile,
  evidence,
  avatarRig: rig,
  canonicalSkeleton: contract,
})
await writeFile(profileOut, `${JSON.stringify(profile, null, 2)}\n`)
await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(
  `wrote legacy compatibility profile and evidence ${evidence.result_signature}`,
)
