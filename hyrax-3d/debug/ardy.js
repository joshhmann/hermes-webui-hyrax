// ardy.js — ARDY debug view for the Synthesis Loft.
// Three views over a converted capture JSON (npz_to_json.py output):
//   1. capture player   — Core27 stick skeleton + root trajectory, fps-accurate
//   2. retarget compare — same frame on the ARDY skeleton and tai's VRM
//                         (SomaVrmRetargeter), per-bone angular error overlay
//   3. contract inspector — joints/parents/rest offsets + capture metadata
// No build step: plain ES modules via the importmap in ardy.html.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { SomaVrmRetargeter, BONE_MAPS } from '/api/hyrax/3d/REsearch/kimodo-vrm-pipeline/SomaVrmRetargeter.js'
import { AvatarRetargeter } from '/api/hyrax/3d/calibrate/AvatarRetargeter.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)

// ── error overlay thresholds (degrees) ──────────────────────────────
const COL_OK = new THREE.Color(0x2ecc71)   // < 5°
const COL_WARN = new THREE.Color(0xf1c40f) // < 15°
const COL_BAD = new THREE.Color(0xe74c3c)  // ≥ 15°
const COL_IDLE = new THREE.Color(0x58a6ff) // player mode / unmapped joints
function errColor(deg) {
  if (deg < 5) return COL_OK
  if (deg < 15) return COL_WARN
  return COL_BAD
}

// ── three.js scene ───────────────────────────────────────────────────
const view = $('view')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(devicePixelRatio)
view.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0d1117)
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
camera.position.set(1.8, 1.6, 2.6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.9, 0)
scene.add(new THREE.HemisphereLight(0xc9d1d9, 0x30363d, 1.1))
const dir = new THREE.DirectionalLight(0xffffff, 1.4)
dir.position.set(2, 4, 3)
scene.add(dir)
scene.add(new THREE.GridHelper(6, 12, 0x30363d, 0x21262d))

function resize() {
  const w = view.clientWidth, h = view.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
new ResizeObserver(resize).observe(view)

// ── capture data model ───────────────────────────────────────────────
// Concatenated from one or more chunk JSONs (npz_to_json.py cskel27 output).
let motion = null // {fps,joints,parentIdx,offsets,rot,root,contacts,timestamps,T,chunkBounds,meta,sources}
let frame = 0
let playing = false
let playTime = 0

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.json()
}

function concatChunks(chunks, sources) {
  const c0 = chunks[0]
  if (!c0.rest_offsets_m) {
    throw new Error('motion JSON has no rest_offsets_m — re-convert with the current npz_to_json.py (FK needs them)')
  }
  const nameIdx = Object.fromEntries(c0.joints.map((n, i) => [n, i]))
  const parentIdx = c0.parents.map((p) => (p === null ? -1 : nameIdx[p]))
  const out = {
    skeleton: c0.skeleton,
    fps: c0.fps,
    joints: c0.joints,
    parentIdx,
    offsets: c0.rest_offsets_m,
    rot: [], root: [], contacts: [], timestamps: [],
    chunkBounds: [], meta: c0.meta ?? {}, sources,
  }
  for (const c of chunks) {
    if (c.joints.join() !== c0.joints.join()) throw new Error('chunk joint order mismatch')
    if (c.fps !== c0.fps) throw new Error('chunk fps mismatch')
    out.chunkBounds.push(out.rot.length)
    out.rot.push(...c.global_rot_mats)
    out.root.push(...c.root_positions)
    out.contacts.push(...c.foot_contacts)
    if (c.timestamps) out.timestamps.push(...c.timestamps)
  }
  out.chunkBounds.push(out.rot.length)
  out.T = out.rot.length
  return out
}

async function loadCapture(entry) {
  setStatus(`loading ${entry.id}…`)
  const chunks = []
  for (const f of entry.chunks) chunks.push(await fetchJson(`data/${f}`))
  motion = concatChunks(chunks, entry.chunks)
  afterMotionLoad(`${entry.id} — ${entry.prompt ?? ''}`)
}

