import {
  mountTaiLoft as mountTaiLoftImplementation,
  type TaiLoftMountConfiguration,
} from './embodiment/mountTaiLoft'

export interface TaiLoftMountOptions {
  /** URL of the VRM or GLB avatar asset loaded when the room initializes. */
  vrmUrl?: string
  /** Enables the lighting selector, rig workbench, diagnostics, and Shift+T shortcut. */
  development?: boolean
}

const productionDefaults: TaiLoftMountConfiguration = {
  vrmUrl: '/api/hyrax/assets/tai.embodiment.vrm',
  development: false,
}

/**
 * Mount Tai's Synthesis Loft into `host`.
 *
 * Resolves to the room cleanup callback, which removes room-owned listeners and
 * renderer resources. Callers continue to own navigation through `onExit`.
 */
export function mountTaiLoft(
  host: HTMLElement,
  onExit: () => void,
  options: TaiLoftMountOptions = {},
): Promise<() => void> {
  return mountTaiLoftImplementation(host, onExit, {
    ...productionDefaults,
    ...options,
  })
}

/**
 * Mount the FLEET loft into `host` (card t_ee790be9): the same Synthesis
 * Loft, now the fleet's living room — Tai's VRM plus every operator from
 * the fleet placement config (rooms/fleet-loft.json) as a 2D billboard
 * driven by her own /api/hyrax/presence item.
 *
 * Same cleanup contract as mountTaiLoft.
 */
export function mountFleetLoft(
  host: HTMLElement,
  onExit: () => void,
  options: TaiLoftMountOptions = {},
): Promise<() => void> {
  return mountTaiLoftImplementation(host, onExit, {
    ...productionDefaults,
    ...options,
    fleet: true,
  })
}
