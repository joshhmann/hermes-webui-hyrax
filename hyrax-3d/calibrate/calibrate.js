// calibrate.js — Avatar Calibration Studio, Phase 2.
//
// 3D skeleton visualization, interactive bone mapping, rest pose
// controls, profile export. Retains Phase 1 validation (profile-driven
// vs reference retarget comparison).

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { SomaVrmRetargeter, BONE_MAPS } from '../REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js'
import { AvatarRetargeter } from './AvatarRetargeter.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)

// ── Three.js setup ────────────────────────────────────────────────────
const container = $('viewport')
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1117)

const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.01, 50)
camera.position.set(0, 1.2, 2.8)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(container.clientWidth, container.clientHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
container.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.9, 0)

// Lights
scene.add(new THREE.AmbientLight(0x404060, 0.6))
const dl = new THREE.DirectionalLight(0xffffff, 1.2)
dl.position.set(5, 8, 5)
scene.add(dl)
const dl2 = new THREE.DirectionalLight(0xffffff, 0.4)
dl2.position.set(-3, 2, -3)
scene.add(dl2)
scene.add(new THREE.GridHelper(4, 20, 0x30363d, 0x21262d))

function resize() {
  const w = container.clientWidth, h = container.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}
window.addEventListener('resize', resize)

// State
let profile = null
let avatarVrm = null
let avatarScene = null
let motion = null
let captureList = []
let frame = 0
let playing = false
let selectedBone = null  // 'source' | 'target' bone name

// Retargeters
let profileRetargeter = null
let refRetargeter = null

// Profile-driven snapshot (F-001 fix: independent comparison buffer)
let profileSnapshot = { quat: {}, hipsPos: new THREE.Vector3() }

// 3D skeleton visualization
const srcSkelGroup = new THREE.Group()
const tgtSkelGroup = new THREE.Group()
scene.add(srcSkelGroup)
scene.add(tgtSkelGroup)

let srcBoneLines = null, srcJointMeshes = null, srcJointCount = 0
let tgtBoneLines = null, tgtJointMeshes = null, tgtJointCount = 0

// Selected bone highlight mesh
const selMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.035, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffa657 }),
)
selMarker.visible = false
scene.add(selMarker)

// Temporary position buffer for FK
let _fkPos = null

// ── Profile loading ───────────────────────────────────────────────────
async function loadProfile(url) {
  profile = await fetchJson(url)
  renderProfileInfo()
  buildSkeletonTrees()
  renderMappingList()
  syncRestPoseControls()
  setStatus(`Profile: ${profile.meta.avatar_name}`)
  $('profileLabel').textContent = profile.meta.avatar_name
}

function renderProfileInfo() {
  if (!profile) { $('profileInfo').textContent = 'not loaded'; return }
  const mapCount = Object.keys(profile.skeleton_maps).filter(k => typeof profile.skeleton_maps[k] === 'object').length
  $('profileInfo').innerHTML =
    `<div>avatar: <strong>${profile.meta.avatar_name}</strong> (${profile.meta.avatar_format})</div>` +
    `<div>maps: ${mapCount} · solve: ${profile.solve_order.length} bones</div>` +
    `<div>version: ${profile.profile_version}</div>`
}

function syncRestPoseControls() {
  if (!profile) return
  $('hipHeightSlider').value = profile.rest_pose.default_src_hips_height_m
  $('hipHeightVal').textContent = profile.rest_pose.default_src_hips_height_m.toFixed(3)
  $('scaleSlider').value = 1.0
  $('scaleVal').textContent = '1.00'
}

// ── Skeleton trees ────────────────────────────────────────────────────
function buildSkeletonTrees() {
  if (!profile) return
  const map = firstMap()
  if (!map) return
  const parentMap = profile.vrm_bone_parents
  $('sourceTree').innerHTML = buildSourceTreeHtml(map, parentMap)
  $('targetTree').innerHTML = buildTargetTreeHtml()
}

function firstMap() {
  if (!profile) return null
  return Object.values(profile.skeleton_maps).find(v => typeof v === 'object')
}