async function loadMotionFiles(files) {
  const chunks = []
  for (const f of files) chunks.push(JSON.parse(await f.text()))
  motion = concatChunks(chunks, files.map((f) => f.name))
  afterMotionLoad(`file: ${files.map((f) => f.name).join(', ')}`)
}

function afterMotionLoad(label) {
  frame = 0
  playTime = 0
  playing = false
  $('playBtn').textContent = '▶ play'
  $('scrub').max = motion.T - 1
  buildSkeleton()
  buildTrajectory()
  fillInspector(label)
  if (vrm) rebuildRetargeter()
  setFrame(0)
  setStatus(`${label} | T=${motion.T} fps=${motion.fps} (${(motion.T / motion.fps).toFixed(2)} s)`)
}

// FK: p_0 = root; p_j = p_parent + R_parent @ offset_j. R row-major 9 floats.
// Same convention the converter was validated against (posed_joints < 0.002 mm).
let _pos = null
function fkPositions(f) {
  const J = motion.joints.length
  if (!_pos || _pos.length < J * 3) _pos = new Float32Array(J * 3)
  const { parentIdx, offsets, rot, root } = motion
  _pos[0] = root[f][0]; _pos[1] = root[f][1]; _pos[2] = root[f][2]
  for (let j = 1; j < parentIdx.length; j += 1) {
    const p = parentIdx[j]
    const m = rot[f][p]
    const o = offsets[j]
    const px = _pos[p * 3], py = _pos[p * 3 + 1], pz = _pos[p * 3 + 2]
    _pos[j * 3] = px + m[0] * o[0] + m[1] * o[1] + m[2] * o[2]
    _pos[j * 3 + 1] = py + m[3] * o[0] + m[4] * o[1] + m[5] * o[2]
    _pos[j * 3 + 2] = pz + m[6] * o[0] + m[7] * o[1] + m[8] * o[2]
  }
  return _pos
}

// ── stick skeleton (bones = colored line segments, joints = instanced spheres)
const skelGroup = new THREE.Group()
scene.add(skelGroup)
let boneLines = null
let jointSpheres = null
let boneJoint = [] // joint index per bone segment

function buildSkeleton() {
  skelGroup.clear()
  const J = motion.joints.length
  boneJoint = []
  for (let j = 1; j < J; j += 1) boneJoint.push(j)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(boneJoint.length * 6), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(boneJoint.length * 6), 3))
  boneLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
  boneLines.frustumCulled = false
  skelGroup.add(boneLines)
  jointSpheres = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.016, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }), J)
  jointSpheres.frustumCulled = false
  skelGroup.add(jointSpheres)
}

// Root trajectory line + current-frame marker.
let trajLine = null
let trajMarker = null
function buildTrajectory() {
  if (trajLine) { skelGroup.remove(trajLine); trajLine.geometry.dispose() }
  const pts = motion.root.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
  trajLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x8b949e, transparent: true, opacity: 0.7 }))
  skelGroup.add(trajLine)
  if (!trajMarker) {
    trajMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xd2a8ff }))
    skelGroup.add(trajMarker)
  }
}

// ── retarget compare ─────────────────────────────────────────────────
let vrm = null
let retargeter = null
let profile = null  // loaded calibration profile (optional — when set, use AvatarRetargeter)
let profileAvatars = {}  // loaded VRM scenes keyed by profile name
let vrmMarkers = null // InstancedMesh over mapped bones
let mappedBones = []  // [{bone, joint, node, jointIdx}]
let restClip = null   // parsed T-pose chunk JSON — the TRUE source rest reference
let vrmYawFlip = false // VRM 0.x: normalized rig faces −Z in scene-local space
let cmpMotion = null  // exact object handed to the retargeter (post-conjugation)
let cmpRest = null    // rest reference handed to the retargeter constructor
const COMPARE_DX = 0.75 // skeleton at -dx, VRM at +dx

