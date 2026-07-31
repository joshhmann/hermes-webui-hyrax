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
    'usage: build-validated-profile.mjs CONTRACT RIG DRAFT MOTION PROFILE_OUT EVIDENCE_OUT',
  )
  process.exit(2)
}
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))
const contract = await load(contractPath)
const rig = await load(rigPath)
const draft = await load(draftPath)
const converterMotion = await load(motionPath)
const motion = await adaptConverterMotionJson(converterMotion, contract)

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
  `wrote validated profile (${profile.mapping.length} bones) and `
  + `evidence ${evidence.result_signature}`,
)
