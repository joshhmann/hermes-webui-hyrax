/**
 * Scene manifest — the room as data (spatial layer 3).
 *
 * Spec: docs/gestalt-vn/specs/SCENE_MANIFEST_SPEC.md
 *
 * A room manifest is versioned JSON served from the repo (hyrax-3d/rooms/,
 * via the /api/hyrax/3d/ static route) and loaded at loft mount.
 * Validation is FAIL-CLOSED: any malformed field rejects the whole
 * manifest (the caller falls back to DEFAULT_SCENE_MANIFEST — an empty
 * room — and warns). A valid manifest is the spatial truth: RoomNavigation
 * builds collision from `bounds` + `obstacles`, the reflex layer resolves
 * blocker ids to human labels, and the planner/essence layers (later) will
 * speak `objects[].interactions[].spot` as their vocabulary.
 */
export const SCENE_MANIFEST_VERSION = '1.0'

export const INTERACTION_KINDS = ['sit', 'stand', 'lie', 'look', 'use'] as const
export type InteractionKind = (typeof INTERACTION_KINDS)[number]

export interface SceneBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * Collision AABB (XZ footprint). `halfSize` is already halved; `padding`
 * is the authored clearance in meters — RoomNavigation adds the actor
 * radius on top at load (same arithmetic as addBoxObstacle).
 */
export interface SceneObstacle {
  id: string
  label: string
  center: [number, number]
  halfSize: [number, number]
  padding: number
}

/** Named interaction point: stable id, kind, spot (XZ), facing, motion prompt. */
export interface SceneInteraction {
  id: string
  kind: InteractionKind
  spot: [number, number]
  facingDeg: number
  prompt: string
}

export interface SceneObject {
  id: string
  label: string
  position: [number, number, number]
  interactions?: SceneInteraction[]
  /**
   * True when the prop's geometry is authored in scene code rather than
   * placed from the manifest. The manifest still records the canonical
   * position — the manifest is the spatial truth, rendering is downstream.
   */
  baked?: boolean
}

export interface SceneManifest {
  manifest_version: string
  room_id: string
  name: string
  bounds: SceneBounds
  obstacles: SceneObstacle[]
  objects: SceneObject[]
  vn?: { background?: string }
}

/** Default URL for the loft's manifest (served via /api/hyrax/3d/). */
export const DEFAULT_MANIFEST_URL = '/api/hyrax/3d/rooms/tai-loft.json'

/**
 * Fail-closed fallback: an empty room with the loft's floor bounds (the
 * floor/walls geometry is code-rendered even when the manifest is missing,
 * so navigation still needs sane clamping) and no obstacles/objects.
 */
export const DEFAULT_SCENE_MANIFEST: SceneManifest = {
  manifest_version: SCENE_MANIFEST_VERSION,
  room_id: 'default-empty',
  name: 'Empty Room',
  bounds: { minX: -3.65, maxX: 3.65, minZ: -3.65, maxZ: 3.65 },
  obstacles: [],
  objects: [],
}

// ── Validation helpers ─────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFinitePair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  )
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    isFiniteNumber(value[2])
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBounds(raw: unknown, errors: string[]): SceneBounds | null {
  if (!isPlainObject(raw)) {
    errors.push('bounds must be an object')
    return null
  }
  const { minX, maxX, minZ, maxZ } = raw
  let ok = true
  for (const [key, value] of Object.entries({ minX, maxX, minZ, maxZ })) {
    if (!isFiniteNumber(value)) {
      errors.push(`bounds.${key} must be a finite number`)
      ok = false
    }
  }
  if (!ok) return null
  const b = raw as unknown as SceneBounds
  if (b.minX >= b.maxX) {
    errors.push(`bounds.minX (${b.minX}) must be < bounds.maxX (${b.maxX})`)
    ok = false
  }
  if (b.minZ >= b.maxZ) {
    errors.push(`bounds.minZ (${b.minZ}) must be < bounds.maxZ (${b.maxZ})`)
    ok = false
  }
  return ok ? b : null
}

function parseObstacle(raw: unknown, errors: string[], path: string): SceneObstacle | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`)
    return null
  }
  let ok = true
  if (!isNonEmptyString(raw.id)) {
    errors.push(`${path}.id must be a non-empty string`)
    ok = false
  }
  if (typeof raw.label !== 'string') {
    errors.push(`${path}.label must be a string`)
    ok = false
  }
  if (!isFinitePair(raw.center)) {
    errors.push(`${path}.center must be [x, z] finite numbers`)
    ok = false
  }
  if (!isFinitePair(raw.halfSize)) {
    errors.push(`${path}.halfSize must be [x, z] finite numbers`)
    ok = false
  } else if (raw.halfSize[0] < 0 || raw.halfSize[1] < 0) {
    errors.push(`${path}.halfSize must be non-negative`)
    ok = false
  }
  if (!isFiniteNumber(raw.padding) || raw.padding < 0) {
    errors.push(`${path}.padding must be a finite number >= 0`)
    ok = false
  }
  if (!ok) return null
  return raw as unknown as SceneObstacle
}

function parseInteraction(raw: unknown, errors: string[], path: string): SceneInteraction | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`)
    return null
  }
  let ok = true
  if (!isNonEmptyString(raw.id)) {
    errors.push(`${path}.id must be a non-empty string`)
    ok = false
  }
  if (typeof raw.kind !== 'string' || !(INTERACTION_KINDS as readonly string[]).includes(raw.kind)) {
    errors.push(`${path}.kind must be one of ${INTERACTION_KINDS.join('|')}`)
    ok = false
  }
  if (!isFinitePair(raw.spot)) {
    errors.push(`${path}.spot must be [x, z] finite numbers`)
    ok = false
  }
  if (!isFiniteNumber(raw.facingDeg)) {
    errors.push(`${path}.facingDeg must be a finite number`)
    ok = false
  }
  if (typeof raw.prompt !== 'string') {
    errors.push(`${path}.prompt must be a string`)
    ok = false
  }
  if (!ok) return null
  return raw as unknown as SceneInteraction
}

