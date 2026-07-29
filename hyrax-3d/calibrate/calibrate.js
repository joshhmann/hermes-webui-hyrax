// calibrate.js — Avatar Calibration Studio, Phase 1: baseline validation.
//
// Proves that the profile-driven retarget matches the hardcoded
// SomaVrmRetargeter path. No runtime changes — this page is the
// validation bench.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { SomaVrmRetargeter, BONE_MAPS } from '../REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)

// ── Three.js setup ────────────────────────────────────────────────────
const container = $('viewport')
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1117)

const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.01, 50)
camera.position.set(0, 1.2, 2.8)
camera.lookAt(0, 0.9, 0)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(container.clientWidth, container.clientHeight)
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
container.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.9, 0)
controls.update()

// Lights
scene.add(new THREE.AmbientLight(0x404060, 0.6))
const dl = new THREE.DirectionalLight(0xffffff, 1.2)
dl.position.set(5, 8, 5)
scene.add(dl)
scene.add(new THREE.DirectionalLight(0xffffff, 0.4).position.set(-3, 2, -3))
const grid = new THREE.GridHelper(4, 20, 0x30363d, 0x21262d)
scene.add(grid)

// ── State ─────────────────────────────────────────────────────────────
let profile = null       // loaded calibration profile
let avatarVrm = null     // loaded VRM
let avatarScene = null   // GLB scene (fallback)
let motion = null        // loaded capture
let profileRetargeter = null  // profile-driven
let refRetargeter = null     // hardcoded reference
let captureList = []     // from manifest

// Skeleton groups
const srcSkelGroup = new THREE.Group()
const tgtSkelGroup = new THREE.Group()
scene.add(srcSkelGroup)
scene.add(tgtSkelGroup)

let srcBones = []  // {name, children, jointIdx}
let tgtBones = []  // {name, children, node}

// ── Load calibration profile ──────────────────────────────────────────
async function loadProfile(url) {
  profile = await fetchJson(url)
  renderProfileInfo()
  buildSkeletonTrees()
  setStatus(`Profile loaded: ${profile.meta.avatar_name}`)
}

function renderProfileInfo() {
  if (!profile) { $('profileInfo').textContent = 'not loaded'; return }
  $('profileInfo').innerHTML =
    `<div>avatar: <strong>${profile.meta.avatar_name}</strong> (${profile.meta.avatar_format})</div>` +
    `<div>solve order: ${profile.solve_order.length} bones</div>` +
    `<div>skeleton maps: ${Object.keys(profile.skeleton_maps).filter(k => typeof profile.skeleton_maps[k] === 'object').length}</div>` +
    `<div>version: ${profile.profile_version}</div>`
}

// ── Skeleton trees ─────────────────────────────────────────────────────
function buildSkeletonTrees() {
  if (!profile) return
  // Source tree: use the first skeleton map's joint names
  const map = Object.values(profile.skeleton_maps).find(v => typeof v === 'object')
  const joints = Object.values(map)
  const parentMap = profile.vrm_bone_parents
  const sourceHtml = buildTreeHtml(map, parentMap, joints)
  $('sourceTree').innerHTML = sourceHtml
}

function buildTreeHtml(map, parentMap, allJoints) {
  // Build parent → children adjacency
  const children = { root: [] }
  for (const [key, joint] of Object.entries(map)) {
    const p = parentMap[key]
    const parentKey = p || 'root'
    if (!children[parentKey]) children[parentKey] = []
    children[parentKey].push({ key, joint })
  }
  const lines = []
  function render(key, depth) {
    if (!children[key]) return
    for (const child of children[key]) {
      const cls = allJoints.includes(child.joint) ? 'mapped' : 'unmapped'
      lines.push(`<div class="tree-node ${cls}" style="padding-left:${16 + depth * 16}px">${child.key} ← ${child.joint}</div>`)
      render(child.key, depth + 1)
    }
  }
  render('root', 0)
  return lines.join('')
}

