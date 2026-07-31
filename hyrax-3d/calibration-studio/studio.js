import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

import {
  assertCalibrationProfile,
  contractSignature,
  createCalibrationProfileDraft,
} from './core/contracts.js?v=10'
import {
  calibrateRoot,
  calibrateScale,
  calibrationReadiness,
  captureRestCalibration,
  configureFootGroundIk,
  setBoneUserOffset,
} from './core/calibration.js?v=10'
import {
  adaptMotionJson,
} from './adapters/soma-motion-json.js?v=9'
import {
  extractThreeAvatarRig,
  indexThreeRigObjects,
} from './adapters/three-avatar-rig.js?v=6'
import {
  inspectThreeFbxAvatarRig,
  normalizeAndExtractThreeFbxAvatarRig,
} from './adapters/three-fbx-avatar-rig.js?v=3'
import {
  extractThreeVrmAvatarRigVariants,
} from './adapters/three-vrm-avatar-rig.js?v=7'
import {
  mappingCoverage,
  mirrorLocalOffset,
  somaWorldPositions,
} from './core/authoring.js?v=1'
import { autoTuneReferencePose } from './core/auto-tune.js?v=4'
import {
  applyPoseToThreeObject,
  createRetargetSession,
  solveRetargetFrame,
} from './core/retarget.js?v=9'
import {
  promoteValidatedProfile,
  validateCalibration,
  verifyValidatedProfile,
} from './core/validation.js?v=10'
import { sha256Signature } from './core/sha256.js?v=1'
import {
  SomaVrmRetargeter,
} from '../REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js'

const $ = (id) => document.getElementById(id)
const SAMPLE_TAI_URL = '/api/hyrax/assets/tai.embodiment.vrm'
const SAMPLE_KIMODO_URL = 'evidence/kimodo-150.soma77.json'
const QUALIFICATION_TURN_URLS = [
  '../debug/data/capture-turn-chunk_000.json',
  '../debug/data/capture-turn-chunk_001.json',
  '../debug/data/capture-turn-chunk_002.json',
]

const state = {
  somaContract: null,
  somaSignature: null,
  roleCatalog: null,
  roleCatalogSignature: null,
  rig: null,
  rigVariants: [],
  draft: null,
  motion: null,
  qualificationMotion: null,
  validationEvidence: null,
  avatarObject: null,
  objectByRigId: null,
  mappingSelections: new Map(),
  selectedBoneId: null,
  pendingFbx: null,
  avatarPoseCommit: () => {},
  playbackTimer: null,
  activeMappingSemantic: null,
  activeOffsetSemantic: null,
  offsetHistory: [],
  offsetHistoryIndex: -1,
  offsetPreviewProfile: null,
  autoTuneCandidate: null,
  autoTuneBaseline: null,
  gizmoStart: null,
  avatarHeight: 1.7,
  targetHomePosition: new THREE.Vector3(),
  legacyReference: null,
  legacyReferencePromise: null,
  activeStage: 'import',
}

const viewport = $('viewport')
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a0d11)
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
camera.position.set(1.8, 1.25, 2.7)
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
viewport.appendChild(renderer.domElement)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.95, 0)
controls.enableDamping = true
const offsetPivot = new THREE.Object3D()
scene.add(offsetPivot)
const rotationControls = new TransformControls(camera, renderer.domElement)
rotationControls.setMode('rotate')
rotationControls.setSpace('local')
rotationControls.setSize(0.56)
rotationControls.visible = false
scene.add(rotationControls)

scene.add(new THREE.HemisphereLight(0xdce8f5, 0x26313d, 1.3))
const keyLight = new THREE.DirectionalLight(0xffffff, 1.8)
keyLight.position.set(2.5, 4, 3)
scene.add(keyLight)
scene.add(new THREE.GridHelper(6, 20, 0x36414d, 0x1c242d))
const viewRoot = new THREE.Group()
scene.add(viewRoot)
const somaReferenceGroup = new THREE.Group()
somaReferenceGroup.visible = false
scene.add(somaReferenceGroup)
const somaReferencePoints = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({
    color: 0xd4a657,
    size: 0.022,
    sizeAttenuation: true,
    depthTest: false,
  }),
)
somaReferencePoints.renderOrder = 80
const somaReferenceLines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({
    color: 0x88a6c2,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
  }),
)
somaReferenceLines.renderOrder = 79
somaReferenceGroup.add(somaReferenceLines, somaReferencePoints)
const legacyReferenceRoot = new THREE.Group()
legacyReferenceRoot.visible = false
scene.add(legacyReferenceRoot)
const selectedMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.025, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0x67a7e8 }),
)
selectedMarker.visible = false
scene.add(selectedMarker)
const boneMarkerGroup = new THREE.Group()
boneMarkerGroup.visible = false
scene.add(boneMarkerGroup)
const boneMarkers = new Map()
const markerObjects = []
let boneMarkerScale = 0.018
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let pointerDownPosition = null

const resizeObserver = new ResizeObserver(() => {
  const width = Math.max(1, viewport.clientWidth)
  const height = Math.max(1, viewport.clientHeight)
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  layoutReferenceScene()
  syncOffsetGizmo()
})
resizeObserver.observe(viewport)

function animate() {
  updateBoneMarkerPositions()
  controls.update()
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
animate()

function setStatus(message) {
  $('globalStatus').textContent = message
}

function setImportStatus(message, kind = 'idle') {
  $('importStatus').textContent = message
  $('importStatus').dataset.state = kind
  setStatus(message)
}

function setStage(name) {
  state.activeStage = name
  document.querySelectorAll('.stage-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.stage === name)
  })
  document.querySelectorAll('.stage-panel').forEach((panel) => {
    const active = panel.dataset.panel === name
    panel.hidden = !active
    panel.classList.toggle('is-active', active)
  })
  updateBoneMarkerVisibility()
  if (name === 'calibrate') syncOffsetGizmo()
  else {
    rotationControls.detach()
    rotationControls.visible = false
  }
}

document.querySelectorAll('.stage-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (!tab.disabled) setStage(tab.dataset.stage)
  })
})

function enableStage(name, enabled = true) {
  const tab = document.querySelector(`.stage-tab[data-stage="${name}"]`)
  if (tab) tab.disabled = !enabled
}

function detectVrmVersion(vrm) {
  return String(vrm.meta?.metaVersion ?? 'unknown')
}

async function parseAvatar(bytes, baseUrl, filename) {
  const assetSignature = await sha256Signature(bytes)
  if (filename.toLowerCase().endsWith('.fbx')) {
    const object = new FBXLoader().parse(bytes, baseUrl)
    const rig = await inspectThreeFbxAvatarRig({
      object,
      assetSignature,
      filename,
      importerVersion: THREE.REVISION,
    })
    const metadataScale = [
      object.userData?.UnitScaleFactor,
      object.userData?.unitScaleFactor,
      object.userData?.unitScaleFactorCm,
    ].find((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    return {
      object,
      rig,
      label: `${filename} · FBX · basis unresolved`,
      pendingFbx: {
        object,
        assetSignature,
        filename,
        importerVersion: THREE.REVISION,
        metadataScale: metadataScale == null ? null : Number(metadataScale),
      },
    }
  }

  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.parseAsync(bytes, baseUrl)
  const vrm = gltf.userData.vrm ?? null

  if (vrm) {
    const version = detectVrmVersion(vrm)
    let basisCorrection = 'none'
    if (version === '0') {
      VRMUtils.rotateVRM0(vrm)
      basisCorrection = 'VRMUtils.rotateVRM0(scene-yaw-180)'
    }
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
        forward_axis: version === '0' ? '-Z-scene-local-after-normalization' : '+Z',
        linear_unit: 'meter',
      },
      rigId: `vrm:${filename}:${assetSignature.slice(7, 19)}`,
      detailedSemanticNames: state.roleCatalog.roles.map((role) => role.semantic),
    })
    return {
      object: vrm.scene,
      rig: variants.detailed,
      rigVariants: [variants.detailed, variants.core],
      vrm,
      label: `${filename} · VRM ${version} · ${variants.detailed.bones.length} humanoid controls`,
      commitPose: () => vrm.humanoid.update(),
    }
  }

  const rig = await extractThreeAvatarRig({
    root: gltf.scene,
    format: 'glb',
    formatVersion: '2.0',
    assetSignature,
    importer: 'three/GLTFLoader',
    importerVersion: THREE.REVISION,
    rigSpace: 'raw',
    basisCorrection: 'none',
    coordinateSystem: {
      status: 'declared',
      handedness: 'right',
      up_axis: '+Y',
      forward_axis: '+Z',
      linear_unit: 'meter',
    },
    rigId: `glb:${filename}:${assetSignature.slice(7, 19)}`,
  })
  return { object: gltf.scene, rig, rigVariants: [rig], label: `${filename} · GLB` }
}

function frameAvatar(object) {
  viewRoot.clear()
  viewRoot.position.set(0, 0, 0)
  viewRoot.add(object)
  object.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) {
    object.traverse((node) => {
      if (node.isBone) box.expandByPoint(node.getWorldPosition(new THREE.Vector3()))
    })
  }
  if (box.isEmpty()) box.expandByPoint(object.getWorldPosition(new THREE.Vector3()))
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  viewRoot.position.set(-center.x, -box.min.y, -center.z)
  const height = Math.max(size.y, 0.5)
  state.avatarHeight = height
  state.targetHomePosition.copy(viewRoot.position)
  boneMarkerScale = Math.max(0.008, height * 0.012)
  controls.target.set(0, height * 0.52, 0)
  camera.position.set(height * 0.9, height * 0.63, height * 1.35)
  camera.near = Math.max(0.001, height / 500)
  camera.far = Math.max(50, height * 20)
  camera.updateProjectionMatrix()
  controls.update()
  layoutReferenceScene({ reframe: true })
}