function parseObject(raw: unknown, errors: string[], path: string): SceneObject | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`)
    return null
  }
  let ok = true
  if (!isNonEmptyString(raw.id)) {
    errors.push(`${path}.id must be a non-empty string`)
    ok = false
  }
  if (typeof raw.label !== 'string') {
    errors.push(`${path}.label must be a string`)
    ok = false
  }
  if (!isFiniteTriple(raw.position)) {
    errors.push(`${path}.position must be [x, y, z] finite numbers`)
    ok = false
  }
  let interactions: SceneInteraction[] | undefined
  if (raw.interactions !== undefined) {
    if (!Array.isArray(raw.interactions)) {
      errors.push(`${path}.interactions must be an array`)
      ok = false
    } else {
      const parsed: SceneInteraction[] = []
      for (let i = 0; i < raw.interactions.length; i += 1) {
        const interaction = parseInteraction(raw.interactions[i], errors, `${path}.interactions[${i}]`)
        if (!interaction) ok = false
        else parsed.push(interaction)
      }
      interactions = parsed
    }
  }
  if (!ok) return null
  const object = raw as unknown as SceneObject
  return { ...object, interactions: interactions ?? object.interactions }
}

/**
 * Validate raw JSON against the manifest_version 1.0 schema. FAIL-CLOSED:
 * any malformed field → `manifest: null` with the collected errors; a
 * caller must never partially apply a broken room.
 */
export function parseSceneManifest(raw: unknown): { manifest: SceneManifest | null; errors: string[] } {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return { manifest: null, errors: ['manifest must be a JSON object'] }
  }

  if (raw.manifest_version !== SCENE_MANIFEST_VERSION) {
    errors.push(`manifest_version must be "${SCENE_MANIFEST_VERSION}" (got ${JSON.stringify(raw.manifest_version)})`)
  }
  if (!isNonEmptyString(raw.room_id)) {
    errors.push('room_id must be a non-empty string')
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    errors.push('name must be a non-empty string')
  }

  const bounds = parseBounds(raw.bounds, errors)

  let obstacles: SceneObstacle[] = []
  if (!Array.isArray(raw.obstacles)) {
    errors.push('obstacles must be an array')
  } else {
    for (let i = 0; i < raw.obstacles.length; i += 1) {
      const obstacle = parseObstacle(raw.obstacles[i], errors, `obstacles[${i}]`)
      if (!obstacle) continue
      if (obstacles.some((o) => o.id === obstacle.id)) {
        errors.push(`obstacles[${i}].id "${obstacle.id}" is duplicated`)
        continue
      }
      obstacles.push(obstacle)
    }
  }

  let objects: SceneObject[] = []
  if (!Array.isArray(raw.objects)) {
    errors.push('objects must be an array')
  } else {
    for (let i = 0; i < raw.objects.length; i += 1) {
      const object = parseObject(raw.objects[i], errors, `objects[${i}]`)
      if (!object) continue
      if (objects.some((o) => o.id === object.id)) {
        errors.push(`objects[${i}].id "${object.id}" is duplicated`)
        continue
      }
      objects.push(object)
    }
  }

  if (raw.vn !== undefined && !isPlainObject(raw.vn)) {
    errors.push('vn must be an object')
  } else if (isPlainObject(raw.vn) && raw.vn.background !== undefined && typeof raw.vn.background !== 'string') {
    errors.push('vn.background must be a string')
  }

  if (errors.length > 0) {
    return { manifest: null, errors }
  }
  const manifest = raw as unknown as SceneManifest
  return {
    manifest: { ...manifest, bounds: bounds!, obstacles, objects },
    errors: [],
  }
}

/**
 * Fetch + validate a manifest URL. FAIL-CLOSED: network failure, bad HTTP
 * status, or invalid content all resolve to DEFAULT_SCENE_MANIFEST with a
 * console warning — never a crash, never a partial room.
 */
export async function loadSceneManifest(
  url: string = DEFAULT_MANIFEST_URL,
  fetcher: (input: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = fetch,
): Promise<SceneManifest> {
  try {
    const response = await fetcher(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw: unknown = await response.json()
    const { manifest, errors } = parseSceneManifest(raw)
    if (!manifest) throw new Error(`invalid manifest: ${errors.join('; ')}`)
    return manifest
  } catch (error) {
    console.warn(
      `[loft] scene manifest load failed (${url}): ${String(error)} — falling back to the default empty room`,
    )
    return DEFAULT_SCENE_MANIFEST
  }
}