function buildSourceTreeHtml(map, parentMap) {
  const children = { root: [] }
  for (const [key, joint] of Object.entries(map)) {
    const p = parentMap[key]
    const pk = p || 'root'
    if (!children[pk]) children[pk] = []
    children[pk].push({ key, joint })
  }
  const lines = []
  function render(key, depth) {
    if (!children[key]) return
    for (const child of children[key]) {
      const cls = 'tree-node mapped' + (selectedBone === child.key ? ' selected' : '')
      const ds = child.key.startsWith('left') || child.key.startsWith('right') ? depth : depth
      lines.push(
        `<div class="${cls}" data-bone="${child.key}" data-side="source" ` +
        `style="padding-left:${depth * 16}px" onclick="window.__selectBone?.('source','${child.key}')">` +
        `${child.key} <span style="color:#484f58">← ${child.joint}</span></div>`
      )
      render(child.key, depth + 1)
    }
  }
  render('root', 0)
  return lines.join('')
}

function buildTargetTreeHtml() {
  if (!tgtBones.length) return '<div style="color:#8b949e;font-size:11px">no avatar loaded</div>'
  const parentMap = profile?.vrm_bone_parents ?? {}
  const children = { root: [] }
  for (const b of tgtBones) {
    const p = parentMap[b.name]
    const pk = p || 'root'
    if (!children[pk]) children[pk] = []
    children[pk].push({ name: b.name })
  }
  const lines = []
  function render(key, depth) {
    if (!children[key]) return
    for (const c of children[key]) {
      const cls = 'tree-node mapped' + (selectedBone === c.name ? ' selected' : '')
      lines.push(
        `<div class="${cls}" data-bone="${c.name}" data-side="target" ` +
        `style="padding-left:${depth * 16}px" onclick="window.__selectBone?.('target','${c.name}')">` +
        `${c.name}</div>`
      )
      render(c.name, depth + 1)
    }
  }
  render('root', 0)
  return lines.join('')
}

// Bone selection handler (exposed globally for onclick)
window.__selectBone = (side, name) => {
  selectedBone = name
  // Update tree highlights
  document.querySelectorAll('.tree-node.selected').forEach(el => el.classList.remove('selected'))
  document.querySelectorAll(`[data-bone="${name}"]`).forEach(el => el.classList.add('selected'))
  // Update 3D highlight
  updateSelectionMarker()
}

function updateSelectionMarker() {
  if (!selectedBone || !motion) { selMarker.visible = false; return }
  // Check source skeleton first
  const map = firstMap()
  if (map && map[selectedBone] && motion) {
    const joint = map[selectedBone]
    const ji = motion.joints.indexOf(joint)
    if (ji >= 0 && _fkPos) {
      selMarker.position.set(_fkPos[ji * 3], _fkPos[ji * 3 + 1], _fkPos[ji * 3 + 2])
      selMarker.visible = true
      return
    }
  }
  // Check target skeleton
  if (avatarVrm) {
    const node = avatarVrm.humanoid.getNormalizedBoneNode(selectedBone)
    if (node) {
      avatarVrm.scene.updateMatrixWorld(true)
      const v = new THREE.Vector3()
      node.getWorldPosition(v)
      selMarker.position.copy(v)
      selMarker.visible = true
      return
    }
  }
  selMarker.visible = false
}

// ── Bone mapping list ─────────────────────────────────────────────────
function renderMappingList() {
  if (!profile || !tgtBones.length) {
    $('mappingList').innerHTML = '<div style="color:#8b949e;font-size:11px">load profile + avatar</div>'
    return
  }
  const map = firstMap()
  if (!map) { $('mappingList').innerHTML = '<div style="color:#8b949e;font-size:11px">no skeleton map</div>'; return }
  const lines = profile.solve_order.map(bone => {
    const joint = map[bone]
    const isMapped = joint && tgtBones.some(b => b.name === bone)
    return `<div class="mapping-entry" onclick="window.__selectBone?.('source','${bone}')">
      <span class="soma">${bone}</span>
      <span class="arrow">→</span>
      ${isMapped ? `<span class="avatar">${bone}</span>` : `<span class="unset">(unmapped)</span>`}
      <span style="color:#484f58;font-size:10px">${joint ?? '—'}</span>
    </div>`
  })
  $('mappingList').innerHTML = lines.join('')
}

// ── Avatar loading ────────────────────────────────────────────────────
let tgtBones = []