function referenceSelection() {
  const requestedMode = $('referenceMode')?.value ?? 'soma'
  const narrow = matchMedia('(max-width: 760px)').matches
  return {
    mode: narrow && requestedMode === 'both' ? 'soma' : requestedMode,
    requestedMode,
    layout: $('referenceLayout')?.value ?? 'side-by-side',
    narrow,
  }
}

function referenceReadiness() {
  return Boolean(
    state.draft
    && state.motion
    && calibrationReadiness(state.draft).ready_for_validation,
  )
}

function styleLegacyReference(overlay) {
  const object = state.legacyReference?.vrm.scene
  if (!object) return
  object.traverse((node) => {
    if (!node.isMesh || !node.material) return
    if (!node.userData.somaReferenceMaterials) {
      const source = Array.isArray(node.material) ? node.material : [node.material]
      node.userData.somaReferenceMaterials = source.map((material) => material.clone())
      node.material = Array.isArray(node.material)
        ? node.userData.somaReferenceMaterials
        : node.userData.somaReferenceMaterials[0]
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    materials.forEach((material) => {
      material.transparent = overlay
      material.opacity = overlay ? 0.28 : 1
      material.depthWrite = !overlay
      material.needsUpdate = true
    })
  })
}

function layoutReferenceScene({ reframe = false } = {}) {
  if (!state.avatarObject) return
  const selection = referenceSelection()
  const overlay = selection.layout === 'overlay' && referenceReadiness()
  const wantsSoma = ['soma', 'both'].includes(selection.mode) && Boolean(state.motion)
  const wantsLegacy = ['legacy', 'both'].includes(selection.mode)
    && Boolean(state.legacyReference)
  somaReferenceGroup.visible = wantsSoma
  legacyReferenceRoot.visible = wantsLegacy
  viewRoot.position.copy(state.targetHomePosition)
  const lane = selection.narrow
    ? Math.max(0.62, state.avatarHeight * 0.48)
    : Math.max(0.8, state.avatarHeight * 0.65)

  if (!overlay) {
    if (wantsSoma && wantsLegacy) {
      somaReferenceGroup.userData.laneX = -lane * 1.25
      legacyReferenceRoot.position.set(lane * 1.25, 0, 0)
    } else if (wantsSoma) {
      somaReferenceGroup.userData.laneX = -lane * 0.72
      viewRoot.position.x += lane * 0.72
    } else if (wantsLegacy) {
      viewRoot.position.x -= lane * 0.72
      legacyReferenceRoot.position.set(lane * 0.72, 0, 0)
    }
  } else {
    somaReferenceGroup.userData.laneX = 0
    legacyReferenceRoot.position.set(0, 0, 0)
  }

  styleLegacyReference(overlay)
  const widthFactor = selection.narrow && !overlay && (wantsSoma || wantsLegacy)
    ? 2.45
    : (!overlay && wantsSoma && wantsLegacy
      ? 2.7
      : (!overlay && (wantsSoma || wantsLegacy) ? 1.95 : 1.35))
  if (reframe) {
    camera.position.z = state.avatarHeight * widthFactor
    camera.updateProjectionMatrix()
  }
  if (selection.narrow && selection.requestedMode === 'both') {
    $('referenceStatus').textContent =
      'Narrow view shows SOMA; choose Legacy Tai explicitly to switch.'
  } else if (selection.layout === 'overlay' && !referenceReadiness()) {
    $('referenceStatus').textContent =
      'Overlay unlocks after rest, root, and scale calibration.'
  } else if (selection.mode === 'soma' && state.motion) {
    $('referenceStatus').textContent = 'Canonical SOMA77 · all 77 source joints.'
  } else if (selection.mode === 'legacy' && state.legacyReference) {
    $('referenceStatus').textContent = 'Legacy Tai oracle · 22 body controls.'
  } else if (selection.mode === 'both' && state.legacyReference) {
    $('referenceStatus').textContent =
      'SOMA77 source truth + Legacy Tai 22-body oracle.'
  }
}

function updateSomaReference(frame) {
  if (!state.motion || !somaReferenceGroup.visible) return
  const overlay = referenceSelection().layout === 'overlay' && referenceReadiness()
  let positions
  if (overlay) {
    const hipsId = state.mappingSelections.get('hips')
    const hipsObject = state.objectByRigId?.get(hipsId)
    const anchor = hipsObject
      ? hipsObject.getWorldPosition(new THREE.Vector3()).toArray()
      : [0, 0, 0]
    positions = somaWorldPositions(state.motion, frame, {
      scale: state.draft.scale_calibration.translation_scale,
      rootAnchor: anchor,
    })
  } else {
    positions = somaWorldPositions(state.motion, frame)
    const root = positions[0]
    const laneX = somaReferenceGroup.userData.laneX ?? 0
    positions = positions.map((position) => [
      position[0] - root[0] + laneX,
      position[1],
      position[2] - root[2],
    ])
  }

  somaReferencePoints.geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions.flat(), 3),
  )
  const indexByName = new Map(
    state.motion.joints.map((name, index) => [name, index]),
  )
  const segments = []
  state.motion.parents.forEach((parent, index) => {
    if (parent === null) return
    segments.push(...positions[indexByName.get(parent)], ...positions[index])
  })
  somaReferenceLines.geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(segments, 3),
  )
  somaReferencePoints.geometry.computeBoundingSphere()
  somaReferenceLines.geometry.computeBoundingSphere()
}

async function loadLegacyReference() {
  if (state.legacyReference) return state.legacyReference
  if (state.legacyReferencePromise) return state.legacyReferencePromise
  $('referenceStatus').textContent = 'Loading frozen Legacy Tai oracle…'
  state.legacyReferencePromise = (async () => {
    const response = await fetch(SAMPLE_TAI_URL)
    if (!response.ok) throw new Error(`Legacy Tai HTTP ${response.status}`)
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.parseAsync(await response.arrayBuffer(), SAMPLE_TAI_URL)
    const vrm = gltf.userData.vrm
    if (!vrm) throw new Error('Legacy Tai reference is not a VRM')
    if (detectVrmVersion(vrm) === '0') VRMUtils.rotateVRM0(vrm)
    legacyReferenceRoot.clear()
    legacyReferenceRoot.add(vrm.scene)
    vrm.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(vrm.scene)
    const center = box.getCenter(new THREE.Vector3())
    vrm.scene.position.set(-center.x, -box.min.y, -center.z)
    vrm.scene.updateMatrixWorld(true)
    state.legacyReference = {
      vrm,
      retargeter: null,
      motionSignature: null,
      lastFrame: -1,
    }
    $('referenceStatus').textContent = 'Legacy Tai oracle ready · 22 body controls.'
    return state.legacyReference
  })()
  try {
    return await state.legacyReferencePromise
  } finally {
    state.legacyReferencePromise = null
  }
}

function updateLegacyReference(frame) {
  const reference = state.legacyReference
  if (!reference || !state.motion || !legacyReferenceRoot.visible) return
  if (reference.motionSignature !== state.motion.motion_signature) {
    reference.retargeter = new SomaVrmRetargeter(
      reference.vrm,
      { ...state.motion, skeleton: 'soma77' },
    )
    reference.motionSignature = state.motion.motion_signature
    reference.lastFrame = -1
  }
  if (frame !== reference.lastFrame + 1) {
    reference.retargeter.onReset()
    reference.lastFrame = -1
  }
  for (let current = reference.lastFrame + 1; current <= frame; current += 1) {
    reference.retargeter.applyFrame(current)
  }
  reference.lastFrame = frame

  if (referenceSelection().layout === 'overlay' && referenceReadiness()) {
    legacyReferenceRoot.position.set(0, 0, 0)
    reference.vrm.scene.updateMatrixWorld(true)
    const legacyHips = reference.vrm.humanoid.getNormalizedBoneNode('hips')
      .getWorldPosition(new THREE.Vector3())
    const targetHips = state.objectByRigId
      .get(state.mappingSelections.get('hips'))
      .getWorldPosition(new THREE.Vector3())
    legacyReferenceRoot.position.copy(targetHips.sub(legacyHips))
  }
}

function updateReferences(frame, { reframe = false } = {}) {
  layoutReferenceScene({ reframe })
  updateSomaReference(frame)
  updateLegacyReference(frame)
}

async function refreshReferenceSelection() {
  const mode = $('referenceMode').value
  if (['legacy', 'both'].includes(mode)) {
    try {
      await loadLegacyReference()
    } catch (error) {
      $('referenceStatus').textContent = `Legacy reference failed: ${error.message}`
      console.error('[SOMA Studio] Legacy Tai reference failed', error)
    }
  }
  const frame = Number.parseInt($('previewFrame').value, 10) || 0
  updateReferences(frame, { reframe: true })
  syncOffsetGizmo()
}

$('referenceMode').addEventListener('change', refreshReferenceSelection)
$('referenceLayout').addEventListener('change', refreshReferenceSelection)

