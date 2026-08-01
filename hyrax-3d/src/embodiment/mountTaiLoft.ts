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

  // ARDY live motion stream: status dot + prompt input.
  // The stream URL comes from ?ardyWs= (see ArdyMotionSource).
  const ardyStatus = document.createElement('span')
  ardyStatus.className = 'tai-loft-ardy-status'
  ardyStatus.dataset.state = 'connecting'
  ardyStatus.title = 'ARDY motion stream'
  const ardyInput = document.createElement('input')
  ardyInput.className = 'tai-loft-ardy-prompt'
  ardyInput.type = 'text'
  ardyInput.placeholder = 'Motion prompt…'
  ardyInput.setAttribute('aria-label', 'ARDY motion prompt')
  const ardySend = document.createElement('button')
  ardySend.textContent = 'Send'
  ardySend.title = 'Send motion prompt to the ARDY stream'
  const sendArdyPrompt = (): void => {
    const text = ardyInput.value.trim()
    if (text) room.setArdyPrompt(text)
  }
  ardySend.addEventListener('click', sendArdyPrompt)
  ardyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendArdyPrompt()
  })
  controls.append(ardyStatus, ardyInput, ardySend)
  const ardyStatusTimer = setInterval(() => {
    const state = room.getArdyState()
    ardyStatus.dataset.state = state
    // EMB-1: surface latency/buffer/reconnect telemetry in the hover text.
    const t = room.getArdyTelemetry()
    let title = 'ARDY motion stream: ' + state
    if (t) {
      const parts: string[] = []
      if (t.latencyMs !== null) parts.push(`latency ${Math.round(t.latencyMs)}ms`)
      if (t.bufferDepthMs !== null) parts.push(`buffer ${Math.round(t.bufferDepthMs)}ms/${t.bufferFrames}f`)
      if (t.stalenessMs !== null) parts.push(`stale ${Math.round(t.stalenessMs)}ms`)
      parts.push(`reconnects ${t.reconnectCount} (attempts ${t.reconnectAttempts})`)
      parts.push(`dropped ${t.framesDropped}`)
      if (t.contractVersion !== null) parts.push(`contract v${t.contractVersion}`)
      if (t.lastReason !== null) parts.push(`last: ${t.lastReason}`)
      title += ' · ' + parts.join(' · ')
    }
    ardyStatus.title = title
  }, 500)

  // ARDY debug view (capture player / retarget compare) in a new tab.
  const debugButton = document.createElement('button')
  debugButton.textContent = 'Debug'
  debugButton.title = 'Open the ARDY debug view in a new tab'
  debugButton.addEventListener('click', () => {
    window.open('/static/hyrax/3d/debug/ardy.html', '_blank', 'noopener')
  })
  controls.append(debugButton)

  // Debug/E2E handle: ardy state, EMB-1 telemetry, prompt sender, and a
  // hips-height probe.
  const debugWindow = window as unknown as { __ardy?: unknown }
  debugWindow.__ardy = {
    getState: () => room.getArdyState(),
    getTelemetry: () => room.getArdyTelemetry(),
    setPrompt: (text: string) => room.setArdyPrompt(text),
    hipsWorldY: () => room.getHipsWorldY(),
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
    clearInterval(ardyStatusTimer)
    delete debugWindow.__ardy
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
