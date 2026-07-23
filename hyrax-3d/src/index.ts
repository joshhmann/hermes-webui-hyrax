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
