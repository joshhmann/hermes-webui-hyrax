/**
 * Minimal fake THREE.js module for lifecycle testing.
 * Every constructable class tracks its `.disposed` state.
 * Scene tracks child objects for dispose enumeration.
 * Plain JS — loaded by Node --test via module loader hook.
 */

// ── Vector utilities ──────────────────────────────────────────────

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this }
  clone() { return new Vector3(this.x, this.y, this.z) }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this }
  addScaledVector(v, s) { return this.add(v.clone().multiplyScalar(s)) }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z }
  normalize() { const l = this.length(); if (l > 0) this.multiplyScalar(1 / l); return this }
  distanceTo(v) { return this.clone().sub(v).length() }
  distanceToSquared(v) { return this.clone().sub(v).lengthSq() }
  applyQuaternion(q) { return this }
  lerp(v, alpha) { this.x += (v.x - this.x) * alpha; this.y += (v.y - this.y) * alpha; this.z += (v.z - this.z) * alpha; return this }
  toArray() { return [this.x, this.y, this.z] }
}

export class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order }
  set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this }
  clone() { return new Euler(this.x, this.y, this.z, this.order) }
}

export class Quaternion {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1 }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this }
  setFromEuler(euler) { return this }
  clone() { const q = new Quaternion(); q.x = this.x; q.y = this.y; q.z = this.z; q.w = this.w; return q }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this }
  normalize() { return this }
  multiply(q) { return this }
  invert() { return this }
  slerp(q, t) { return this }
  toArray() { return [this.x, this.y, this.z, this.w] }
}

export class Color {
  constructor(color) {
    this._hex = 0
    if (typeof color === 'string') this.set(color)
    else if (color !== undefined) this._hex = color
  }
  set(color) { if (typeof color === 'number') this._hex = color; return this }
  clone() { return new Color(this._hex) }
  lerp(c, t) { return this }
  getHexString() { return this._hex.toString(16).padStart(6, '0') }
}

export class Box3 {
  constructor() {
    this.min = new Vector3(Infinity, Infinity, Infinity)
    this.max = new Vector3(-Infinity, -Infinity, -Infinity)
  }
  setFromObject(_object, _precise) { return this }
  getCenter(target) { target.set(0, 0.85, 0); return target }
  getSize(target) { target.set(0.6, 1.5, 0.4); return target }
}

export const MathUtils = {
  clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
  smoothstep: (t, a, b) => { const x = MathUtils.clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x) },
  degToRad: (d) => d * Math.PI / 180,
  lerp: (a, b, t) => a + (b - a) * t,
  SQRT2: Math.SQRT2,
}

// ── Base object ───────────────────────────────────────────────────

export class Object3D {
  constructor() {
    this.name = ''
    this.type = 'Object3D'
    this.uuid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
    this.parent = null
    this.children = []
    this.position = new Vector3()
    this.rotation = new Euler()
    this.quaternion = new Quaternion()
    this.scale = new Vector3(1, 1, 1)
    this.visible = true
  }

  add(...objects) {
    for (const obj of objects) { this.children.push(obj); obj.parent = this }
    return this
  }
  remove(object) {
    const idx = this.children.indexOf(object)
    if (idx !== -1) { this.children.splice(idx, 1); object.parent = null }
    return this
  }
  getObjectByName(name) {
    if (this.name === name) return this
    for (const child of this.children) { const found = child.getObjectByName(name); if (found) return found }
    return null
  }
  traverse(callback) {
    callback(this); for (const child of this.children) child.traverse(callback)
  }
  removeFromParent() { if (this.parent) this.parent.remove(this) }
  clone(recursive) { return new Object3D() }
  getWorldPosition(target) { target.copy(this.position); return target }
  getWorldQuaternion(target) { target.copy(this.quaternion); return target }
}

export class Group extends Object3D {
  constructor() { super(); this.type = 'Group' }
}

// ── Geometry classes ──────────────────────────────────────────────

class _Geometry {
  constructor() { this.name = ''; this.disposed = false }
  dispose() { this.disposed = true }
}

export class BoxGeometry extends _Geometry {
  constructor(width = 1, height = 1, depth = 1) { super(); this.width = width; this.height = height; this.depth = depth }
}
export class PlaneGeometry extends _Geometry {
  constructor(width = 1, height = 1) { super(); this.width = width; this.height = height }
}
export class CylinderGeometry extends _Geometry {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 8) { super(); this.radiusTop = radiusTop; this.radiusBottom = radiusBottom; this.height = height; this.radialSegments = radialSegments }
}
export class ConeGeometry extends _Geometry {
  constructor(radius = 1, height = 1, radialSegments = 8) { super(); this.radius = radius; this.height = height; this.radialSegments = radialSegments }
}