async function loadAvatar(url) {
  setStatus('Loading avatar…')
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  const vrm = gltf.userData.vrm
  if (vrm) {
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
    if (avatarVrm) scene.remove(avatarVrm.scene)
    avatarVrm = vrm
    vrm.scene.position.set(0.7, 0, 0)
    scene.add(vrm.scene)
    detectVrmSkeleton(vrm)
  } else {
    if (avatarScene) scene.remove(avatarScene)
    avatarScene = gltf.scene
    avatarScene.position.set(0.7, 0, 0)
    scene.add(avatarScene)
    detectGlbSkeleton(avatarScene)
  }
  buildTargetTree()
  renderMappingList()
  buildTargetSkeleton()
  setStatus(`Avatar: ${vrm?.meta?.name ?? url.split('/').pop()}`)
  $('avatarName').textContent = vrm?.meta?.name ?? 'GLB'
}

function detectVrmSkeleton(vrm) {
  tgtBones = []
  for (const key of (profile?.solve_order ?? [])) {
    const node = vrm.humanoid.getNormalizedBoneNode(key)
    if (node) tgtBones.push({ name: key, node })
  }
}

function detectGlbSkeleton(scene) {
  tgtBones = []
  scene.traverse((child) => {
    if (child.isBone) tgtBones.push({ name: child.name, node: child })
  })
}

function buildTargetTree() {
  if (!tgtBones.length) { $('targetTree').innerHTML = '<div style="color:#8b949e">no skeleton</div>'; return }
  $('targetTree').innerHTML = buildTargetTreeHtml()
}

// ── Motion loading ────────────────────────────────────────────────────
async function loadCapture(id) {
  const entry = captureList.find((c) => c.id === id)
  if (!entry) return
  const base = '../debug/data/'
  const chunks = await Promise.all(entry.chunks.map((c) => fetchJson(base + c)))
  motion = concatChunks(chunks)
  frame = 0
  $('scrub').max = motion.T - 1
  $('frameLabel').textContent = `0/${motion.T - 1}`
  $('fpsLabel').textContent = `${motion.fps}fps`
  const hasMap = profile && mapForSkeleton(motion.skeleton)
  buildSourceSkeleton()
  buildTargetSkeleton()
  updateSkeletonFrame()
  setStatus(`${entry.id} (${motion.skeleton}, ${motion.T} f)` + (hasMap ? '' : ' — no map'))
}

function concatChunks(chunks) {
  const c0 = chunks[0]
  return {
    skeleton: c0.skeleton,
    fps: c0.fps,
    joints: c0.joints,
    parentIdx: c0.parents.map((p, i) => p === null ? -1 : c0.joints.indexOf(p)),
    offsets: c0.rest_offsets_m,
    rot: c0.global_rot_mats,
    root: c0.root_positions,
    contacts: c0.foot_contacts,
    T: c0.global_rot_mats.length,
    timestamps: c0.timestamps ?? [],
  }
}

function mapForSkeleton(skelKey) {
  if (!profile) return null
  let map = profile.skeleton_maps[skelKey]
  if (!map) {
    const alias = profile.skeleton_maps[skelKey + '_alias']
    if (alias) map = profile.skeleton_maps[alias]
  }
  return map ?? null
}

// ── 3D source skeleton rendering ──────────────────────────────────────
function buildSourceSkeleton() {
  srcSkelGroup.clear()
  if (!motion) return
  const J = motion.joints.length
  srcJointCount = J

  // Bones: parent→child line segments
  const bonePairs = []
  for (let j = 1; j < J; j++) {
    if (motion.parentIdx[j] >= 0) bonePairs.push(j)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bonePairs.length * 6), 3))
  srcBoneLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x79c0ff, linewidth: 1 }))
  srcBoneLines.frustumCulled = false
  srcSkelGroup.add(srcBoneLines)

  // Joints: spheres at each joint
  srcJointMeshes = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.012, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x79c0ff }), J)
  srcJointMeshes.frustumCulled = false
  srcSkelGroup.add(srcJointMeshes)
}