// VRM 0.x rig facing fix. SomaVrmRetargeter was written for VRM 1.0 (+Z
// forward). A 0.x normalized rig faces −Z in scene-local space (rotateVRM0
// only fixes the PARENT frame), so raw world-space deltas come out mirrored
// about the vertical axis (arms-down reads as arms-up). Conjugate every
// source rotation by yaw-180 (R' = Y·R·Yᵀ, Y = diag(−1,1,−1)) and rotate
// root positions the same way; the rotateVRM0 scene rotation then cancels
// the flip visually and the VRM tracks the source exactly.
function conjugateClipY180(m) {
  return {
    ...m,
    global_rot_mats: m.global_rot_mats.map((frame) => frame.map((r) => [
      r[0], -r[1], r[2],
      -r[3], r[4], -r[5],
      r[6], -r[7], r[8],
    ])),
    root_positions: m.root_positions.map((p) => [-p[0], p[1], -p[2]]),
  }
}

async function loadVrm(urlOrFile) {
  setStatus('loading VRM…')
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = urlOrFile instanceof File
    ? await loader.parseAsync(await urlOrFile.arrayBuffer(), '')
    : await loader.loadAsync(urlOrFile)
  const loaded = gltf.userData.vrm
  if (!loaded) throw new Error('not a VRM file')
  if (loaded.meta?.metaVersion === '0') VRMUtils.rotateVRM0(loaded)
  if (vrm) scene.remove(vrm.scene)
  vrm = loaded
  vrmYawFlip = loaded.meta?.metaVersion === '0'
  vrm.scene.position.x = COMPARE_DX
  scene.add(vrm.scene)
  if (motion) rebuildRetargeter()
  setStatus(`VRM loaded: ${loaded.meta?.name ?? urlOrFile} (metaVersion ${loaded.meta?.metaVersion ?? '?'})`)
}

// Source rest reference: the SETTLED T-pose from capture-tpose (frame ~10+;
// frame 0 of any capture is a ramp-in artifact — never a rest pose). The
// retargeter measures its offsets there, then its motion handle is swapped
// to the clip being played. Falls back to a frame of the current clip when
// no T-pose chunk is available (custom file loads).
function restFrameIndex() {
  const n = Number($('restFrame').value) || 0
  const max = restClip ? restClip.global_rot_mats.length - 1 : (motion ? motion.T - 1 : 0)
  return Math.min(Math.max(0, n), max)
}

function rebuildRetargeter() {
  const rf = restFrameIndex()
  const played = motionJsonForRetargeter()
  cmpMotion = vrmYawFlip ? conjugateClipY180(played) : played

  if (profile) {
    // Profiled path: use AvatarRetargeter
    const srcHipsHeight = profile.rest_pose?.default_src_hips_height_m ?? 0.954
    retargeter = new AvatarRetargeter(vrm, profile, { restFrame: rf, srcHipsHeight })
    retargeter.setMotion(cmpMotion)
  } else {
    // Hardcoded path: use SomaVrmRetargeter (existing behaviour)
    const sameSkel = restClip && restClip.skeleton === motion.skeleton
    cmpRest = sameSkel ? (vrmYawFlip ? conjugateClipY180(restClip) : restClip) : null
    _restJointIdx.clear()
    if (cmpRest) {
      retargeter = new SomaVrmRetargeter(vrm, cmpRest, { restFrame: rf })
      retargeter.motion = cmpMotion
    } else {
      retargeter = new SomaVrmRetargeter(vrm, cmpMotion, { restFrame: rf })
    }
  }

  const map = profile ? Object.values(profile.skeleton_maps).find(v => typeof v === 'object')
                       : BONE_MAPS[motion.skeleton]
  const jointIdx = Object.fromEntries(motion.joints.map((n, i) => [n, i]))
  mappedBones = []
  for (const [bone, joint] of Object.entries(map)) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (node) mappedBones.push({ bone, joint, node, jointIdx: jointIdx[joint] })
  }
  if (vrmMarkers) scene.remove(vrmMarkers)
  vrmMarkers = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.02, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }), mappedBones.length)
  vrmMarkers.frustumCulled = false
  scene.add(vrmMarkers)
}