function rebuildBoneMarkers() {
  boneMarkerGroup.clear()
  boneMarkers.clear()
  markerObjects.length = 0
  if (!state.rig || !state.objectByRigId) return
  for (const bone of state.rig.bones) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0x67a7e8,
        depthTest: false,
        transparent: true,
        opacity: 0.88,
      }),
    )
    marker.scale.setScalar(boneMarkerScale)
    marker.renderOrder = 100
    marker.userData.rigBoneId = bone.id
    marker.userData.rigBoneName = bone.name
    boneMarkerGroup.add(marker)
    boneMarkers.set(bone.id, marker)
    markerObjects.push(marker)
  }
  updateBoneMarkerColors()
  updateBoneMarkerVisibility()
}

function updateBoneMarkerPositions() {
  if (!boneMarkerGroup.visible || !state.objectByRigId) return
  for (const [boneId, marker] of boneMarkers) {
    const object = state.objectByRigId.get(boneId)
    if (object) object.getWorldPosition(marker.position)
  }
}

function updateBoneMarkerVisibility() {
  boneMarkerGroup.visible = ['map', 'calibrate'].includes(state.activeStage)
    && Boolean(state.rig)
    && !state.pendingFbx
  if (boneMarkerGroup.visible) {
    const mappedTargets = new Set(state.mappingSelections.values())
    for (const [boneId, marker] of boneMarkers) {
      marker.visible = state.activeStage === 'map' || mappedTargets.has(boneId)
    }
    updateBoneMarkerPositions()
  }
}

function updateBoneMarkerColors() {
  const activeSemantic = state.activeStage === 'calibrate'
    ? state.activeOffsetSemantic
    : state.activeMappingSemantic
  const activeTarget = activeSemantic
    ? state.mappingSelections.get(activeSemantic)
    : null
  for (const [boneId, marker] of boneMarkers) {
    marker.material.color.setHex(boneId === activeTarget ? 0xd4a657 : 0x67a7e8)
    const stageScale = state.activeStage === 'calibrate' ? 0.68 : 1
    marker.scale.setScalar(boneId === activeTarget
      ? boneMarkerScale * stageScale * 1.45
      : boneMarkerScale * stageScale)
  }
}

function setActiveMappingSemantic(semantic) {
  state.activeMappingSemantic = semantic
  document.querySelectorAll('.mapping-row').forEach((row) => {
    row.classList.toggle('is-active', row.dataset.semantic === semantic)
  })
  $('mappingPickStatus').textContent = semantic
    ? `Picking target for ${semantic} · click a blue bone point on the avatar.`
    : 'Select a mapping row, then click a bone point on the avatar.'
  updateBoneMarkerColors()
}

function assignMappingTarget(semantic, boneId) {
  const previousTarget = state.mappingSelections.get(semantic) ?? null
  const conflictingSemantic = [...state.mappingSelections.entries()].find(
    ([candidateSemantic, candidateBoneId]) => (
      candidateSemantic !== semantic && candidateBoneId === boneId
    ),
  )?.[0] ?? null
  if (conflictingSemantic) {
    if (previousTarget) state.mappingSelections.set(conflictingSemantic, previousTarget)
    else state.mappingSelections.delete(conflictingSemantic)
  }
  state.mappingSelections.set(semantic, boneId)
  return conflictingSemantic
}

function markerIntersection(event) {
  const bounds = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  return raycaster.intersectObjects(markerObjects, false)[0] ?? null
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownPosition = { x: event.clientX, y: event.clientY }
})

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!boneMarkerGroup.visible) {
    renderer.domElement.style.cursor = ''
    return
  }
  const intersection = markerIntersection(event)
  renderer.domElement.style.cursor = intersection ? 'crosshair' : ''
  if (state.activeStage === 'map' && intersection && state.activeMappingSemantic) {
    $('mappingPickStatus').textContent =
      `${state.activeMappingSemantic} → ${intersection.object.userData.rigBoneName}`
  } else if (state.activeStage === 'map' && state.activeMappingSemantic) {
    $('mappingPickStatus').textContent =
      `Picking target for ${state.activeMappingSemantic} · click a blue bone point on the avatar.`
  }
})

renderer.domElement.addEventListener('pointerup', (event) => {
  if (!boneMarkerGroup.visible || rotationControls.dragging) return
  if (pointerDownPosition
      && Math.hypot(
        event.clientX - pointerDownPosition.x,
        event.clientY - pointerDownPosition.y,
      ) > 4) {
    return
  }
  const intersection = markerIntersection(event)
  if (!intersection) return
  const boneId = intersection.object.userData.rigBoneId
  if (state.activeStage === 'calibrate') {
    const semantic = [...state.mappingSelections.entries()].find(
      ([, targetId]) => targetId === boneId,
    )?.[0]
    if (semantic) selectOffsetSemantic(semantic)
    return
  }
  if (!state.activeMappingSemantic) return
  const semantic = state.activeMappingSemantic
  const swappedSemantic = assignMappingTarget(semantic, boneId)
  rebuildDraft()
  renderMappingEditor()
  setActiveMappingSemantic(semantic)
  const bone = state.rig.bones.find((candidate) => candidate.id === boneId)
  setStatus(swappedSemantic
    ? `Swapped ${semantic} with ${swappedSemantic} on ${bone?.name ?? boneId}`
    : `Mapped ${semantic} to ${bone?.name ?? boneId} from the avatar`)
})

async function importBytes(bytes, baseUrl, filename) {
  stopPlayback()
  setImportStatus(`Importing ${filename}…`, 'working')
  try {
    const result = await parseAvatar(bytes, baseUrl, filename)
    state.rig = result.rig
    state.rigVariants = result.rigVariants ?? [result.rig]
    state.avatarObject = result.object
    state.avatarPoseCommit = result.commitPose ?? (() => {})
    state.draft = null
    state.validationEvidence = null
    state.pendingFbx = result.pendingFbx ?? null
    state.mappingSelections.clear()
    state.activeOffsetSemantic = null
    state.offsetHistory = []
    state.offsetHistoryIndex = -1
    state.offsetPreviewProfile = null
    clearAutoTuneSession()
    frameAvatar(result.object)
    state.objectByRigId = indexThreeRigObjects(result.object, result.rig)
    rebuildBoneMarkers()
    renderRig()
    enableStage('inspect')
    enableStage('validate', false)
    renderCalibrationProgress()
    const basisGate = $('fbxBasisGate')
    basisGate.hidden = !state.pendingFbx
    if (state.pendingFbx) {
      $('fbxUnitScale').value = state.pendingFbx.metadataScale ?? ''
      $('fbxFacing').value = ''
      $('fbxBasisStatus').textContent = state.pendingFbx.metadataScale == null
        ? 'No trusted UnitScaleFactor was exposed; enter it from the authoring/export settings.'
        : `Importer exposed UnitScaleFactor ${state.pendingFbx.metadataScale}; confirm it and facing.`
      $('fbxBasisStatus').dataset.state = 'idle'
      enableStage('map', false)
      enableStage('calibrate', false)
      state.draft = null
      renderMappingEditor()
      renderMappingProgress()
    } else {
      seedSemanticMappings()
      renderMappingEditor()
      enableStage('map')
      renderMappingProgress()
    }
    $('avatarBadge').textContent = result.label
    $('rigBadge').textContent = `${result.rig.bones.length} bones · ${result.rig.rig_signature.slice(7, 15)}`
    setImportStatus(state.pendingFbx
      ? `Inspected ${result.rig.bones.length} FBX bones; coordinate declaration is required.`
      : `Imported ${result.rig.bones.length} bones. Rig signature ${result.rig.rig_signature.slice(0, 23)}…`,
    state.pendingFbx ? 'working' : 'success')
    setStage('inspect')
  } catch (error) {
    console.error('[SOMA Studio] avatar import failed', error)
    setImportStatus(`Import failed: ${error.message}`, 'error')
  }
}

$('confirmFbxBasisBtn').addEventListener('click', async () => {
  if (!state.pendingFbx) return
  const unitScaleFactor = Number($('fbxUnitScale').value)
  const sourceFacing = $('fbxFacing').value
  $('fbxBasisStatus').textContent = 'Normalizing declared FBX basis…'
  $('fbxBasisStatus').dataset.state = 'working'
  try {
    // View framing is presentation-only and must never enter signed rig rest
    // transforms. Normalize and extract with the imported object detached.
    viewRoot.remove(state.pendingFbx.object)
    state.pendingFbx.object.updateMatrixWorld(true)
    const rig = await normalizeAndExtractThreeFbxAvatarRig({
      ...state.pendingFbx,
      unitScaleFactor,
      sourceFacing,
    })
    state.rig = rig
    state.objectByRigId = indexThreeRigObjects(state.avatarObject, rig)
    state.pendingFbx = null
    state.mappingSelections.clear()
    state.draft = null
    renderRig()
    rebuildBoneMarkers()
    renderMappingEditor()
    renderMappingProgress()
    frameAvatar(state.avatarObject)
    $('fbxBasisGate').hidden = true
    $('avatarBadge').textContent =
      `${rig.rig_id.split(':')[1]} · FBX · normalized`
    $('rigBadge').textContent = `${rig.bones.length} bones · ${rig.rig_signature.slice(7, 15)}`
    enableStage('map')
    setImportStatus(
      `FBX normalized to meters and +Z. Map semantic bones manually to continue.`,
      'success',
    )
  } catch (error) {
    if (state.pendingFbx?.object.parent !== viewRoot) frameAvatar(state.pendingFbx.object)
    console.error('[SOMA Studio] FBX basis declaration failed', error)
    $('fbxBasisStatus').textContent = `Declaration rejected: ${error.message}`
    $('fbxBasisStatus').dataset.state = 'error'
  }
})