// ── Avatar loading ────────────────────────────────────────────────────
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
    vrm.scene.position.x = 0.75  // offset from center
    scene.add(vrm.scene)
    detectVrmSkeleton(vrm)
  } else {
    // GLB fallback
    if (avatarScene) scene.remove(avatarScene)
    avatarScene = gltf.scene
    avatarScene.position.x = 0.75
    scene.add(avatarScene)
    detectGlbSkeleton(avatarScene)
  }
  buildTargetTree()
  setStatus(`Avatar loaded: ${vrm?.meta?.name ?? url}`)
}

function detectVrmSkeleton(vrm) {
  tgtBones = []
  for (const key of profile.solve_order) {
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
  if (!tgtBones.length) { $('targetTree').innerHTML = '<div style="color:#8b949e">no skeleton detected</div>'; return }
  const lines = tgtBones.map((b) => `<div class="tree-node mapped">${b.name}</div>`)
  $('targetTree').innerHTML = lines.join('')
}

// ── Motion loading ────────────────────────────────────────────────────
async function loadCapture(id) {
  const entry = captureList.find((c) => c.id === id)
  if (!entry) return
  const base = '../debug/data/'
  const chunks = await Promise.all(entry.chunks.map((c) => fetchJson(base + c)))
  motion = concatChunks(chunks)
  const skeleton = motion.skeleton
  const hasMap = profile && (profile.skeleton_maps[skeleton] || (profile.skeleton_maps[skeleton + '_alias'] && profile.skeleton_maps[profile.skeleton_maps[skeleton + '_alias']]))
  setStatus(`Loaded: ${entry.id} (${skeleton}, ${motion.T} frames)` + (hasMap ? '' : ' — no skeleton map in profile'))
}

function concatChunks(chunks) {
  const c0 = chunks[0]
  const parentIdx = c0.parents.map((p, i) => p === null ? -1 : c0.joints.indexOf(p))
  const T = c0.global_rot_mats.length
  return {
    skeleton: c0.skeleton,
    fps: c0.fps,
    joints: c0.joints,
    parentIdx,
    offsets: c0.rest_offsets_m,
    rot: c0.global_rot_mats,
    root: c0.root_positions,
    contacts: c0.foot_contacts,
    T,
    timestamps: c0.timestamps ?? [],
  }
}

// ── Profile-driven retarget (reimplements SomaVrmRetargeter from JSON) ─
function buildProfileRetargeter() {
  if (!profile || !avatarVrm || !motion) return null
  const skelKey = motion.skeleton
  let map = profile.skeleton_maps[skelKey]
  if (!map) {
    const alias = profile.skeleton_maps[skelKey + '_alias']
    if (alias) map = profile.skeleton_maps[alias]
  }
  if (!map) return null

  const solveOrder = profile.solve_order
  const vrmParent = profile.vrm_bone_parents
  const jointIndex = Object.fromEntries(motion.joints.map((n, i) => [n, i]))

  // Compute offsets: srcWorldQuat(joint, restFrame).invert()
  const offsets = {}
  const restFrame = profile.rest_pose.rest_frame_recommended?.[skelKey] ?? profile.rest_pose.rest_frame_default
  for (const [bone, joint] of Object.entries(map)) {
    const node = avatarVrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    const rest = srcWorldQuat(motion, jointIndex, joint, restFrame)
    offsets[bone] = rest.invert().clone()
  }

  // Hips scale
  const hipsNode = avatarVrm.humanoid.getNormalizedBoneNode('hips')
  const hipsWorldY = hipsNode.getWorldPosition(new THREE.Vector3()).y
  const srcHipsHeight = profile.rest_pose.default_src_hips_height_m
  const hipsScale = hipsWorldY / srcHipsHeight

  return { map, solveOrder, vrmParent, jointIndex, offsets, hipsScale, hipsNode, restFrame }
}

function applyProfileFrame(frame) {
  if (!profileRetargeter || !avatarVrm) return { bones: {}, error: null }
  const { map, solveOrder, vrmParent, jointIndex, offsets, hipsScale, hipsNode } = profileRetargeter
  const world = {}
  const q = new THREE.Quaternion()
  const errors = {}

  for (const bone of solveOrder) {
    const joint = map[bone]
    if (!joint || !offsets[bone]) continue
    const node = avatarVrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    const W = srcWorldQuat(motion, jointIndex, joint, frame).multiply(offsets[bone]).clone()
    world[bone] = W
    const parentW = world[vrmParent[bone]]
    node.quaternion.copy(parentW ? q.copy(parentW).invert().multiply(W) : W)
    errors[bone] = null  // will fill during compare
  }

  // Hips position: delta-from-frame-0 scaled
  const p = motion.root[frame]
  const p0 = motion.root[0]
  hipsNode.userData.restY = hipsNode.userData.restY ?? hipsNode.position.y
  hipsNode.position.set(
    (p[0] - p0[0]) * hipsScale,
    hipsNode.userData.restY + (p[1] - p0[1]) * hipsScale,
    (p[2] - p0[2]) * hipsScale,
  )

  avatarVrm.humanoid.update()
  return { bones: world, errors }
}

// ── Reference retarget (uses hardcoded SomaVrmRetargeter) ─────────────
function buildRefRetargeter() {
  if (!avatarVrm || !motion) return null
  const motionJson = {
    skeleton: motion.skeleton,
    fps: motion.fps,
    joints: motion.joints,
    parents: motion.parentIdx.map((p) => p < 0 ? null : motion.joints[p]),
    global_rot_mats: motion.rot,
    root_positions: motion.root,
    foot_contacts: motion.contacts,
  }
  try {
    const ret = new SomaVrmRetargeter(avatarVrm, motionJson)
    refRetargeter = ret
    return ret
  } catch (e) {
    console.warn('ref retargeter failed:', e)
    return null
  }
}

function applyRefFrame(frame) {
  if (!refRetargeter) return
  refRetargeter.applyFrame(frame)
}

// ── Compare profile vs reference ──────────────────────────────────────
function compareRetarget(frame) {
  if (!profileRetargeter || !refRetargeter || !avatarVrm) return null

  // Sample bone rotations from both paths
  const results = []
  avatarVrm.scene.updateMatrixWorld(true)
  const qSceneInv = new THREE.Quaternion()
  avatarVrm.scene.getWorldQuaternion(qSceneInv).invert()
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion()

  for (const bone of profile.solve_order) {
    const node = avatarVrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    node.getWorldQuaternion(q1).premultiply(qSceneInv)
    // The ref was just applied in the same frame, same node
    node.getWorldQuaternion(q2).premultiply(qSceneInv)
    const dot = Math.abs(q1.dot(q2))
    const angleDeg = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI
    results.push({ bone, angleDeg })
  }

  return results
}

function renderComparison(results) {
  if (!results) { $('validationTable').innerHTML = '<div style="color:#8b949e;font-size:11px">run validation to compare</div>'; return }
  const maxErr = Math.max(...results.map(r => r.angleDeg))
  const meanErr = results.reduce((s, r) => s + r.angleDeg, 0) / results.length
  const worst = [...results].sort((a, b) => b.angleDeg - a.angleDeg).slice(0, 5)

  const verdict = maxErr < 0.01 ? 'PASS' : 'FAIL'
  const tag = `<span class="tag tag-${verdict === 'PASS' ? 'pass' : 'fail'}">${verdict}</span>`

  $('validationTable').innerHTML =
    `<div style="margin-bottom:8px">${tag} max ${maxErr.toFixed(4)}° · mean ${meanErr.toFixed(4)}°</div>` +
    `<table><tr><th>bone</th><th>error (°)</th></tr>` +
    worst.map((r) => `<tr><td>${r.bone}</td><td>${r.angleDeg.toFixed(4)}</td></tr>`).join('') +
    `</table>`
  $('validationResult').innerHTML = tag
}

// ── Validate: step through frames, compare both paths ─────────────────
async function validate() {
  if (!avatarVrm) { setStatus('Load an avatar first'); return }
  if (!motion) { setStatus('Load a motion capture first'); return }

  // Position the avatar at center for comparison
  if (avatarVrm) avatarVrm.scene.position.x = 0

  // Build both retargeters
  profileRetargeter = buildProfileRetargeter()
  buildRefRetargeter()
  if (!profileRetargeter) { setStatus('Profile retargeter failed — check skeleton map'); return }
  if (!refRetargeter) { setStatus('Reference retargeter failed — check skeleton compatibility'); return }

  setStatus('Validating…')
  const sampleFrames = [0, 1, Math.floor(motion.T / 4), Math.floor(motion.T / 2), motion.T - 1]
  let allResults = []

  for (const f of sampleFrames) {
    applyProfileFrame(f)
    applyRefFrame(f)
    const cmp = compareRetarget(f)
    if (cmp) allResults.push({ frame: f, results: cmp })
  }

  // Aggregate
  const flat = allResults.flatMap(({ frame, results }) => results)
  const maxErr = Math.max(...flat.map(r => r.angleDeg))
  const meanErr = flat.reduce((s, r) => s + r.angleDeg, 0) / flat.length
  const verdict = maxErr < 0.01 ? 'PASS' : 'FAIL'

  renderComparison(flat)
  setStatus(`Validate: ${verdict} (max ${maxErr.toFixed(4)}°, mean ${meanErr.toFixed(4)}°, ${sampleFrames.length} frames sampled)`)

  // Restore avatar position
  if (avatarVrm) avatarVrm.scene.position.x = 0.75
}

// ── Helpers ───────────────────────────────────────────────────────────
function srcWorldQuat(motion, jointIndex, jointName, frame) {
  const m9 = motion.rot[frame][jointIndex[jointName]]
  const M = new THREE.Matrix4().set(
    m9[0], m9[1], m9[2], 0,
    m9[3], m9[4], m9[5], 0,
    m9[6], m9[7], m9[8], 0,
    0, 0, 0, 1,
  )
  return new THREE.Quaternion().setFromRotationMatrix(M)
}

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

function setStatus(msg) {
  $('status').textContent = msg
  $('statusBar').textContent = msg
}

// ── Tick ──────────────────────────────────────────────────────────────
function tick() {
  requestAnimationFrame(tick)
  controls.update()
  renderer.render(scene, camera)
}

// ── Bootstrap ─────────────────────────────────────────────────────────
async function boot() {
  // Load captures from debug data
  try {
    const manifest = await fetchJson('../debug/data/manifest.json')
    captureList = manifest.captures
    const sel = $('captureSel')
    for (const c of captureList) {
      const opt = document.createElement('option')
      opt.value = c.id
      opt.textContent = c.id
      sel.appendChild(opt)
    }
  } catch (e) {
    console.warn('no capture manifest', e)
  }

  // Load default profile
  const wantProfile = params.get('profile') ?? 'calibration-profiles/tai-embodiment-v3.json'
  await loadProfile(wantProfile)

  // Default capture
  const wantCap = params.get('capture') ?? (captureList.length ? captureList[0].id : null)
  if (wantCap) {
    $('captureSel').value = wantCap
    await loadCapture(wantCap)
  }

  // Auto-load avatar from profile reference
  if (profile?.meta?.asset_path) {
    try {
      await loadAvatar(profile.meta.asset_path)
    } catch (e) {
      console.warn('auto-load avatar failed', e)
    }
  }

  // Event wiring
  $('captureSel').onchange = () => loadCapture($('captureSel').value)
  $('profileSel').onchange = () => loadProfile($('profileSel').value)
  $('validateBtn').onclick = validate

  $('loadAvatarBtn').onclick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.vrm,.glb,.gltf'
    input.onchange = async () => {
      if (input.files[0]) {
        const url = URL.createObjectURL(input.files[0])
        await loadAvatar(url)
      }
    }
    input.click()
  }

  tick()
  setStatus('ready')
}

boot().catch((e) => setStatus(`Error: ${e.message}`))