// SomaVrmRetargeter consumes the single-chunk JSON shape; hand it a view of
// the concatenated motion with the same keys.
function motionJsonForRetargeter() {
  return {
    skeleton: motion.skeleton,
    fps: motion.fps,
    joints: motion.joints,
    parents: motion.parentIdx.map((p) => (p < 0 ? null : motion.joints[p])),
    global_rot_mats: motion.rot,
    root_positions: motion.root,
    foot_contacts: motion.contacts,
  }
}

const _m4 = new THREE.Matrix4()
const _qSrc = new THREE.Quaternion()
const _qSrcRest = new THREE.Quaternion()
const _qDelta = new THREE.Quaternion()
const _qVrm = new THREE.Quaternion()
const _qSceneInv = new THREE.Quaternion()
const _v3 = new THREE.Vector3()
const _qErr = new THREE.Quaternion()

function srcWorldQuat(f, jointIdx, out) {
  const m = (cmpMotion ?? motionJsonForRetargeter()).global_rot_mats[f][jointIdx]
  _m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
  return out.setFromRotationMatrix(_m4)
}

// Rest quat from the same reference the retargeter measured against.
const _restJointIdx = new Map()
function srcRestQuat(jointName, out) {
  const rf = restFrameIndex()
  if (cmpRest) {
    if (_restJointIdx.size === 0) cmpRest.joints.forEach((n, i) => _restJointIdx.set(n, i))
    const m = cmpRest.global_rot_mats[rf][_restJointIdx.get(jointName)]
    _m4.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
    return out.setFromRotationMatrix(_m4)
  }
  return srcWorldQuat(rf, motion.joints.indexOf(jointName), out)
}

// Per-bone angular error: |angle( W_vrm⁻¹ ⊗ (W_src(t) ⊗ W_src(rest)⁻¹) )|.
// The retargeter's stated goal is W_vrm == src delta-from-rest, so any
// divergence here is retarget error (missing bones, bad map, calibration).
function computeErrors(f) {
  const errs = new Map()
  vrm.scene.updateMatrixWorld(true)
  // Compare in the VRM-scene frame: VRMUtils.rotateVRM0 puts a 180° yaw on
  // vrm.scene for 0.x models — strip it or every bone reads a spurious 180°.
  vrm.scene.getWorldQuaternion(_qSceneInv).invert()
  for (const mb of mappedBones) {
    srcWorldQuat(f, mb.jointIdx, _qSrc)
    srcRestQuat(mb.joint, _qSrcRest)
    _qDelta.copy(_qSrc).multiply(_qSrcRest.invert())
    mb.node.getWorldQuaternion(_qVrm).premultiply(_qSceneInv)
    _qErr.copy(_qVrm).invert().multiply(_qDelta)
    const deg = 2 * Math.acos(Math.min(1, Math.abs(_qErr.w))) * 180 / Math.PI
    errs.set(mb.joint, deg)
    mb.err = deg
  }
  return errs
}