async function loadTaiSample() {
  setImportStatus('Fetching the Tai reference avatar…', 'working')
  try {
    const response = await fetch(SAMPLE_TAI_URL)
    if (!response.ok) throw new Error(`Tai sample HTTP ${response.status}`)
    await importBytes(await response.arrayBuffer(), SAMPLE_TAI_URL, 'tai.embodiment.vrm')
  } catch (error) {
    console.error('[SOMA Studio] Tai sample failed', error)
    setImportStatus(`Tai sample failed: ${error.message}`, 'error')
  }
}

async function importFile(file) {
  if (!file) return
  await importBytes(await file.arrayBuffer(), '', file.name)
}

$('loadTaiBtn').addEventListener('click', loadTaiSample)
$('panelLoadTaiBtn').addEventListener('click', loadTaiSample)
$('avatarFile').addEventListener('change', (event) => importFile(event.target.files[0]))
$('panelAvatarFile').addEventListener('change', (event) => importFile(event.target.files[0]))

function addSummaryCell(container, label, value) {
  const cell = document.createElement('div')
  cell.className = 'summary-cell'
  const caption = document.createElement('span')
  caption.textContent = label
  const content = document.createElement('strong')
  content.textContent = value
  content.title = value
  cell.append(caption, content)
  container.append(cell)
}

function boneDepth(bone, byId) {
  let depth = 0
  let cursor = bone
  const visited = new Set()
  while (cursor.parent_id && !visited.has(cursor.parent_id)) {
    visited.add(cursor.parent_id)
    cursor = byId.get(cursor.parent_id)
    if (!cursor) break
    depth += 1
  }
  return depth
}

function renderRig() {
  const rig = state.rig
  if (!rig) return
  const summary = $('rigSummary')
  summary.replaceChildren()
  addSummaryCell(summary, 'Format', `${rig.source.format.toUpperCase()} ${rig.source.format_version}`)
  addSummaryCell(summary, 'Rig space', rig.source.rig_space)
  addSummaryCell(summary, 'Bones', String(rig.bones.length))
  addSummaryCell(
    summary,
    'Facing',
    rig.coordinate_system.status === 'declared'
      ? rig.coordinate_system.forward_axis
      : 'Unresolved',
  )

  const tree = $('boneTree')
  tree.replaceChildren()
  const byId = new Map(rig.bones.map((bone) => [bone.id, bone]))
  rig.bones.forEach((bone) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `bone-row${bone.semantic ? ' is-semantic' : ''}`
    button.style.paddingLeft = `${6 + boneDepth(bone, byId) * 10}px`
    button.textContent = bone.semantic ? `${bone.semantic} · ${bone.name}` : bone.name
    button.title = bone.id
    button.addEventListener('click', () => selectBone(bone.id))
    tree.append(button)
  })
  if (rig.bones.length > 0) selectBone(rig.bones[0].id)
}

function selectBone(boneId) {
  state.selectedBoneId = boneId
  const bone = state.rig?.bones.find((candidate) => candidate.id === boneId)
  if (!bone) return
  document.querySelectorAll('.bone-row').forEach((row) => {
    row.classList.toggle('is-selected', row.title === boneId)
  })
  $('boneTransform').textContent = JSON.stringify({
    id: bone.id,
    name: bone.name,
    semantic: bone.semantic,
    parent_id: bone.parent_id,
    rest_local: bone.rest_local,
    rest_world: bone.rest_world,
  }, null, 2)
  const p = bone.rest_world.position
  selectedMarker.position.set(
    p[0] + viewRoot.position.x,
    p[1] + viewRoot.position.y,
    p[2] + viewRoot.position.z,
  )
  selectedMarker.visible = true
}

function authoringRoles() {
  return state.roleCatalog?.roles ?? []
}

function roleForSemantic(semantic) {
  return authoringRoles().find((role) => role.semantic === semantic) ?? null
}

function seedSemanticMappings() {
  for (const role of authoringRoles()) {
    const target = state.rig.bones.find((bone) => bone.semantic === role.semantic)
    if (target) state.mappingSelections.set(role.semantic, target.id)
  }
  rebuildDraft()
}

function renderMappingEditor() {
  const editor = $('mappingEditor')
  editor.replaceChildren()
  if (!state.rig || !state.somaContract) return
  const emptyOption = document.createElement('option')
  emptyOption.value = ''
  emptyOption.textContent = 'Unmapped'

  for (const group of state.roleCatalog.groups) {
    const section = document.createElement('section')
    section.className = 'mapping-group'
    section.dataset.group = group.id
    const heading = document.createElement('h2')
    const roles = authoringRoles().filter((role) => role.group === group.id)
    const mappedCount = roles.filter(
      (role) => state.mappingSelections.has(role.semantic),
    ).length
    heading.textContent = `${group.label} · ${mappedCount}/${roles.length}`
    section.append(heading)
    for (const role of roles) {
      const { semantic, soma_joint: somaJoint } = role
      const row = document.createElement('div')
      row.className = 'mapping-row'
      row.dataset.semantic = semantic
      row.tabIndex = 0
      const semanticLabel = document.createElement('span')
      semanticLabel.className = 'mapping-semantic'
      semanticLabel.textContent = semantic
      const sourceLabel = document.createElement('span')
      sourceLabel.className = 'mapping-source'
      sourceLabel.textContent = somaJoint
      const select = document.createElement('select')
      select.setAttribute('aria-label', `${semantic} target bone`)
      select.append(emptyOption.cloneNode(true))
      state.rig.bones.forEach((bone) => {
        const option = document.createElement('option')
        option.value = bone.id
        option.textContent = bone.semantic
          ? `${bone.semantic} · ${bone.name}`
          : bone.name
        select.append(option)
      })
      select.value = state.mappingSelections.get(semantic) ?? ''
      select.addEventListener('change', () => {
        const selectedBoneId = select.value
        const swappedSemantic = selectedBoneId
          ? assignMappingTarget(semantic, selectedBoneId)
          : null
        if (!selectedBoneId) state.mappingSelections.delete(semantic)
        rebuildDraft()
        renderMappingEditor()
        setActiveMappingSemantic(semantic)
        if (swappedSemantic) {
          setStatus(`Swapped ${semantic} with ${swappedSemantic}`)
        }
      })
      row.addEventListener('click', () => setActiveMappingSemantic(semantic))
      row.addEventListener('focus', () => setActiveMappingSemantic(semantic))
      row.append(semanticLabel, sourceLabel, select)
      section.append(row)
    }
    editor.append(section)
  }
  const firstSemantic = state.activeMappingSemantic
    ?? authoringRoles()[0]?.semantic
  setActiveMappingSemantic(firstSemantic)
  renderMappingProgress()
}

function currentMapping() {
  const byId = new Map(state.rig.bones.map((bone) => [bone.id, bone]))
  const semanticById = new Map(
    [...state.mappingSelections.entries()].map(
      ([semantic, targetId]) => [targetId, semantic],
    ),
  )
  return [...state.mappingSelections.entries()].map(([semantic, targetId]) => {
    const target = byId.get(targetId)
    let parentId = target?.parent_id ?? null
    while (parentId && !semanticById.has(parentId)) {
      parentId = byId.get(parentId)?.parent_id ?? null
    }
    return {
      semantic,
      soma_joint: roleForSemantic(semantic)?.soma_joint,
      target_bone_id: targetId,
      target_parent_semantic: parentId ? semanticById.get(parentId) : null,
    }
  })
}

function rebuildDraft() {
  state.offsetHistory = []
  state.offsetHistoryIndex = -1
  state.offsetPreviewProfile = null
  clearAutoTuneSession()
  state.gizmoStart = null
  if (!state.rig || state.mappingSelections.size === 0) {
    state.draft = null
    renderMappingProgress()
    return
  }
  try {
    state.draft = createCalibrationProfileDraft({
      profileId: `${state.rig.rig_id}:draft`,
      somaContract: {
        ...state.somaContract,
        signature: state.somaSignature,
      },
      avatarRig: state.rig,
      mapping: currentMapping(),
    })
    state.draft.authoring = {
      created_by: 'SOMA Avatar Calibration Studio',
      mapping_mode: 'semi-manual',
      mapping_catalog: {
        id: state.roleCatalog.id,
        version: state.roleCatalog.version,
        signature: state.roleCatalogSignature,
      },
      coverage: mappingCoverage(state.roleCatalog, state.draft.mapping),
    }
  } catch (error) {
    state.draft = null
    console.error('[SOMA Studio] draft build failed', error)
  }
  renderMappingProgress()
  renderCalibrationProgress()
}

function renderMappingProgress() {
  const total = authoringRoles().length
  const requiredTotal = authoringRoles().filter((role) => role.required).length
  const mapped = state.mappingSelections.size
  const coverage = state.roleCatalog
    ? mappingCoverage(
      state.roleCatalog,
      [...state.mappingSelections.keys()].map((semantic) => ({ semantic })),
    )
    : null
  $('mappingProgress').textContent = `${mapped} of ${total} mapped`
  $('exportDraftBtn').disabled = !state.draft
  if (state.draft && coverage?.core_complete) {
    $('draftStatus').textContent =
      `Core ready · ${mapped}/${total} controls mapped. Rest, root, and scale remain unresolved.`
    $('draftStatus').dataset.state = 'success'
    $('profileStatus').textContent = `Draft · core ready · ${mapped}/${total} mapped`
    enableStage('calibrate')
  } else if (state.draft) {
    $('draftStatus').textContent =
      `Core incomplete · ${coverage.missing_required.length} required controls remain.`
    $('draftStatus').dataset.state = 'idle'
    $('profileStatus').textContent =
      `Draft · core ${requiredTotal - coverage.missing_required.length}/${requiredTotal}`
    enableStage('calibrate', false)
    enableStage('validate', false)
  } else {
    $('draftStatus').textContent =
      `Map the ${requiredTotal} required core roles to begin calibration.`
    $('draftStatus').dataset.state = 'idle'
    $('profileStatus').textContent = 'No draft profile'
    enableStage('calibrate', false)
    enableStage('validate', false)
  }
}