// ── Material classes ──────────────────────────────────────────────

export class Material {
  constructor() { this.name = ''; this.disposed = false }
  dispose() { this.disposed = true }
}

export class MeshStandardMaterial extends Material {
  constructor(params = {}) {
    super()
    this.color = params.color ? new Color(params.color) : new Color()
    this.roughness = params.roughness ?? 0.78
    this.metalness = params.metalness ?? 0.05
    this.emissive = params.emissive ? new Color(params.emissive) : new Color('#000000')
    this.emissiveIntensity = params.emissiveIntensity ?? 0
  }
}

// ── Light classes ─────────────────────────────────────────────────

export class Light extends Object3D {
  constructor(color, intensity = 1) {
    super()
    this.color = new Color(color)
    this.intensity = intensity
  }
}

export class AmbientLight extends Light { constructor(color, intensity) { super(color, intensity); this.type = 'AmbientLight' } }
export class DirectionalLight extends Light { constructor(color, intensity) { super(color, intensity); this.type = 'DirectionalLight'; this.castShadow = false } }
export class PointLight extends Light { constructor(color, intensity) { super(color, intensity); this.type = 'PointLight' } }

// ── Mesh ──────────────────────────────────────────────────────────

export class Mesh extends Object3D {
  constructor(geometry, material) {
    super()
    this.geometry = geometry
    this.material = material
    this.type = 'Mesh'
    this.castShadow = false
    this.receiveShadow = false
  }
}

// ── Scene ─────────────────────────────────────────────────────────

export class Scene extends Object3D {
  constructor() {
    super()
    this.type = 'Scene'
    this.background = null
    this.fog = null
  }
}

// ── Camera ────────────────────────────────────────────────────────

export class PerspectiveCamera extends Object3D {
  constructor(fov = 45, aspect = 1, near = 0.1, far = 100) {
    super()
    this.type = 'PerspectiveCamera'
    this.fov = fov
    this.aspect = aspect
    this.near = near
    this.far = far
  }
  updateProjectionMatrix() {}
}

// ── Renderer ──────────────────────────────────────────────────────

export class WebGLRenderer {
  constructor(_params) {
    this.disposed = false
    this.domElement = document.createElement('canvas')
    this.outputColorSpace = 'srgb'
    this.info = { render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 } }
    this.capabilities = { isWebGL2: true, maxAnisotropy: 1 }
    this.shadowMap = { enabled: false, type: 0 }
  }
  setPixelRatio(_r) {}
  setSize(_w, _h, _updateStyle) {}
  render(_scene, _camera) {}
  dispose() { this.disposed = true }
}

// ── Controls ──────────────────────────────────────────────────────

export class OrbitControls {
  constructor(_camera, _domElement) {
    this.target = new Vector3()
    this.enableDamping = false
    this.minDistance = 0
    this.maxDistance = 10
    this.maxPolarAngle = Math.PI
    this.disposed = false
  }
  update() {}
  dispose() { this.disposed = true }
}

// ── Skeleton ──────────────────────────────────────────────────────

export class SkeletonHelper extends Object3D {
  constructor(root) { super(); this.root = root; this.name = 'skeleton-helper' }
}

// ── Animation ─────────────────────────────────────────────────────

export class AnimationClip {
  constructor(name, duration, tracks) {
    this.name = name ?? ''
    this.duration = duration ?? 0
    this.tracks = tracks ?? []
  }
}

export class AnimationMixer {
  constructor(root) {
    this._root = root
    this._actions = []
    this.stopped = false
  }
  getRoot() { return this._root }
  clipAction(_clip) {
    const a = { enabled: true, paused: false, getEffectiveWeight: () => 1, getClip: () => _clip, _clip, stop: () => {} }
    this._actions.push(a)
    return a
  }
  update(_dt) {}
  stopAllAction() { this.stopped = true; for (const a of this._actions) a.enabled = false }
}

// ── Clock ─────────────────────────────────────────────────────────

export class Clock {
  constructor() { this._startTime = 0 }
  start() { this._startTime = performance.now() }
  getDelta() { return 0.016 }
  getElapsedTime() { return (performance.now() - this._startTime) / 1000 }
}

// ── GLTFLoader ────────────────────────────────────────────────────

export class GLTFLoader {
  constructor() { this._plugins = [] }
  register(plugin) { this._plugins.push(plugin) }
  async loadAsync(_url) { return { scene: new Group(), userData: { vrm: null } } }
}

// ── Fog ───────────────────────────────────────────────────────────

export class FogExp2 {
  constructor(color, density = 0.01) {
    this.color = new Color(color)
    this.density = density
  }
}