// ── per-frame update ─────────────────────────────────────────────────
function setFrame(f) {
  if (!motion) return
  frame = Math.min(Math.max(0, f), motion.T - 1)
  playTime = frame / motion.fps
  const compare = $('modeSel').value === 'compare' && retargeter

  const pos = fkPositions(frame)
  const pAttr = boneLines.geometry.getAttribute('position')
  const cAttr = boneLines.geometry.getAttribute('color')

  let errs = null
  if (compare) {
    retargeter.applyFrame(frame)
    errs = computeErrors(frame)
  }

  // skeleton bones + joints, colored by mode
  const m4 = new THREE.Matrix4()
  for (let i = 0; i < boneJoint.length; i += 1) {
    const j = boneJoint[i]
    const p = motion.parentIdx[j]
    pAttr.setXYZ(i * 2, pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2])
    pAttr.setXYZ(i * 2 + 1, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2])
    const name = motion.joints[j]
    const col = compare && errs.has(name) ? errColor(errs.get(name)) : COL_IDLE
    cAttr.setXYZ(i * 2, col.r, col.g, col.b)
    cAttr.setXYZ(i * 2 + 1, col.r, col.g, col.b)
  }
  pAttr.needsUpdate = true
  cAttr.needsUpdate = true
  for (let j = 0; j < motion.joints.length; j += 1) {
    m4.makeTranslation(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2])
    jointSpheres.setMatrixAt(j, m4)
    const name = motion.joints[j]
    jointSpheres.setColorAt(j, compare && errs.has(name) ? errColor(errs.get(name)) : COL_IDLE)
  }
  jointSpheres.instanceMatrix.needsUpdate = true
  if (jointSpheres.instanceColor) jointSpheres.instanceColor.needsUpdate = true

  // VRM error markers
  if (compare && vrmMarkers) {
    for (let i = 0; i < mappedBones.length; i += 1) {
      const mb = mappedBones[i]
      mb.node.getWorldPosition(_v3)
      m4.makeTranslation(_v3.x, _v3.y, _v3.z)
      vrmMarkers.setMatrixAt(i, m4)
      vrmMarkers.setColorAt(i, errColor(mb.err ?? 0))
    }
    vrmMarkers.instanceMatrix.needsUpdate = true
    if (vrmMarkers.instanceColor) vrmMarkers.instanceColor.needsUpdate = true
  }

  // trajectory marker
  const rp = motion.root[frame]
  trajMarker.position.set(rp[0], rp[1], rp[2])

  // layout: side-by-side in compare, centered in player
  skelGroup.position.x = compare ? -COMPARE_DX : 0
  if (vrm) vrm.scene.visible = compare

  updateReadout(errs)
  $('scrub').value = frame
  $('frameLabel').textContent = `${frame}/${motion.T - 1}`
}

function updateReadout(errs) {
  const f = frame
  const rp = motion.root[f]
  const m = motion.rot[f][0] // hips global, row-major; forward = R @ +Z
  const yaw = Math.atan2(m[2], m[8]) * 180 / Math.PI
  const c = motion.contacts[f]
  const flag = (on, label) => `<span class="${on > 0.5 ? 'on' : 'off'}">${label}</span>`
  const ts = motion.timestamps.length ? motion.timestamps[f].toFixed(2) : (f / motion.fps).toFixed(2)
  let chunk = 0
  for (let i = 0; i < motion.chunkBounds.length - 1; i += 1) {
    if (f >= motion.chunkBounds[i] && f < motion.chunkBounds[i + 1]) chunk = i
  }
  let errHtml = ''
  if (errs) {
    const vals = mappedBones.map((mb) => mb.err ?? 0)
    const max = Math.max(...vals)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const worst = [...mappedBones].sort((a, b) => (b.err ?? 0) - (a.err ?? 0)).slice(0, 3)
    errHtml = `<h2>Retarget error</h2>` +
      `<div>rest ref: ${restClip ? `tpose f${restFrameIndex()} (settled T-pose)` : `this clip f${restFrameIndex()}`}</div>` +
      `<div>max ${max.toFixed(1)}° · mean ${mean.toFixed(1)}°</div>` +
      worst.map((mb) =>
        `<div><span class="sw" style="background:#${errColor(mb.err ?? 0).getHexString()}"></span>` +
        `${mb.bone} ← ${mb.joint}: ${(mb.err ?? 0).toFixed(1)}°</div>`).join('') +
      `<div style="margin-top:4px"><span class="sw" style="background:#2ecc71"></span>&lt;5° ` +
      `<span class="sw" style="background:#f1c40f"></span>&lt;15° ` +
      `<span class="sw" style="background:#e74c3c"></span>≥15°</div>`
  }
  $('liveReadout').innerHTML =
    `<h2>Frame</h2><table>` +
    `<tr><td>frame</td><td>${f} / ${motion.T - 1} (chunk ${chunk})</td></tr>` +
    `<tr><td>timestamp</td><td>${ts} s</td></tr>` +
    `<tr><td>root pos</td><td>${rp.map((v) => v.toFixed(3)).join(', ')}</td></tr>` +
    `<tr><td>root yaw</td><td>${yaw.toFixed(1)}°</td></tr>` +
    `<tr><td>contacts</td><td>${flag(c[0], 'L-heel')} ${flag(c[1], 'L-toe')} ` +
    `${flag(c[2], 'R-heel')} ${flag(c[3], 'R-toe')}</td></tr>` +
    `</table>` + errHtml
}

