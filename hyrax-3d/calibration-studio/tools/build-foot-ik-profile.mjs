#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'

import {
  adaptConverterMotionJson,
  adaptCskel27MotionJson,
} from '../adapters/soma-motion-json.js'
import {
  calibrateRoot,
  calibrateScale,
  calibrationReadiness,
  captureRestCalibration,
  configureFootGroundIk,
} from '../core/calibration.js'
import {
  promoteValidatedProfile,
  validateCalibration,
} from '../core/validation.js'

const [
  contractPath,
  rigPath,
  baseProfilePath,
  motionPath,
  profileOut,
  evidenceOut,
  ...qualificationPaths
] = process.argv.slice(2)
if (!evidenceOut) {
  console.error(
    'usage: build-foot-ik-profile.mjs CONTRACT RIG BASE_PROFILE MOTION PROFILE_OUT EVIDENCE_OUT [QUALIFICATION_CHUNK ...]',
  )
  process.exit(2)
}
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))
const contract = await load(contractPath)
const rig = await load(rigPath)
const baseProfile = await load(baseProfilePath)
const motion = await adaptConverterMotionJson(await load(motionPath), contract)
const qualificationMotion = qualificationPaths.length
  ? await adaptCskel27MotionJson(
    await Promise.all(qualificationPaths.map(load)),
    contract,
  )
  : null

let profile = structuredClone(baseProfile)
if (!calibrationReadiness(profile).ready_for_validation) {
  profile = captureRestCalibration({
    profile,
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
} else {
  profile.status = 'draft'
  profile.validation = null
}
profile = configureFootGroundIk({
  profile,
  avatarRig: rig,
  enabled: true,
  groundY: 0,
  contactThreshold: 0.5,
  contactHysteresis: 0.1,
  lockHorizontal: Boolean(qualificationMotion),
  lockOrientation: Boolean(qualificationMotion),
  pelvisCompensationMaxM: qualificationMotion ? 0.08 : 0,
  lockBlendFrames: qualificationMotion ? 4 : 1,
  useRestPosePoles: Boolean(qualificationMotion),
})
profile.profile_id = `${profile.profile_id}:foot-ik-v2`
const evidence = await validateCalibration({
  profile,
  avatarRig: rig,
  motion,
  qualificationMotion,
  frames: [0, 37, 74, 111, 149],
  canonicalSkeleton: contract,
})
if (!evidence.passed) {
  await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`)
  console.error(`foot IK validation failed: ${evidence.result.issues.join('; ')}`)
  process.exit(1)
}
profile = promoteValidatedProfile({
  profile,
  evidence,
  avatarRig: rig,
  canonicalSkeleton: contract,
})
await writeFile(profileOut, `${JSON.stringify(profile, null, 2)}\n`)
await writeFile(evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`wrote foot IK profile and evidence ${evidence.result_signature}`)