$('clearMappingsBtn').addEventListener('click', () => {
  state.mappingSelections.clear()
  state.draft = null
  renderMappingEditor()
  updateBoneMarkerColors()
})

function renderCalibrationProgress() {
  const summary = $('calibrationSummary')
  if (!summary) return
  const readiness = state.draft
    ? calibrationReadiness(state.draft)
    : { rest: false, root: false, scale: false, ready_for_validation: false }
  const values = [
    readiness.rest ? `${state.draft.mapping.length} bones captured` : 'Unresolved',
    readiness.root ? 'Delta from reference frame' : 'Unresolved',
    readiness.scale
      ? `${state.draft.scale_calibration.translation_scale.toFixed(6)}×`
      : 'Unresolved',
  ]
  ;[...summary.querySelectorAll('strong')].forEach((node, index) => {
    node.textContent = values[index]
  })
  $('captureCalibrationBtn').disabled = !(state.draft && state.motion)
  renderAutoTuneControls(readiness)
  $('togglePlaybackBtn').disabled = !(
    readiness.ready_for_validation && state.motion
  )
  renderIkCalibration(readiness)
  renderOffsetEditor(readiness.rest && !state.autoTuneCandidate)
  $('runValidationBtn').disabled = !(
    readiness.ready_for_validation
    && state.motion
    && state.draft.status !== 'validated'
  )
  enableStage('validate', readiness.ready_for_validation)
  if (readiness.ready_for_validation) {
    $('profileStatus').textContent = state.draft.status === 'validated'
      ? 'Validated profile loaded · runtime eligible'
      : 'Calibrated draft · validation required'
  }
  layoutReferenceScene()
}

function contactStatsForMotion(motion, channel, threshold) {
  const samples = motion?.foot_contacts?.map(
    (contacts) => contacts[channel] > threshold,
  ) ?? []
  let activeFrames = 0
  let transitions = 0
  let longestActiveStreak = 0
  let streak = 0
  samples.forEach((active, index) => {
    if (active) {
      activeFrames += 1
      streak += 1
      longestActiveStreak = Math.max(longestActiveStreak, streak)
    } else {
      streak = 0
    }
    if (index > 0 && active !== samples[index - 1]) transitions += 1
  })
  return {
    frames: samples.length,
    activeFrames,
    transitions,
    longestActiveStreak,
  }
}

function contactChannelStats(channel, threshold) {
  return contactStatsForMotion(state.motion, channel, threshold)
}

function renderIkCalibration(readiness) {
  const fieldset = $('ikCalibration')
  fieldset.disabled = !(readiness.ready_for_validation && state.motion)
  $('enableFootIk').checked = Boolean(state.draft?.ik?.enabled)
  if (fieldset.disabled) {
    $('ikCalibrationStatus').textContent =
      'Capture calibration and load motion to inspect contact quality.'
    $('ikCalibrationStatus').dataset.state = 'idle'
    return
  }
  const threshold = Number($('ikContactThreshold').value)
  const left = contactChannelStats(1, threshold)
  const right = contactChannelStats(3, threshold)
  const lacksRelease = [left, right].some(
    (stats) => stats.frames > 1 && stats.transitions === 0,
  )
  $('ikCalibrationStatus').textContent = lacksRelease
    ? `Contact warning: L ${left.activeFrames}/${left.frames}, R `
      + `${right.activeFrames}/${right.frames} active frames with no `
      + 'acquire/release transition. This clip cannot prove temporal locking.'
    : `Contact coverage: L ${left.activeFrames}/${left.frames}, R `
      + `${right.activeFrames}/${right.frames} active frames · `
      + `${left.transitions + right.transitions} transitions.`
  $('ikCalibrationStatus').dataset.state = lacksRelease ? 'error' : 'success'
}

function mappedRestHeight(semantic) {
  const targetId = state.mappingSelections.get(semantic)
  return state.rig?.bones.find((bone) => bone.id === targetId)
    ?.rest_world.position[1] ?? 0
}

function seedIkCalibrationControls() {
  const left = state.draft?.ik?.targets?.leftFoot
  const right = state.draft?.ik?.targets?.rightFoot
  const ground = left?.ground_y ?? 0
  $('ikGroundY').value = ground.toFixed(4)
  $('ikContactThreshold').value =
    String(left?.contact_threshold ?? 0.5)
  $('ikLeftSoleOffset').value = (
    left?.sole_offset_m ?? mappedRestHeight('leftFoot') - ground
  ).toFixed(4)
  $('ikRightSoleOffset').value = (
    right?.sole_offset_m ?? mappedRestHeight('rightFoot') - ground
  ).toFixed(4)
  $('ikBlendFrames').value = String(left?.lock_blend_frames ?? 4)
  $('ikLockHorizontal').checked = left?.lock_horizontal ?? true
  $('ikLockOrientation').checked = left?.lock_orientation ?? true
  const pelvis = state.draft?.ik?.pelvis_compensation
  $('ikPelvisCompensation').checked = pelvis?.enabled ?? true
  $('ikPelvisMax').value = String(pelvis?.max_lowering_m ?? 0.08)
  $('ikUsePoles').checked = Boolean(
    left?.pole_world_direction ?? !state.draft?.ik?.enabled,
  )
}

function residualAngleDegrees(quaternion) {
  const normalizedW = Math.min(1, Math.abs(
    new THREE.Quaternion().fromArray(quaternion).normalize().w,
  ))
  return THREE.MathUtils.radToDeg(2 * Math.acos(normalizedW))
}

function renderAutoTuneControls(readiness) {
  const enabled = Boolean(readiness.rest && state.motion && state.draft)
  $('autoTuneBtn').disabled = !enabled
  const stored = state.draft?.authoring?.auto_tuning ?? null
  const report = state.autoTuneCandidate?.report ?? stored
  const hasPreview = Boolean(state.autoTuneCandidate)
  const canRevert = hasPreview || Boolean(state.autoTuneBaseline)
  $('acceptAutoTuneBtn').hidden = !hasPreview
  $('revertAutoTuneBtn').hidden = !canRevert
  $('autoTuneActions').hidden = !(hasPreview || canRevert)
  if (!enabled) {
    $('autoTuneStatus').textContent = 'Capture calibration first.'
    $('autoTuneStatus').dataset.state = 'idle'
    return
  }
  if (!report) {
    $('autoTuneStatus').textContent =
      'Ready to calculate editable offsets from the selected SOMA reference frame.'
    $('autoTuneStatus').dataset.state = 'idle'
    return
  }
  const suggestions = Object.values(report.suggestions ?? {})
  const manuallyRefined = suggestions.filter(
    (suggestion) => residualAngleDegrees(
      suggestion.manual_residual_quaternion ?? [0, 0, 0, 1],
    ) > 0.01,
  ).length
  const prefix = hasPreview ? 'Preview' : 'Accepted'
  $('autoTuneStatus').textContent =
    `${prefix}: ${report.applied_semantics.length} fitted, `
    + `${report.skipped_semantics.length} unconstrained · `
    + `${report.mean_direction_error_deg_before.toFixed(2)}° → `
    + `${report.mean_direction_error_deg_after.toFixed(2)}° mean direction error`
    + (manuallyRefined ? ` · ${manuallyRefined} manually refined` : '')
  $('autoTuneStatus').dataset.state = hasPreview ? 'working' : 'success'
}

function clearAutoTuneSession() {
  state.autoTuneCandidate = null
  state.autoTuneBaseline = null
}

function previewAutoTune() {
  if (!state.draft || !state.motion) return
  stopPlayback()
  try {
    const frame = Number.parseInt($('restFrame').value, 10)
    state.autoTuneCandidate = autoTuneReferencePose({
      profile: state.draft,
      avatarRig: state.rig,
      motion: state.motion,
      frame,
      canonicalSkeleton: state.somaContract,
    })
    state.offsetPreviewProfile = state.autoTuneCandidate.profile
    previewFrame(frame)
    renderCalibrationProgress()
    setStatus(
      `Previewing automatic reference fit from SOMA frame ${frame}; accept or revert it.`,
    )
  } catch (error) {
    state.autoTuneCandidate = null
    state.offsetPreviewProfile = null
    $('autoTuneStatus').textContent = `Auto-fit failed: ${error.message}`
    $('autoTuneStatus').dataset.state = 'error'
    console.error('[SOMA Studio] automatic reference fit failed', error)
  }
}

$('autoTuneBtn').addEventListener('click', previewAutoTune)

$('acceptAutoTuneBtn').addEventListener('click', () => {
  if (!state.autoTuneCandidate || !state.draft) return
  state.autoTuneBaseline = structuredClone(state.draft)
  state.draft = state.autoTuneCandidate.profile
  state.autoTuneCandidate = null
  state.offsetPreviewProfile = null
  state.offsetHistory = []
  state.offsetHistoryIndex = -1
  state.validationEvidence = null
  renderCalibrationProgress()
  previewFrame(state.draft.rest_calibration.source_frame)
  setStatus(
    'Automatic fit accepted. Fine-tuning is recorded as a residual from each suggestion.',
  )
})