// ── contract inspector ───────────────────────────────────────────────
function fillInspector(label) {
  const rows = motion.joints.map((n, j) => {
    const p = motion.parentIdx[j]
    const o = motion.offsets[j]
    return `<tr><td>${j}</td><td>${n}</td><td>${p < 0 ? '—' : motion.joints[p]}</td>` +
      `<td>${o.map((v) => v.toFixed(4)).join(', ')}</td></tr>`
  }).join('')
  const dur = (motion.T / motion.fps).toFixed(2)
  const ts = motion.timestamps.length
    ? `${motion.timestamps[0].toFixed(2)} … ${motion.timestamps[motion.T - 1].toFixed(2)} s`
    : '—'
  const meta = motion.meta
  $('panel').innerHTML =
    `<div id="liveReadout"></div>` +
    `<h2>Capture metadata</h2><table>` +
    `<tr><td>source</td><td>${label}</td></tr>` +
    `<tr><td>files</td><td>${motion.sources.join('<br>')}</td></tr>` +
    `<tr><td>skeleton</td><td>${motion.skeleton}</td></tr>` +
    `<tr><td>fps</td><td>${motion.fps}</td></tr>` +
    `<tr><td>frames</td><td>${motion.T} (${dur} s)</td></tr>` +
    `<tr><td>timestamps</td><td>${ts}</td></tr>` +
    `<tr><td>npz keys</td><td>${(meta.npz_keys ?? []).join(', ') || '—'}</td></tr>` +
    `<tr><td>quats</td><td>${meta.quat_convention ?? '—'}</td></tr>` +
    `<tr><td>contacts</td><td>${meta.contact_encoding ?? '—'}</td></tr>` +
    `<tr><td>coord frame</td><td>${meta.coord_frame ?? '—'}</td></tr>` +
    `</table>` +
    `<h2>Skeleton contract (${motion.joints.length} joints)</h2>` +
    `<table><tr><th>#</th><th>joint</th><th>parent</th><th>rest offset (m)</th></tr>${rows}</table>`
}

// ── transport ────────────────────────────────────────────────────────
$('playBtn').onclick = () => {
  if (!motion) return
  playing = !playing
  if (playing && frame >= motion.T - 1) { frame = 0; playTime = 0 }
  $('playBtn').textContent = playing ? '⏸ pause' : '▶ play'
}
$('prevBtn').onclick = () => { playing = false; $('playBtn').textContent = '▶ play'; setFrame(frame - 1) }
$('nextBtn').onclick = () => { playing = false; $('playBtn').textContent = '▶ play'; setFrame(frame + 1) }
$('scrub').oninput = () => {
  playing = false
  $('playBtn').textContent = '▶ play'
  if (retargeter) retargeter.onReset() // drop ground-correction state on seeks
  setFrame(Number($('scrub').value))
}
$('modeSel').onchange = () => setFrame(frame)
$('restFrame').onchange = () => { if (vrm && motion) { rebuildRetargeter(); setFrame(frame) } }
$('motionFile').onchange = (e) => {
  if (e.target.files.length) loadMotionFiles([...e.target.files]).catch(showErr)
}
$('vrmFile').onchange = (e) => {
  if (e.target.files[0]) loadVrm(e.target.files[0]).catch(showErr)
}

