import { Quaternion, Vector3 } from 'three'

import {
  CONTRACT_SCHEMAS,
  CONTRACT_VERSION,
  assertAvatarRigIR,
  canonicalize,
  contractSignature,
} from '../core/contracts.js?v=10'

function canonicalQuaternion(quaternion) {
  const q = quaternion.clone().normalize()
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
  return [q.x, q.y, q.z, q.w].map((value) => (Object.is(value, -0) ? 0 : value))
}

function vectorArray(vector) {
  return [vector.x, vector.y, vector.z].map((value) => (Object.is(value, -0) ? 0 : value))
}

function nodeSegment(node) {
  const name = node.name || node.type || 'Object3D'
  if (!node.parent) return `${encodeURIComponent(name)}[0]`
  const peers = node.parent.children.filter(
    (candidate) => (candidate.name || candidate.type || 'Object3D') === name,
  )
  return `${encodeURIComponent(name)}[${peers.indexOf(node)}]`
}

export function stableNodeId(root, node) {
  const segments = []
  let cursor = node
  while (cursor) {
    segments.push(nodeSegment(cursor))
    if (cursor === root) return `three:/${segments.reverse().join('/')}`
    cursor = cursor.parent
  }
  throw new Error(`bone "${node.name || node.type}" is not descended from the supplied root`)
}

export function indexThreeRigObjects(root, avatarRig) {
  const expected = new Set(avatarRig.bones.map((bone) => bone.id))
  const indexed = new Map()
  root.traverse((node) => {
    const id = stableNodeId(root, node)
    if (expected.has(id)) indexed.set(id, node)
  })
  if (indexed.size !== expected.size) {
    throw new Error(`avatar object resolves ${indexed.size} of ${expected.size} profile bones`)
  }
  return indexed
}

function collectBoneNodes(root) {
  const bones = []
  root.traverse((node) => {
    if (node.isBone) bones.push(node)
  })
  return bones
}

function nearestIncludedParent(node, included) {
  let cursor = node.parent
  while (cursor) {
    if (included.has(cursor)) return cursor
    cursor = cursor.parent
  }
  return null
}

function snapshot(node) {
  const worldPosition = node.getWorldPosition(new Vector3())
  const worldQuaternion = node.getWorldQuaternion(new Quaternion())
  const worldScale = node.getWorldScale(new Vector3())
  return {
    rest_local: {
      position: vectorArray(node.position),
      quaternion: canonicalQuaternion(node.quaternion),
      scale: vectorArray(node.scale),
    },
    rest_world: {
      position: vectorArray(worldPosition),
      quaternion: canonicalQuaternion(worldQuaternion),
      scale: vectorArray(worldScale),
    },
  }
}

export async function extractThreeAvatarRig({
  root,
  format,
  formatVersion,
  assetSignature,
  importer,
  importerVersion,
  rigSpace,
  basisCorrection,
  coordinateSystem,
  semanticBones = {},
  bones = null,
  rigId = null,
}) {
  if (!root?.traverse || !root?.updateMatrixWorld) {
    throw new TypeError('root must be a Three.js Object3D')
  }
  if (!coordinateSystem || typeof coordinateSystem !== 'object') {
    throw new TypeError('coordinateSystem must be declared by the import adapter')
  }
  if (!['declared', 'unresolved'].includes(coordinateSystem.status)) {
    throw new TypeError('coordinateSystem.status must be "declared" or "unresolved"')
  }
  if (!['raw', 'normalized'].includes(rigSpace)) {
    throw new TypeError('rigSpace must be declared as "raw" or "normalized"')
  }
  if (typeof basisCorrection !== 'string' || basisCorrection.length === 0) {
    throw new TypeError('basisCorrection must be declared by the import adapter')
  }

  root.updateMatrixWorld(true)
  const requested = bones ? [...bones] : collectBoneNodes(root)
  for (const node of Object.values(semanticBones)) {
    if (node && !requested.includes(node)) requested.push(node)
  }
  if (requested.length === 0) throw new Error('avatar rig contains no importable bones')

  const requestedSet = new Set(requested)
  const semanticByNode = new Map()
  for (const [semantic, node] of Object.entries(semanticBones)) {
    if (!node) continue
    if (semanticByNode.has(node)) {
      throw new Error(`bone "${node.name}" has more than one semantic assignment`)
    }
    semanticByNode.set(node, semantic)
  }

  const ordered = []
  root.traverse((node) => {
    if (requestedSet.has(node)) ordered.push(node)
  })
  if (ordered.length !== requestedSet.size) {
    throw new Error('one or more supplied bones are not descended from root')
  }

  const idByNode = new Map(ordered.map((node) => [node, stableNodeId(root, node)]))
  const rig = {
    schema: CONTRACT_SCHEMAS.avatarRig,
    schema_version: CONTRACT_VERSION,
    rig_id: rigId ?? `${format}:${root.name || 'avatar'}`,
    rig_signature: 'pending',
    source: {
      format,
      format_version: formatVersion,
      asset_signature: assetSignature,
      importer,
      importer_version: importerVersion,
      rig_space: rigSpace,
      basis_correction: basisCorrection,
    },
    coordinate_system: structuredClone(coordinateSystem),
    bones: ordered.map((node) => {
      const parent = nearestIncludedParent(node, requestedSet)
      return {
        id: idByNode.get(node),
        name: node.name || node.type,
        parent_id: parent ? idByNode.get(parent) : null,
        semantic: semanticByNode.get(node) ?? null,
        ...snapshot(node),
      }
    }),
  }
  const signatureInput = canonicalize({ ...rig, rig_signature: null })
  rig.rig_signature = await contractSignature(signatureInput)
  return assertAvatarRigIR(rig)
}