$('revertAutoTuneBtn').addEventListener('click', () => {
  stopPlayback()
  if (state.autoTuneCandidate) {
    state.autoTuneCandidate = null
    state.offsetPreviewProfile = null
    renderCalibrationProgress()
    previewFrame(state.draft.rest_calibration.source_frame)
    setStatus('Automatic fit preview reverted')
    return
  }
  if (!state.autoTuneBaseline) return
  state.draft = state.autoTuneBaseline
  state.autoTuneBaseline = null
  state.offsetPreviewProfile = null
  state.offsetHistory = []
  state.offsetHistoryIndex = -1
  state.validationEvidence = null
  renderCalibrationProgress()
  previewFrame(state.draft.rest_calibration.source_frame)
  setStatus('Accepted automatic fit offsets reverted')
})

function renderOffsetEditor(enabled) {
  const fieldset = $('offsetEditor')
  const select = $('offsetSemantic')
  fieldset.disabled = !enabled
  if (!enabled || !state.draft) {
    select.replaceChildren()
    rotationControls.detach()
    rotationControls.visible = false
    return
  }
  const previous = state.activeOffsetSemantic ?? select.value
  select.replaceChildren()
  state.draft.mapping.forEach((entry) => {
    const option = document.createElement('option')
    option.value = entry.semantic
    option.textContent = entry.semantic
    select.append(option)
  })
  select.value = state.draft.rest_calibration.per_bone[previous]
    ? previous
    : (state.draft.mapping[0]?.semantic ?? '')
  state.activeOffsetSemantic = select.value
  loadOffsetAngles()
  updateOffsetHistoryButtons()
  syncOffsetGizmo()
}

function offsetQuaternion(semantic, profile = state.draft) {
  return profile?.rest_calibration?.per_bone?.[semantic]?.user_offset_quaternion
    ?? null
}

function quaternionFromDegrees(degrees) {
  if (degrees.some((value) => !Number.isFinite(value))) {
    throw new TypeError('X, Y, and Z must be finite numbers')
  }
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    ...degrees.map(THREE.MathUtils.degToRad),
    'XYZ',
  )).normalize().toArray()
}

function currentOffsetDegrees() {
  return ['offsetX', 'offsetY', 'offsetZ'].map((id) => Number($(id).value))
}

function loadOffsetAngles(quaternion = null) {
  const semantic = state.activeOffsetSemantic ?? $('offsetSemantic').value
  const selectedQuaternion = quaternion ?? offsetQuaternion(semantic)
  if (!selectedQuaternion) return
  const euler = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().fromArray(selectedQuaternion),
    'XYZ',
  )
  ;['X', 'Y', 'Z'].forEach((axis, index) => {
    const degrees = THREE.MathUtils.radToDeg([euler.x, euler.y, euler.z][index])
      .toFixed(3)
    $(`offset${axis}`).value = degrees
    $(`offset${axis}Range`).value = degrees
  })
}

function selectOffsetSemantic(semantic) {
  if (!offsetQuaternion(semantic)) return
  state.activeOffsetSemantic = semantic
  $('offsetSemantic').value = semantic
  loadOffsetAngles()
  updateBoneMarkerColors()
  syncOffsetGizmo()
  setStatus(`Editing ${semantic} local calibration offset`)
}

function syncOffsetGizmo() {
  if (rotationControls.dragging
      || state.activeStage !== 'calibrate'
      || !state.activeOffsetSemantic
      || !state.objectByRigId
      || !offsetQuaternion(state.activeOffsetSemantic)) {
    if (!rotationControls.dragging) {
      rotationControls.detach()
      rotationControls.visible = false
    }
    return
  }
  const targetId = state.mappingSelections.get(state.activeOffsetSemantic)
  const object = state.objectByRigId.get(targetId)
  if (!object) return
  object.updateWorldMatrix(true, false)
  object.getWorldPosition(offsetPivot.position)
  object.getWorldQuaternion(offsetPivot.quaternion)
  offsetPivot.updateMatrixWorld(true)
  rotationControls.attach(offsetPivot)
  rotationControls.visible = true
}

function updateOffsetHistoryButtons() {
  $('undoOffsetBtn').disabled = state.offsetHistoryIndex < 0
  $('redoOffsetBtn').disabled =
    state.offsetHistoryIndex >= state.offsetHistory.length - 1
  const role = roleForSemantic(state.activeOffsetSemantic)
  const pairReady = Boolean(
    role?.opposite && offsetQuaternion(role.opposite),
  )
  $('copyOffsetBtn').disabled = !pairReady
  $('mirrorOffsetBtn').disabled = !pairReady
}

function invalidateOffsetValidation(semantic) {
  state.validationEvidence = null
  $('exportDraftBtn').textContent = 'Export draft'
  $('validationStatus').textContent =
    `${semantic} offset changed. Run fixed-frame validation again.`
  $('validationStatus').dataset.state = 'idle'
}

function commitOffsetQuaternion(semantic, quaternion, {
  label = `Edit ${semantic}`,
  recordHistory = true,
  select = true,
} = {}) {
  if (!state.draft) return
  const before = [...offsetQuaternion(semantic)]
  const normalized = new THREE.Quaternion().fromArray(quaternion).normalize()
  const beforeQuaternion = new THREE.Quaternion().fromArray(before).normalize()
  if (Math.abs(beforeQuaternion.dot(normalized)) > 1 - 1e-12) {
    state.offsetPreviewProfile = null
    loadOffsetAngles(before)
    updateOffsetHistoryButtons()
    previewFrame(Number.parseInt($('previewFrame').value, 10))
    return
  }
  try {
    state.draft = setBoneUserOffset({
      profile: state.draft,
      semantic,
      quaternion: normalized.toArray(),
      avatarRig: state.rig,
      canonicalSkeleton: state.somaContract,
    })
    const after = [...offsetQuaternion(semantic)]
    state.offsetPreviewProfile = null
    if (recordHistory) {
      state.offsetHistory.splice(state.offsetHistoryIndex + 1)
      state.offsetHistory.push({ semantic, before, after, label })
      state.offsetHistoryIndex = state.offsetHistory.length - 1
    }
    if (select) state.activeOffsetSemantic = semantic
    invalidateOffsetValidation(semantic)
    renderCalibrationProgress()
    previewFrame(Number.parseInt($('previewFrame').value, 10))
    setStatus(label)
  } catch (error) {
    setStatus(`Offset rejected: ${error.message}`)
  }
}

function previewOffsetQuaternion(semantic, quaternion) {
  if (!state.draft) return
  try {
    state.offsetPreviewProfile = setBoneUserOffset({
      profile: state.draft,
      semantic,
      quaternion,
      avatarRig: state.rig,
      canonicalSkeleton: state.somaContract,
    })
    previewFrame(Number.parseInt($('previewFrame').value, 10), {
      quiet: true,
      syncGizmo: false,
    })
  } catch (error) {
    state.offsetPreviewProfile = null
    setStatus(`Offset preview rejected: ${error.message}`)
  }
}

function applyOffsetDegrees(degrees, { preview = false } = {}) {
  const semantic = state.activeOffsetSemantic ?? $('offsetSemantic').value
  try {
    const quaternion = quaternionFromDegrees(degrees)
    if (preview) previewOffsetQuaternion(semantic, quaternion)
    else commitOffsetQuaternion(semantic, quaternion, {
      label: `Applied explicit ${semantic} rotation offset`,
    })
  } catch (error) {
    setStatus(`Offset rejected: ${error.message}`)
  }
}

$('offsetSemantic').addEventListener('change', (event) => {
  selectOffsetSemantic(event.target.value)
})

$('applyOffsetBtn').addEventListener('click', () => {
  applyOffsetDegrees(currentOffsetDegrees())
})

$('resetOffsetBtn').addEventListener('click', () => {
  applyOffsetDegrees([0, 0, 0])
})

for (const axis of ['X', 'Y', 'Z']) {
  const range = $(`offset${axis}Range`)
  const number = $(`offset${axis}`)
  range.addEventListener('input', () => {
    number.value = Number(range.value).toFixed(1)
    applyOffsetDegrees(currentOffsetDegrees(), { preview: true })
  })
  range.addEventListener('change', () => {
    applyOffsetDegrees(currentOffsetDegrees())
  })
  number.addEventListener('input', () => {
    const value = Number(number.value)
    if (!Number.isFinite(value)) return
    range.value = String(Math.max(-180, Math.min(180, value)))
    applyOffsetDegrees(currentOffsetDegrees(), { preview: true })
  })
  number.addEventListener('change', () => {
    applyOffsetDegrees(currentOffsetDegrees())
  })
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      applyOffsetDegrees(currentOffsetDegrees())
    }
  })
}

function applyHistory(entry, direction) {
  commitOffsetQuaternion(
    entry.semantic,
    direction === 'undo' ? entry.before : entry.after,
    {
      label: `${direction === 'undo' ? 'Undid' : 'Redid'} ${entry.label}`,
      recordHistory: false,
    },
  )
}

$('undoOffsetBtn').addEventListener('click', () => {
  if (state.offsetHistoryIndex < 0) return
  const entry = state.offsetHistory[state.offsetHistoryIndex]
  state.offsetHistoryIndex -= 1
  applyHistory(entry, 'undo')
})