function buildTargetSkeleton() {
  tgtSkelGroup.clear()
  if (!tgtBones.length) return
  const J = tgtBones.length
  tgtJointCount = J

  const parentMap = profile?.vrm_bone_parents ?? {}
  const bonePairs = []
  for (let j = 0; j < J; j++) {
    const p = parentMap[tgtBones[j].name]
    if (p && tgtBones.some(b => b.name === p)) bonePairs.push(j)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bonePairs.length * 6), 3))
  tgtBoneLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x3fb950, linewidth: 1 }))
  tgtBoneLines.frustumCulled = false
  tgtSkelGroup.add(tgtBoneLines)

  tgtJointMeshes = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.012, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x3fb950 }), J)
  tgtJointMeshes.frustumCulled = false
  tgtSkelGroup.add(tgtJointMeshes)
}

function fkPositions() {
  if (!motion) return null
  const J = motion.joints.length
  if (!_fkPos || _fkPos.length < J * 3) _fkPos = new Float32Array(J * 3)
  const { parentIdx, offsets, rot, root } = motion
  _fkPos[0] = root[frame][0]; _fkPos[1] = root[frame][1]; _fkPos[2] = root[frame][2]
  for (let j = 1; j < J; j++) {
    const p = parentIdx[j]
    const m = rot[frame][p]
    const o = offsets[j]
    const px = _fkPos[p * 3], py = _fkPos[p * 3 + 1], pz = _fkPos[p * 3 + 2]
    _fkPos[j * 3] = px + m[0] * o[0] + m[1] * o[1] + m[2] * o[2]
    _fkPos[j * 3 + 1] = py + m[3] * o[0] + m[4] * o[1] + m[5] * o[2]
    _fkPos[j * 3 + 2] = pz + m[6] * o[0] + m[7] * o[1] + m[8] * o[2]
  }
  return _fkPos
}

function updateSkeletonFrame() {
  if (!motion) return
  const pos = fkPositions()
  if (!pos) return

  // Source skeleton
  if (srcBoneLines) {
    const pAttr = srcBoneLines.geometry.getAttribute('position')
    const J = motion.joints.length
    let idx = 0
    for (let j = 1; j < J; j++) {
      const p = motion.parentIdx[j]
      if (p < 0) continue
      pAttr.setXYZ(idx * 2, pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2])
      pAttr.setXYZ(idx * 2 + 1, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2])
      idx++
    }
    pAttr.needsUpdate = true
  }
  if (srcJointMeshes) {
    const m4 = new THREE.Matrix4()
    for (let j = 0; j < motion.joints.length; j++) {
      m4.makeTranslation(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2])
      srcJointMeshes.setMatrixAt(j, m4)
    }
    srcJointMeshes.instanceMatrix.needsUpdate = true
  }

  // Target skeleton
  if (avatarVrm && tgtBoneLines) {
    avatarVrm.scene.updateMatrixWorld(true)
    const pAttr = tgtBoneLines.geometry.getAttribute('position')
    const parentMap = profile?.vrm_bone_parents ?? {}
    const v = new THREE.Vector3()
    let idx = 0
    for (let j = 0; j < tgtBones.length; j++) {
      const pn = parentMap[tgtBones[j].name]
      if (!pn) continue
      const pIdx = tgtBones.findIndex(b => b.name === pn)
      if (pIdx < 0) continue
      tgtBones[pIdx].node.getWorldPosition(v)
      pAttr.setXYZ(idx * 2, v.x, v.y, v.z)
      tgtBones[j].node.getWorldPosition(v)
      pAttr.setXYZ(idx * 2 + 1, v.x, v.y, v.z)
      idx++
    }
    pAttr.needsUpdate = true
  }
  if (avatarVrm && tgtJointMeshes) {
    const m4 = new THREE.Matrix4()
    const v = new THREE.Vector3()
    for (let j = 0; j < tgtBones.length; j++) {
      tgtBones[j].node.getWorldPosition(v)
      m4.makeTranslation(v.x, v.y, v.z)
      tgtJointMeshes.setMatrixAt(j, m4)
    }
    tgtJointMeshes.instanceMatrix.needsUpdate = true
  }

  updateSelectionMarker()
}

// ── Playback controls ─────────────────────────────────────────────────
$('playBtn').onclick = () => {
  playing = !playing
  $('playBtn').textContent = playing ? '⏸ pause' : '▶ play'
}

