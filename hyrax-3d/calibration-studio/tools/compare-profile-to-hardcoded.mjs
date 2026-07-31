#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'

import { contractSignature } from '../core/contracts.js'

const [profileEvidenceArg, hardcodedBaselineArg, outputArg] = process.argv.slice(2)
if (!outputArg) {
  console.error('usage: compare-profile-to-hardcoded.mjs PROFILE_EVIDENCE HARDCODED_BASELINE OUTPUT')
  process.exit(2)
}
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))
const profileEvidence = await load(profileEvidenceArg)
const hardcoded = await load(hardcodedBaselineArg)
const referenceClip = hardcoded.clips.find(
  (clip) => clip.id === 'corrected-kimodo-soma77',
)
if (!referenceClip) throw new Error('hardcoded baseline has no corrected Kimodo clip')

function positionError(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]))
}

function angularError(left, right) {
  const leftLength = Math.hypot(...left)
  const rightLength = Math.hypot(...right)
  const dot = Math.abs(left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
  ) / (leftLength * rightLength))
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)))
}

const profileByFrame = new Map(
  profileEvidence.result.snapshots.map((sample) => [sample.frame, sample]),
)
const measurements = []
for (const hardcodedSample of referenceClip.samples) {
  const profileSample = profileByFrame.get(hardcodedSample.frame)
  if (!profileSample) continue
  const profileBySemantic = new Map(
    profileSample.bones.map((bone) => [bone.semantic, bone]),
  )
  for (const legacyBone of hardcodedSample.bones) {
    const profileBone = profileBySemantic.get(legacyBone.semantic)
    if (!profileBone) continue
    measurements.push({
      frame: hardcodedSample.frame,
      semantic: legacyBone.semantic,
      local_position_m: positionError(
        profileBone.local_position,
        legacyBone.local_position,
      ),
      local_angular_rad: angularError(
        profileBone.local_quaternion,
        legacyBone.local_quaternion,
      ),
      world_position_m: positionError(
        profileBone.world_position,
        legacyBone.world_position,
      ),
      world_angular_rad: angularError(
        profileBone.world_quaternion,
        legacyBone.world_quaternion,
      ),
    })
  }
}

const fields = [
  'local_position_m',
  'local_angular_rad',
  'world_position_m',
  'world_angular_rad',
]
const metrics = Object.fromEntries(fields.map((field) => {
  const values = measurements.map((measurement) => measurement[field])
  const max = Math.max(...values)
  const worst = measurements[values.indexOf(max)]
  return [field, {
    max,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    worst_frame: worst.frame,
    worst_semantic: worst.semantic,
  }]
}))
const tolerance = {
  position_m: 1e-6,
  angular_rad: 1e-6,
}
const passed = (
  metrics.local_position_m.max <= tolerance.position_m
  && metrics.world_position_m.max <= tolerance.position_m
  && metrics.local_angular_rad.max <= tolerance.angular_rad
  && metrics.world_angular_rad.max <= tolerance.angular_rad
)
const comparison = {
  schema: 'soma.profile-hardcoded-comparison',
  schema_version: '1.0.0',
  passed,
  migration_authorized: false,
  reason: passed
    ? 'numeric equivalence passed; migration still requires explicit authorization'
    : 'profile consumer does not yet reproduce the hardcoded Tai baseline',
  profile_result_signature: profileEvidence.result_signature,
  hardcoded_result_signature: hardcoded.result_signature,
  frames: [...new Set(measurements.map((measurement) => measurement.frame))],
  driven_bones: new Set(measurements.map((measurement) => measurement.semantic)).size,
  tolerance,
  metrics,
}
comparison.comparison_signature = await contractSignature(comparison)
await writeFile(outputArg, `${JSON.stringify(comparison, null, 2)}\n`)
console.log(
  `${passed ? 'PASS' : 'EXPECTED GAP'} ${outputArg}: `
  + `local_pos=${metrics.local_position_m.max} m, `
  + `local_angle=${metrics.local_angular_rad.max} rad, `
  + `world_pos=${metrics.world_position_m.max} m`,
)
