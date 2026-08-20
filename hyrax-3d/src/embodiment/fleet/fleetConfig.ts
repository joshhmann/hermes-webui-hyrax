/**
 * Fleet loft configuration — the multi-operator room placement (fleet layer).
 *
 * Spec: docs/embodiment-surfaces.md ("the loft is the fleet's living room");
 * card t_ee790be9. The room stays THE Synthesis Loft (rooms/tai-loft.json is
 * the spatial truth: bounds/obstacles/objects). This file is a SEPARATE
 * placement config so room edits never drift from operator placement:
 *
 *   {
 *     "version": 1,
 *     "room": "tai-loft.json",            // spatial manifest reference
 *     "operators": [ { ...FleetOperatorConfig } ]
 *   }
 *
 * Validation is FAIL-CLOSED (same doctrine as the scene manifest): any
 * malformed operator entry is dropped with a warning, a malformed top level
 * resolves to an empty fleet (the single-operator loft still mounts). The
 * client never guesses a placement.
 */

/** One 2D billboard actor in the fleet room. */
export interface FleetOperatorConfig {
  /** Operator id, e.g. "rei" (must match presence operatorId). */
  id: string
  /** Display name, e.g. "Rei". */
  label: string
  /** Role line, e.g. "QA". */
  role: string
  /** World position of the billboard BASE (floor point), meters. */
  position: [number, number, number]
  /** Billboard height in meters (width follows the texture aspect). */
  height: number
  /** Base texture (neutral) — the operator's VN portrait URL. */
  base: string
  /** Fallback texture when `base` fails to load (the chibi). */
  fallback: string
  /** Expression token → portrait asset URL (precomputed from the backend's
   * curated fallback chains, api/hyrax_essence.py _EXPRESSION_FALLBACKS,
   * resolved against each operator's portrait set). Missing token → base. */
  expressions: Record<string, string>
}

export interface FleetConfig {
  version: number
  /** Spatial manifest reference (informational — the mount loads it). */
  room: string
  operators: FleetOperatorConfig[]
}

/** Default fleet config URL (served via /api/hyrax/3d/). */
export const DEFAULT_FLEET_CONFIG_URL = '/api/hyrax/3d/rooms/fleet-loft.json'

/** Fail-closed empty fleet — the single-operator loft still mounts. */
export const EMPTY_FLEET_CONFIG: FleetConfig = { version: 1, room: 'tai-loft.json', operators: [] }

// ── Validation helpers ─────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOperator(raw: unknown, errors: string[], path: string): FleetOperatorConfig | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`)
    return null
  }
  let ok = true
  if (!isNonEmptyString(raw.id)) {
    errors.push(`${path}.id must be a non-empty string`)
    ok = false
  }
  if (!isNonEmptyString(raw.label)) {
    errors.push(`${path}.label must be a non-empty string`)
    ok = false
  }
  if (typeof raw.role !== 'string') {
    errors.push(`${path}.role must be a string`)
    ok = false
  }
  if (!isFiniteTriple(raw.position)) {
    errors.push(`${path}.position must be [x, y, z] finite numbers`)
    ok = false
  }
  if (typeof raw.height !== 'number' || !Number.isFinite(raw.height) || raw.height <= 0) {
    errors.push(`${path}.height must be a finite number > 0`)
    ok = false
  }
  if (!isNonEmptyString(raw.base)) {
    errors.push(`${path}.base must be a non-empty asset URL`)
    ok = false
  }
  if (!isNonEmptyString(raw.fallback)) {
    errors.push(`${path}.fallback must be a non-empty asset URL`)
    ok = false
  }
  let expressions: Record<string, string> = {}
  if (!isPlainObject(raw.expressions)) {
    errors.push(`${path}.expressions must be an object`)
    ok = false
  } else {
    for (const [token, url] of Object.entries(raw.expressions)) {
      if (!isNonEmptyString(url)) {
        errors.push(`${path}.expressions.${token} must be a non-empty asset URL`)
        ok = false
      } else {
        expressions[token] = url
      }
    }
  }
  if (!ok) return null
  return {
    id: raw.id as string,
    label: raw.label as string,
    role: raw.role as string,
    position: raw.position as [number, number, number],
    height: raw.height as number,
    base: raw.base as string,
    fallback: raw.fallback as string,
    expressions,
  }
}

/**
 * Parse a fleet config from raw JSON. FAIL-CLOSED per operator: a broken
 * entry is dropped (with the reason), the rest of the fleet still mounts.
 */
export function parseFleetConfig(raw: unknown): { config: FleetConfig; errors: string[] } {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return { config: EMPTY_FLEET_CONFIG, errors: ['fleet config must be a JSON object'] }
  }
  if (raw.version !== 1) {
    errors.push(`fleet config version must be 1 (got ${JSON.stringify(raw.version)})`)
  }
  if (!isNonEmptyString(raw.room)) {
    errors.push('fleet config room must be a non-empty string')
  }
  const operators: FleetOperatorConfig[] = []
  if (!Array.isArray(raw.operators)) {
    errors.push('fleet config operators must be an array')
  } else {
    const seen = new Set<string>()
    for (let i = 0; i < raw.operators.length; i += 1) {
      const op = parseOperator(raw.operators[i], errors, `operators[${i}]`)
      if (!op) continue
      if (seen.has(op.id)) {
        errors.push(`operators[${i}].id "${op.id}" is duplicated — dropped`)
        continue
      }
      seen.add(op.id)
      operators.push(op)
    }
  }
  if (errors.length > 0) {
    // A broken entry must not take the whole fleet down: drop bad entries,
    // keep the valid ones (per-operator fail-closed, documented above).
    return {
      config: { version: 1, room: isNonEmptyString(raw.room) ? raw.room : 'tai-loft.json', operators },
      errors,
    }
  }
  return {
    config: { version: 1, room: raw.room as string, operators },
    errors: [],
  }
}

/**
 * Fetch + parse a fleet config URL. FAIL-CLOSED: any network/parse problem
 * resolves to EMPTY_FLEET_CONFIG with a console warning — the loft mounts,
 * just single-operator.
 */
export async function loadFleetConfig(
  url: string = DEFAULT_FLEET_CONFIG_URL,
  fetcher: (input: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<FleetConfig> {
  try {
    const response = await fetcher(url)
    if (!response.ok) throw new Error(`HTTP ${String(response)}`)
    const raw: unknown = await response.json()
    const { config, errors } = parseFleetConfig(raw)
    if (errors.length > 0) {
      console.warn(`[fleet] fleet config issues (${url}): ${errors.join('; ')}`)
    }
    return config
  } catch (error) {
    console.warn(
      `[fleet] fleet config load failed (${url}): ${String(error)} — mounting single-operator`,
    )
    return EMPTY_FLEET_CONFIG
  }
}