$('redoOffsetBtn').addEventListener('click', () => {
  if (state.offsetHistoryIndex >= state.offsetHistory.length - 1) return
  state.offsetHistoryIndex += 1
  applyHistory(state.offsetHistory[state.offsetHistoryIndex], 'redo')
})

function applyOffsetToPair(mirror) {
  const semantic = state.activeOffsetSemantic
  const role = roleForSemantic(semantic)
  const opposite = role?.opposite
  if (!opposite || !offsetQuaternion(opposite)) return
  const quaternion = mirror
    ? mirrorLocalOffset({
      quaternion: offsetQuaternion(semantic),
      sourceRestWorldQuaternion:
        state.draft.rest_calibration.per_bone[semantic].target_rest_world_quaternion,
      targetRestWorldQuaternion:
        state.draft.rest_calibration.per_bone[opposite].target_rest_world_quaternion,
    })
    : [...offsetQuaternion(semantic)]
  commitOffsetQuaternion(opposite, quaternion, {
    label: `${mirror ? 'Mirrored' : 'Copied'} ${semantic} offset to ${opposite}`,
  })
}

$('copyOffsetBtn').addEventListener('click', () => applyOffsetToPair(false))
$('mirrorOffsetBtn').addEventListener('click', () => applyOffsetToPair(true))

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)
      || !['z', 'y'].includes(event.key.toLowerCase())
      || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
  event.preventDefault()
  if (event.key.toLowerCase() === 'y' || event.shiftKey) $('redoOffsetBtn').click()
  else $('undoOffsetBtn').click()
})

function gizmoQuaternion() {
  if (!state.gizmoStart) return null
  const delta = state.gizmoStart.pivotQuaternion.clone()
    .invert()
    .multiply(offsetPivot.quaternion)
    .normalize()
  return new THREE.Quaternion()
    .fromArray(state.gizmoStart.offsetQuaternion)
    .multiply(delta)
    .normalize()
    .toArray()
}

rotationControls.addEventListener('dragging-changed', (event) => {
  controls.enabled = !event.value
  if (event.value) {
    stopPlayback()
    state.gizmoStart = {
      semantic: state.activeOffsetSemantic,
      offsetQuaternion: [...offsetQuaternion(state.activeOffsetSemantic)],
      pivotQuaternion: offsetPivot.quaternion.clone(),
    }
  } else if (state.gizmoStart) {
    const { semantic } = state.gizmoStart
    const quaternion = gizmoQuaternion()
    state.gizmoStart = null
    commitOffsetQuaternion(semantic, quaternion, {
      label: `Rotated ${semantic} with local gizmo`,
    })
  }
})

rotationControls.addEventListener('objectChange', () => {
  if (!rotationControls.dragging || !state.gizmoStart) return
  const quaternion = gizmoQuaternion()
  loadOffsetAngles(quaternion)
  previewOffsetQuaternion(state.gizmoStart.semantic, quaternion)
})

async function acceptMotionJson(input, label) {
  stopPlayback()
  try {
    state.motion = await adaptMotionJson(input, state.somaContract)
    $('restFrame').disabled = false
    $('restFrame').max = String(state.motion.frame_count - 1)
    $('restFrame').value = '0'
    $('previewFrame').disabled = false
    $('previewFrame').max = String(state.motion.frame_count - 1)
    $('previewFrame').value = '0'
    updatePreviewFrameLabel(0)
    $('motionStatus').textContent =
      `${label}: ${state.motion.frame_count} frames, ${state.motion.joints.length} joints, ${state.motion.fps} fps.`
    $('motionStatus').dataset.state = 'success'
    setStatus(`Loaded canonical motion ${state.motion.motion_signature.slice(0, 23)}…`)
    renderCalibrationProgress()
    if (state.legacyReference) {
      state.legacyReference.retargeter = null
      state.legacyReference.motionSignature = null
      state.legacyReference.lastFrame = -1
    }
    updateReferences(0)
  } catch (error) {
    state.motion = null
    $('motionStatus').textContent = `Motion rejected: ${error.message}`
    $('motionStatus').dataset.state = 'error'
    console.error('[SOMA Studio] motion rejected', error)
    renderCalibrationProgress()
  }
}

async function loadKimodoMotion() {
  $('motionStatus').textContent = 'Loading fixed Kimodo evidence clip…'
  $('motionStatus').dataset.state = 'working'
  try {
    const response = await fetch(SAMPLE_KIMODO_URL)
    if (!response.ok) throw new Error(`Kimodo reference HTTP ${response.status}`)
    await acceptMotionJson(await response.json(), 'Kimodo reference')
  } catch (error) {
    state.motion = null
    $('motionStatus').textContent = `Motion load failed: ${error.message}`
    $('motionStatus').dataset.state = 'error'
    renderCalibrationProgress()
  }
}

async function loadQualificationMotion() {
  if (state.qualificationMotion) return state.qualificationMotion
  $('qualificationStatus').textContent =
    'Loading and normalizing the original .96 Core27 turn capture…'
  $('qualificationStatus').dataset.state = 'working'
  $('loadQualificationBtn').disabled = true
  try {
    const chunks = await Promise.all(QUALIFICATION_TURN_URLS.map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`turn qualification HTTP ${response.status}`)
      }
      return response.json()
    }))
    state.qualificationMotion = await adaptMotionJson(
      chunks,
      state.somaContract,
    )
    const left = contactStatsForMotion(state.qualificationMotion, 1, 0.5)
    const right = contactStatsForMotion(state.qualificationMotion, 3, 0.5)
    $('qualificationStatus').textContent =
      `.96 turn ready: ${state.qualificationMotion.frame_count} frames · `
      + `L ${left.transitions}, R ${right.transitions} contact transitions.`
    $('qualificationStatus').dataset.state = 'success'
    return state.qualificationMotion
  } catch (error) {
    state.qualificationMotion = null
    $('qualificationStatus').textContent =
      `Qualification motion failed: ${error.message}`
    $('qualificationStatus').dataset.state = 'error'
    throw error
  } finally {
    $('loadQualificationBtn').disabled = false
  }
}

$('loadKimodoBtn').addEventListener('click', loadKimodoMotion)
$('loadQualificationBtn').addEventListener('click', () => {
  loadQualificationMotion().catch((error) => {
    console.error('[SOMA Studio] qualification motion rejected', error)
  })
})
$('motionFile').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file) return
  try {
    await acceptMotionJson(JSON.parse(await file.text()), file.name)
  } catch (error) {
    $('motionStatus').textContent = `Motion rejected: ${error.message}`
    $('motionStatus').dataset.state = 'error'
  }
})

$('captureCalibrationBtn').addEventListener('click', () => {
  if (!state.draft || !state.motion) return
  try {
    clearAutoTuneSession()
    const frame = Number.parseInt($('restFrame').value, 10)
    let profile = captureRestCalibration({
      profile: state.draft,
      avatarRig: state.rig,
      motion: state.motion,
      frame,
      canonicalSkeleton: state.somaContract,
    })
    profile = calibrateRoot({
      profile,
      avatarRig: state.rig,
      motion: state.motion,
      frame,
      canonicalSkeleton: state.somaContract,
    })
    state.draft = calibrateScale({
      profile,
      avatarRig: state.rig,
      motion: state.motion,
      canonicalSkeleton: state.somaContract,
    })
    state.validationEvidence = null
    state.offsetHistory = []
    state.offsetHistoryIndex = -1
    state.offsetPreviewProfile = null
    seedIkCalibrationControls()
    setStatus(`Calibration captured from frame ${frame}; validation still required`)
    renderCalibrationProgress()
    previewFrame(frame)
  } catch (error) {
    console.error('[SOMA Studio] calibration capture failed', error)
    $('motionStatus').textContent = `Calibration failed: ${error.message}`
    $('motionStatus').dataset.state = 'error'
  }
})

function previewFrame(frame, { quiet = false, syncGizmo = true } = {}) {
  const profile = state.offsetPreviewProfile ?? state.draft
  if (!profile || !state.motion || !calibrationReadiness(profile).ready_for_validation) {
    return
  }
  let pose
  if (profile.runtime_corrections?.ground_contact?.enabled
      || profile.ik?.enabled) {
    const session = createRetargetSession({
      profile,
      avatarRig: state.rig,
      motion: state.motion,
      canonicalSkeleton: state.somaContract,
      requireValidated: profile.status === 'validated',
    })
    for (let current = 0; current <= frame; current += 1) {
      pose = session.solve(current)
    }
  } else {
    pose = solveRetargetFrame({
      profile,
      avatarRig: state.rig,
      motion: state.motion,
      frame,
      canonicalSkeleton: state.somaContract,
      requireValidated: profile.status === 'validated',
    })
  }
  applyPoseToThreeObject(pose, state.objectByRigId)
  state.avatarPoseCommit()
  state.avatarObject.updateMatrixWorld(true)
  updateReferences(frame)
  updatePreviewFrameLabel(frame)
  if (syncGizmo) syncOffsetGizmo()
  if (!quiet) setStatus(`Previewing calibrated SOMA frame ${frame}`)
}

$('previewFrame').addEventListener('input', (event) => {
  stopPlayback()
  previewFrame(Number.parseInt(event.target.value, 10))
})

function updatePreviewFrameLabel(frame) {
  const max = state.motion ? state.motion.frame_count - 1 : 0
  $('previewFrameValue').textContent = `${frame} / ${max}`
}