$('prevBtn').onclick = () => stepFrame(-1)
$('nextBtn').onclick = () => stepFrame(1)
$('scrub').oninput = () => {
  frame = parseInt($('scrub').value)
  updateSkeletonFrame()
  $('frameLabel').textContent = `${frame}/${(motion?.T ?? 1) - 1}`
}

function stepFrame(d) {
  if (!motion) return
  frame = Math.max(0, Math.min(motion.T - 1, frame + d))
  $('scrub').value = frame
  updateSkeletonFrame()
  $('frameLabel').textContent = `${frame}/${motion.T - 1}`
}

// ── Rest pose controls ────────────────────────────────────────────────
$('hipHeightSlider').oninput = () => {
  const v = parseFloat($('hipHeightSlider').value)
  $('hipHeightVal').textContent = v.toFixed(3)
  if (profile) profile.rest_pose.default_src_hips_height_m = v
}

$('scaleSlider').oninput = () => {
  const v = parseFloat($('scaleSlider').value)
  $('scaleVal').textContent = v.toFixed(2)
}

$('restFrameInput').onchange = () => {
  // Profile rest frame updated on export or next retarget build
}

// ── Profile-driven retarget (via AvatarRetargeter) ────────────────────
function buildProfileRetargeter() {
  if (!profile || !avatarVrm || !motion) return null
  const srcHipsHeight = parseFloat($('hipHeightSlider').value)
  const restFrame = parseInt($('restFrameInput').value) || 0
  const ret = new AvatarRetargeter(avatarVrm, profile, { srcHipsHeight, restFrame })
  ret.setMotion(motion)
  return ret
}

function applyProfileFrame(f) {
  if (!profileRetargeter) return
  const snap = profileRetargeter.applyFrame(f)
  if (!snap) { profileSnapshot.quat = {}; return }
  profileSnapshot.quat = snap.quat
  profileSnapshot.hipsPos.copy(snap.hipsPos)
}

// ── Reference retarget (hardcoded SomaVrmRetargeter) ──────────────────
function buildRefRetargeter() {
  if (!avatarVrm || !motion) return null
  const m = {
    skeleton: motion.skeleton, fps: motion.fps,
    joints: motion.joints,
    parents: motion.parentIdx.map(p => p < 0 ? null : motion.joints[p]),
    global_rot_mats: motion.rot,
    root_positions: motion.root,
    foot_contacts: motion.contacts,
  }
  // Forward UI parameters so both retargeters stay in sync (F-002)
  try {
    return new SomaVrmRetargeter(avatarVrm, m, {
      srcHipsHeight: parseFloat($('hipHeightSlider').value),
      restFrame: parseInt($('restFrameInput').value) || 0,
    })
  }
  catch (e) { console.warn('ref retargeter:', e); return null }
}

function applyRefFrame(f) { refRetargeter?.applyFrame(f) }

// ── Compare ───────────────────────────────────────────────────────────
function compareRetarget() {
  if (!profileRetargeter || !refRetargeter || !avatarVrm) return null
  avatarVrm.scene.updateMatrixWorld(true)
  const qInv = new THREE.Quaternion()
  avatarVrm.scene.getWorldQuaternion(qInv).invert()
  const qRef = new THREE.Quaternion()
  const results = []
  for (const bone of profile.solve_order) {
    const node = avatarVrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    // Profile-driven: from snapshot (F-001 fix — independent of VRM overwrite)
    const snapQ = profileSnapshot.quat[bone]
    if (!snapQ) continue
    // Reference: read from the VRM bone as set by applyRefFrame
    node.getWorldQuaternion(qRef).premultiply(qInv)
    const dot = Math.abs(snapQ.dot(qRef))
    const angleDeg = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI
    results.push({ bone, angleDeg })
  }
  return results
}

