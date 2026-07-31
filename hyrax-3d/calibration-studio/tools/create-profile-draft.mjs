#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  contractSignature,
  createCalibrationProfileDraft,
} from '../core/contracts.js'
import { mappingCoverage } from '../core/authoring.js'

function usage() {
  console.error(
    'usage: create-profile-draft.mjs <soma-contract.json> <avatar-rig.json> '
    + '<mapping.json> <output.json> [profile-id]',
  )
}

const [, , contractArg, rigArg, mappingArg, outputArg, profileIdArg] = process.argv
if (!contractArg || !rigArg || !mappingArg || !outputArg) {
  usage()
  process.exit(2)
}

const [somaContract, avatarRig, mappingInput] = await Promise.all(
  [contractArg, rigArg, mappingArg].map(async (file) => (
    JSON.parse(await readFile(path.resolve(file), 'utf8'))
  )),
)
const bySemantic = new Map(
  avatarRig.bones
    .filter((bone) => bone.semantic)
    .map((bone) => [bone.semantic, bone]),
)
const semanticById = new Map(
  avatarRig.bones
    .filter((bone) => bone.semantic)
    .map((bone) => [bone.id, bone.semantic]),
)
const mappingEntries = Array.isArray(mappingInput.mapping)
  ? mappingInput.mapping
  : mappingInput.roles.map((role) => ({
    semantic: role.semantic,
    soma_joint: role.soma_joint,
    target_semantic: role.semantic,
  }))
const mapping = mappingEntries.map((entry) => {
  const target = bySemantic.get(entry.target_semantic)
  if (!target) throw new Error(`avatar rig has no "${entry.target_semantic}" semantic bone`)
  return {
    semantic: entry.semantic,
    soma_joint: entry.soma_joint,
    target_bone_id: target.id,
    target_parent_semantic: target.parent_id
      ? (semanticById.get(target.parent_id) ?? null)
      : null,
  }
})

const draft = createCalibrationProfileDraft({
  profileId: profileIdArg ?? `${avatarRig.rig_id}:draft`,
  somaContract: {
    ...somaContract,
    signature: await contractSignature(somaContract),
  },
  avatarRig,
  mapping,
})
draft.authoring = {
  ...(mappingInput.roles
    ? {
      created_by: 'SOMA Avatar Calibration Studio toolchain',
      mapping_mode: 'standardized-vrm',
      mapping_catalog: {
        id: mappingInput.id,
        version: mappingInput.version,
        signature: await contractSignature(mappingInput),
      },
      coverage: mappingCoverage(mappingInput, mapping),
    }
    : { mapping_provenance: mappingInput.provenance }),
}

await writeFile(path.resolve(outputArg), `${JSON.stringify(draft, null, 2)}\n`)
console.log(`wrote ${path.resolve(outputArg)}: ${mapping.length} mappings, status=${draft.status}`)