let lastT = performance.now()
function tick(now) {
  requestAnimationFrame(tick)
  const dt = Math.min(0.1, (now - lastT) / 1000)
  lastT = now
  if (motion && playing) {
    playTime += dt
    let f = Math.floor(playTime * motion.fps)
    if (f >= motion.T) {
      if ($('loopChk').checked) { playTime = 0; f = 0 }
      else { f = motion.T - 1; playing = false; $('playBtn').textContent = '▶ play' }
    }
    if (f !== frame) setFrame(f)
  }
  controls.update()
  renderer.render(scene, camera)
}

// ── boot ─────────────────────────────────────────────────────────────
function setStatus(s) { $('status').textContent = s }
function showErr(e) {
  console.error(e)
  $('err').textContent = String(e?.message ?? e)
  setTimeout(() => { $('err').textContent = '' }, 8000)
}

// Debug/E2E handle (mirrors the loft's window.__ardy convention).
window.__ardyDebug = {
  get vrm() { return vrm },
  get motion() { return motion },
  get retargeter() { return retargeter },
  get frame() { return frame },
  setFrame,
}

async function boot() {
  resize()
  requestAnimationFrame(tick)
  const manifest = await fetchJson('data/manifest.json')
  const sel = $('captureSel')
  for (const c of manifest.captures) {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.id
    sel.appendChild(opt)
  }
  sel.onchange = () => {
    const entry = manifest.captures.find((c) => c.id === sel.value)
    loadCapture(entry).catch(showErr)
  }
  if (params.get('mode')) $('modeSel').value = params.get('mode')
  const want = params.get('capture') ?? manifest.captures[0].id
  sel.value = want

  // T-pose reference clip for retarget rest measurement (settled frames only).
  const tpose = manifest.captures.find((c) => c.id === 'capture-tpose')
  if (tpose) {
    try {
      restClip = await fetchJson(`data/${tpose.chunks[0]}`)
    } catch (e) {
      console.warn('[ardy-debug] no tpose rest clip; rest falls back to the played clip', e)
    }
  }

  // Profile selector: populate from calibrate profiles dir
  const profileSel = $('profileSel')
  try {
    const profileIndex = await fetchJson('../calibrate/calibration-profiles.json')
    for (const p of profileIndex.profiles) {
      const opt = document.createElement('option')
      opt.value = `../calibrate/${p.path}`
      opt.textContent = p.name
      profileSel.appendChild(opt)
    }
  } catch (e) {
    console.warn('[ardy-debug] no profile index; fallback to hardcoded', e)
    const known = ['../calibrate/calibration-profiles/tai-embodiment-v3.json']
    for (const k of known) {
      const opt = document.createElement('option')
      opt.value = k; opt.textContent = 'Tai Embodiment v3 (baseline)'
      profileSel.appendChild(opt)
    }
  }
  profileSel.onchange = async () => {
    const val = profileSel.value
    if (!val) { profile = null; rebuildRetargeter(); setFrame(frame); return }
    try {
      profile = await fetchJson(val)
      rebuildRetargeter()
      setFrame(frame)
      setStatus(`profile: ${profile.meta?.avatar_name ?? val}`)
    } catch (e) {
      profile = null
      showErr(`profile load failed: ${val} — ${e?.message ?? e}`)
    }
  }

  await loadCapture(manifest.captures.find((c) => c.id === want) ?? manifest.captures[0])

  // VRM: ?vrm= → WebUI asset route (needs the WebUI server + auth) → local
  // repo copy. No probe — TRY the load directly; failed candidates fall
  // through to the next URL. File picker as fallback.
  const candidates = [
    params.get('vrm'),
    '/api/hyrax/assets/tai.embodiment.vrm',
    '../../hyrax-assets/embodiment/tai.embodiment.vrm',
  ].filter(Boolean)
  for (const url of candidates) {
    try {
      await loadVrm(url)
      break
    } catch (e) {
      console.warn(`[ardy-debug] VRM candidate failed: ${url}`, e)
    }
  }
  if (!vrm) setStatus(`${$('status').textContent} | no VRM reachable — use the VRM file picker for compare mode`)
  setFrame(0)
}

boot().catch(showErr)