function stopPlayback() {
  if (state.playbackTimer !== null) {
    clearInterval(state.playbackTimer)
    state.playbackTimer = null
  }
  const button = $('togglePlaybackBtn')
  if (button) {
    button.textContent = 'Play motion'
    button.setAttribute('aria-pressed', 'false')
  }
}

function startPlayback() {
  if (!state.motion || !state.draft) return
  const slider = $('previewFrame')
  const lastFrame = state.motion.frame_count - 1
  let frame = Number.parseInt(slider.value, 10)
  if (frame >= lastFrame) frame = -1
  const intervalMs = Math.max(1, 1000 / state.motion.fps)
  $('togglePlaybackBtn').textContent = 'Pause motion'
  $('togglePlaybackBtn').setAttribute('aria-pressed', 'true')
  state.playbackTimer = setInterval(() => {
    frame += 1
    if (frame > lastFrame) {
      stopPlayback()
      return
    }
    slider.value = String(frame)
    previewFrame(frame)
  }, intervalMs)
}

$('togglePlaybackBtn').addEventListener('click', () => {
  if (state.playbackTimer === null) startPlayback()
  else stopPlayback()
})

function applyIkCalibration() {
  if (!state.draft || !calibrationReadiness(state.draft).ready_for_validation) return
  try {
    const enabled = $('enableFootIk').checked
    const settings = {
      groundY: Number($('ikGroundY').value),
      soleOffsetM: {
        leftFoot: Number($('ikLeftSoleOffset').value),
        rightFoot: Number($('ikRightSoleOffset').value),
      },
      contactThreshold: Number($('ikContactThreshold').value),
      contactHysteresis: 0.1,
      lockHorizontal: $('ikLockHorizontal').checked,
      lockOrientation: $('ikLockOrientation').checked,
      pelvisCompensationMaxM: $('ikPelvisCompensation').checked
        ? Number($('ikPelvisMax').value)
        : 0,
      lockBlendFrames: Number.parseInt($('ikBlendFrames').value, 10),
      useRestPosePoles: $('ikUsePoles').checked,
    }
    const numeric = [
      settings.groundY,
      ...Object.values(settings.soleOffsetM),
      settings.contactThreshold,
      settings.lockBlendFrames,
      settings.pelvisCompensationMaxM,
    ]
    if (numeric.some((value) => !Number.isFinite(value))) {
      throw new TypeError('IK calibration values must be finite')
    }
    state.draft = configureFootGroundIk({
      profile: state.draft,
      avatarRig: state.rig,
      enabled,
      ...settings,
    })
    state.validationEvidence = null
    $('validationStatus').textContent =
      'IK setup changed. Run fixed-frame validation before export.'
    $('validationStatus').dataset.state = 'idle'
    $('exportDraftBtn').textContent = 'Export draft'
    setStatus(
      enabled
        ? 'Temporal foot locks and knee poles applied; profile returned to draft'
        : 'Foot IK disabled; profile returned to draft',
    )
    renderCalibrationProgress()
    previewFrame(Number.parseInt($('previewFrame').value, 10))
  } catch (error) {
    setStatus(`IK setup failed: ${error.message}`)
  }
}

$('enableFootIk').addEventListener('change', applyIkCalibration)
$('applyIkCalibrationBtn').addEventListener('click', applyIkCalibration)
$('ikContactThreshold').addEventListener('change', () => {
  renderIkCalibration(calibrationReadiness(state.draft))
})

$('profileFile').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file || !state.rig) {
    setStatus('Import the matching avatar before loading a profile')
    return
  }
  try {
    const profile = JSON.parse(await file.text())
    const matchingRig = state.rigVariants.find(
      (candidate) => candidate.rig_signature === profile.avatar?.rig_signature,
    )
    if (!matchingRig) {
      throw new Error(
        'profile rig signature matches neither the detailed nor compatibility rig view',
      )
    }
    if (matchingRig !== state.rig) {
      state.rig = matchingRig
      state.objectByRigId = indexThreeRigObjects(state.avatarObject, matchingRig)
      rebuildBoneMarkers()
      renderRig()
      $('rigBadge').textContent =
        `${matchingRig.bones.length} bones · ${matchingRig.rig_signature.slice(7, 15)}`
    }
    if (profile.status === 'validated') {
      await verifyValidatedProfile({
        profile,
        avatarRig: state.rig,
        canonicalSkeleton: state.somaContract,
      })
    } else {
      assertCalibrationProfile(profile, {
        avatarRig: state.rig,
        canonicalSkeleton: state.somaContract,
      })
    }
    state.draft = profile
    state.validationEvidence = null
    state.offsetHistory = []
    state.offsetHistoryIndex = -1
    state.offsetPreviewProfile = null
    clearAutoTuneSession()
    state.gizmoStart = null
    state.mappingSelections = new Map(
      profile.mapping.map((entry) => [entry.semantic, entry.target_bone_id]),
    )
    seedIkCalibrationControls()
    renderMappingEditor()
    renderMappingProgress()
    renderCalibrationProgress()
    $('exportDraftBtn').textContent =
      profile.status === 'validated' ? 'Export validated profile' : 'Export draft'
    if (profile.status === 'validated') {
      const summary = [...document.querySelectorAll('#validationSummary strong')]
      summary[0].textContent = String(profile.validation.frames.length)
      summary[1].textContent = String(profile.mapping.length)
      summary[2].textContent = String(profile.validation.repeat_canonical_delta)
      $('validationStatus').textContent =
        `Loaded PASS · ${profile.validation.result_signature.slice(0, 23)}…`
      $('validationStatus').dataset.state = 'success'
      $('profileStatus').textContent = 'Validated profile loaded · runtime eligible'
    }
    setStatus(`Loaded context-valid ${profile.status} profile`)
  } catch (error) {
    console.error('[SOMA Studio] profile rejected', error)
    setStatus(`Profile rejected: ${error.message}`)
  } finally {
    event.target.value = ''
  }
})

$('runValidationBtn').addEventListener('click', async () => {
  if (!state.draft || !state.motion) return
  const frames = [0, 37, 74, 111, state.motion.frame_count - 1]
    .filter((frame) => frame >= 0 && frame < state.motion.frame_count)
  $('validationStatus').textContent = 'Running fixed frames twice…'
  $('validationStatus').dataset.state = 'working'
  $('runValidationBtn').disabled = true
  try {
    const qualificationMotion = state.draft.ik?.enabled
      ? await loadQualificationMotion()
      : null
    const evidence = await validateCalibration({
      profile: state.draft,
      avatarRig: state.rig,
      motion: state.motion,
      qualificationMotion,
      frames,
      canonicalSkeleton: state.somaContract,
    })
    state.validationEvidence = evidence
    const summary = [...document.querySelectorAll('#validationSummary strong')]
    summary[0].textContent = String(evidence.result.frame_count)
    summary[1].textContent = String(evidence.result.driven_bone_count)
    summary[2].textContent = String(evidence.result.repeat_canonical_delta)
    if (!evidence.passed) {
      $('validationStatus').textContent =
        `FAIL · ${evidence.result.issues.slice(0, 3).join(' · ')}`
      $('validationStatus').dataset.state = 'error'
      $('runValidationBtn').disabled = false
      setStatus('Validation evidence recorded; profile remains a draft')
      return
    }
    state.draft = promoteValidatedProfile({
      profile: state.draft,
      evidence,
      avatarRig: state.rig,
      canonicalSkeleton: state.somaContract,
    })
    $('validationStatus').textContent =
      `PASS · ${evidence.result_signature.slice(0, 23)}…`
    $('validationStatus').dataset.state = 'success'
    $('profileStatus').textContent = 'Validated profile · runtime eligible'
    $('exportDraftBtn').textContent = 'Export validated profile'
    setStatus('Validation passed twice; profile promoted explicitly')
  } catch (error) {
    console.error('[SOMA Studio] validation failed', error)
    $('validationStatus').textContent = `FAIL · ${error.message}`
    $('validationStatus').dataset.state = 'error'
    $('runValidationBtn').disabled = false
  }
})

$('exportDraftBtn').addEventListener('click', () => {
  if (!state.draft) return
  const blob = new Blob([`${JSON.stringify(state.draft, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${state.draft.profile_id.replaceAll(':', '-')}.avatar.calibration.json`
  link.click()
  URL.revokeObjectURL(url)
  setStatus('Draft profile exported')
})

async function boot() {
  try {
    const [somaContract, roleCatalog] = await Promise.all([
      fetch('contracts/soma77.skeleton.json').then((response) => {
        if (!response.ok) throw new Error(`SOMA contract HTTP ${response.status}`)
        return response.json()
      }),
      fetch('contracts/humanoid54.authoring.json?v=2').then((response) => {
        if (!response.ok) throw new Error(`role catalog HTTP ${response.status}`)
        return response.json()
      }),
    ])
    state.somaContract = somaContract
    state.roleCatalog = roleCatalog
    state.somaSignature = await contractSignature(state.somaContract)
    state.roleCatalogSignature = await contractSignature(state.roleCatalog)
    $('contractLabel').textContent =
      `${state.somaContract.id} · ${state.roleCatalog.roles.length} controls · ${state.somaSignature.slice(7, 15)}`
    renderMappingProgress()
    renderCalibrationProgress()
    if (new URLSearchParams(location.search).get('sample') === 'tai') await loadTaiSample()
  } catch (error) {
    console.error('[SOMA Studio] boot failed', error)
    setImportStatus(`Studio boot failed: ${error.message}`, 'error')
  }
}

boot()
