import './tai-room.css'

import { TaiRoomScene } from './TaiRoomScene'
import type { TimeOfDayPreset } from './atmosphere/TimeOfDaySystem'
import { RigDevelopmentPanel } from './debug/RigDevelopmentPanel'

export interface TaiLoftMountConfiguration {
  vrmUrl: string
  development: boolean
}

export async function mountTaiLoft(
  host: HTMLElement,
  onExit: () => void,
  configuration: TaiLoftMountConfiguration,
): Promise<() => void> {
  const shell = document.createElement('section')
  shell.className = 'tai-loft'
  const canvas = document.createElement('div')
  canvas.className = 'tai-loft-canvas'
  const chrome = document.createElement('div')
  chrome.className = 'tai-loft-chrome'
  const identity = document.createElement('div')
  identity.innerHTML = '<small>TAI · EMBODIMENT</small><strong>The Synthesis Loft</strong><span>Body downstream of Hermes</span>'
  const controls = document.createElement('div')
  controls.className = 'tai-loft-controls'

  const exit = document.createElement('button')
  exit.textContent = '← Return to VN'
  exit.addEventListener('click', onExit)
  controls.append(exit)
  chrome.append(identity, controls)
  shell.append(canvas, chrome)
  host.replaceChildren(shell)

  const room = new TaiRoomScene(canvas, configuration.vrmUrl)
  for (const mode of ['room', 'follow', 'portrait'] as const) {
    const button = document.createElement('button')
    button.textContent = mode[0].toUpperCase() + mode.slice(1)
    button.addEventListener('click', () => room.setCameraMode(mode))
    controls.append(button)
  }
  let workbenchButton: HTMLButtonElement | null = null
  if (configuration.development) {
    const time = document.createElement('select')
    time.setAttribute('aria-label', 'Room lighting')
    for (const value of ['live', 'dawn', 'noon', 'dusk', 'night']) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === 'live' ? 'Local time' : value[0].toUpperCase() + value.slice(1)
      time.append(option)
    }
    time.addEventListener('change', () => room.setTimeOfDay(time.value === 'live' ? null : time.value as TimeOfDayPreset))
    controls.append(time)

    workbenchButton = document.createElement('button')
    workbenchButton.textContent = 'Rig & Motion'
    workbenchButton.title = 'Open embodiment workbench (Shift+T)'
    controls.append(workbenchButton)
  }

  let workbench: RigDevelopmentPanel | null = null
  // Build the cleanup function early so it works even on error paths
  let destroyed = false
  const cleanup = (): void => {
    if (destroyed) return
    destroyed = true
    if (configuration.development) window.removeEventListener('keydown', onKeyDown)
    workbench?.destroy()
    room.destroy()
    shell.remove()
  }
  try {
    await room.initialize()
    if (configuration.development && workbenchButton) {
      workbench = new RigDevelopmentPanel(room)
      shell.append(workbench.element)
      workbenchButton.addEventListener('click', () => workbench?.toggle())
    }
  } catch (error) {
    const failure = document.createElement('div')
    failure.className = 'tai-loft-error'
    failure.textContent = `Embodiment could not start: ${String(error)}`
    shell.append(failure)
    // Return the cleanup function even on init failure — the DOM and
    // renderer resources created in the constructor still need cleaning.
    return cleanup
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault()
      workbench?.toggle()
    }
  }
  if (configuration.development) window.addEventListener('keydown', onKeyDown)
  return cleanup
}