// ── Validate ──────────────────────────────────────────────────────────
async function validate() {
  if (!avatarVrm || !motion) { setStatus('Need avatar + motion'); return }
  avatarVrm.scene.position.x = 0
  profileRetargeter = buildProfileRetargeter()
  refRetargeter = buildRefRetargeter()
  if (!profileRetargeter || !refRetargeter) { setStatus('Retargeter failed'); return }

  setStatus('Validating…')
  const samples = [0, 1, Math.floor(motion.T / 4), Math.floor(motion.T / 2), motion.T - 1]
  let all = []
  for (const f of samples) {
    applyProfileFrame(f)
    applyRefFrame(f)
    const cmp = compareRetarget()
    if (cmp) all.push(...cmp)
  }
  const maxErr = Math.max(...all.map(r => r.angleDeg))
  const meanErr = all.reduce((s, r) => s + r.angleDeg, 0) / all.length
  const pass = maxErr < 1.0
  const tag = `<span class="tag tag-${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span>`
  const worst = [...all].sort((a, b) => b.angleDeg - a.angleDeg).slice(0, 5)

  $('validationTable').innerHTML =
    `<div style="margin-bottom:6px">${tag} max ${maxErr.toFixed(4)}° · mean ${meanErr.toFixed(4)}°</div>` +
    `<table><tr><th>bone</th><th>error (°)</th></tr>` +
    worst.map(r => `<tr><td>${r.bone}</td><td>${r.angleDeg.toFixed(4)}</td></tr>`).join('') +
    `</table>`
  $('validationResult').innerHTML = tag
  setStatus(`${pass ? 'PASS' : 'FAIL'} max ${maxErr.toFixed(4)}° (${samples.length} frames)`)
  avatarVrm.scene.position.x = 0.7
}

// ── Export ────────────────────────────────────────────────────────────
async function exportProfile() {
  if (!profile) { setStatus('No profile to export'); return }
  const out = JSON.parse(JSON.stringify(profile))

  // Update runtime parameters from UI
  out.rest_pose.default_src_hips_height_m = parseFloat($('hipHeightSlider').value)
  out.rest_pose.rest_frame_default = parseInt($('restFrameInput').value) || 0
  out.meta.calibrated_at = new Date().toISOString().split('T')[0]

  // If validation was run, include results
  const vTag = $('validationResult').textContent
  if (vTag) out.meta.last_validation = vTag

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${profile.meta.avatar_name.toLowerCase().replace(/\s+/g, '-')}.calibration.json`
  a.click()
  URL.revokeObjectURL(url)
  setStatus('Profile exported')
}

$('exportBtn').onclick = exportProfile

// ── Helpers ───────────────────────────────────────────────────────────
async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

function setStatus(msg) { $('status').textContent = msg; $('statusBar').textContent = msg }

// ── Animation tick ────────────────────────────────────────────────────
let lastFrame = -1

function tick(time) {
  requestAnimationFrame(tick)
  if (playing && motion && frame < motion.T - 1) {
    frame++
    $('scrub').value = frame
    $('frameLabel').textContent = `${frame}/${motion.T - 1}`
    updateSkeletonFrame()
    if (frame >= motion.T - 1) { playing = false; $('playBtn').textContent = '▶ play' }
  }
  controls.update()
  renderer.render(scene, camera)
}

// ── Bootstrap ─────────────────────────────────────────────────────────
async function boot() {
  try {
    const manifest = await fetchJson('../debug/data/manifest.json')
    captureList = manifest.captures
    const sel = $('captureSel')
    for (const c of captureList) {
      const opt = document.createElement('option')
      opt.value = c.id; opt.textContent = c.id; sel.appendChild(opt)
    }
  } catch (e) { console.warn('no manifest', e) }

  await loadProfile(params.get('profile') ?? 'calibration-profiles/tai-embodiment-v3.json')

  const wantCap = params.get('capture') ?? (captureList.length ? captureList[0].id : null)
  if (wantCap) {
    $('captureSel').value = wantCap
    await loadCapture(wantCap)
  }

  if (profile?.meta?.asset_path) {
    try { await loadAvatar(profile.meta.asset_path) }
    catch (e) { console.warn('auto-load avatar failed', e) }
  }

  $('captureSel').onchange = () => loadCapture($('captureSel').value)
  $('profileSel').onchange = () => loadProfile($('profileSel').value)
  $('validateBtn').onclick = validate

  $('loadAvatarBtn').onclick = () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.vrm,.glb,.gltf'
    input.onchange = async () => {
      if (input.files[0]) await loadAvatar(URL.createObjectURL(input.files[0]))
    }
    input.click()
  }

  tick()
  setStatus('ready')
}

boot().catch(e => setStatus(`Error: ${e.message}`))
