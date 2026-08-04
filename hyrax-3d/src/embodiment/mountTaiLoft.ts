import './tai-room.css'

import { TaiRoomScene } from './TaiRoomScene'
import type { TimeOfDayPreset } from './atmosphere/TimeOfDaySystem'
import type { GoalPlannerPolicy } from './planning/GoalPlanner'
import { RigDevelopmentPanel } from './debug/RigDevelopmentPanel'
import { loadSceneManifest } from './room/sceneManifest'

export interface TaiLoftMountConfiguration {
  vrmUrl: string
  development: boolean
  /** Test/dev seam: goal-planner policy overrides (compressed cadence). */
  plannerPolicy?: Partial<GoalPlannerPolicy>
  /** Operator whose presence drives her goals (default tai for the tai-loft;
   * the essence driver mechanism is operator-generic). */
  operator?: string
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

  // The room is DATA now (SCENE_MANIFEST_SPEC.md): bounds, collision, and
  // prop positions come from rooms/tai-loft.json served via /api/hyrax/3d/.
  // Fail-closed: a missing/malformed manifest resolves to the default empty
  // room with a console warning — the loft still mounts, just uncluttered.
  const manifest = await loadSceneManifest()
  const room = new TaiRoomScene(canvas, configuration.vrmUrl, manifest, configuration.plannerPolicy, {
    operator: configuration.operator,
  })
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

  // Shuffle button: plays the GEVS shortened shuffle sequence (data:
  // hyrax-3d/tests/bench/sequences/shuffle.json, served via /api/hyrax/3d/)
  // as a timed prompt schedule through the normal prompt channel. Toggles
  // to Stop while playing; timers are cleaned up on unmount.
  const shuffleButton = document.createElement('button')
  shuffleButton.textContent = '♪ Shuffle'
  shuffleButton.title = 'Play the shortened shuffle sequence (GEVS dance benchmark)'
  let shuffleTimers: number[] = []
  const stopShuffle = (): void => {
    for (const t of shuffleTimers) window.clearTimeout(t)
    shuffleTimers = []
    shuffleButton.textContent = '♪ Shuffle'
  }
  shuffleButton.addEventListener('click', () => {
    if (shuffleTimers.length) { stopShuffle(); return }
    shuffleButton.textContent = '■ Stop'
    interface ShuffleSeq { phraseSeconds: number; phrases: { prompt: string }[]; repeats: number }
    const fallback: ShuffleSeq = {
      phraseSeconds: 9,
      phrases: [
        { prompt: 'a person steps to the right twice' },
        { prompt: 'a person steps to the left twice' },
        { prompt: 'a person taps their right heel forward' },
        { prompt: 'a person taps their left heel forward' },
        { prompt: 'a person turns a quarter turn to the left' },
      ],
      repeats: 2,
    }
    const play = (seq: ShuffleSeq): void => {
      const total = seq.phrases.length * seq.repeats
      for (let i = 0; i < total; i += 1) {
        const phrase = seq.phrases[i % seq.phrases.length]
        shuffleTimers.push(window.setTimeout(() => {
          room.setArdyPrompt(phrase.prompt)
          if (i === total - 1) {
            shuffleTimers.push(window.setTimeout(() => {
              room.setArdyPrompt('a person stands idle')
              stopShuffle()
            }, seq.phraseSeconds * 1000))
          }
        }, i * seq.phraseSeconds * 1000))
      }
    }
    fetch('/api/hyrax/3d/tests/bench/sequences/shuffle.json')
      .then((r) => (r.ok ? r.json() : fallback))
      .then((seq) => play(seq as ShuffleSeq))
      .catch(() => play(fallback))
  })
  controls.append(shuffleButton)

  // Goal picker: sends her to a manifest interaction point (spatial
  // layer 3b). Buttons from rooms/tai-loft.json with a fallback list;
  // shows the active goal and offers Clear. User prompts cancel goals
  // (pilot wins); this is the same seam as __ardy.setGoal.
  const goalButton = document.createElement('button')
  goalButton.textContent = 'Go to'
  goalButton.title = 'Send her to an interaction point (goal planner)'
  const goalPanel = document.createElement('div')
  goalPanel.className = 'tai-loft-goals'
  goalPanel.style.display = 'none'
  let goalsLoaded = false
  const renderGoalPanel = (interactions: { id: string; label: string }[]): void => {
    goalsLoaded = true
    goalPanel.replaceChildren()
    const active = room.getGoal()
    const head = document.createElement('div')
    head.className = 'tai-loft-goals-head'
    head.textContent = active ? `Goal: ${active}` : 'No active goal'
    goalPanel.append(head)
    for (const it of interactions) {
      const b = document.createElement('button')
      b.textContent = `${it.label} · ${it.id}`
      b.addEventListener('click', () => {
        room.setGoal(it.id)
        renderGoalPanel(interactions)
      })
      goalPanel.append(b)
    }
    if (active) {
      const clear = document.createElement('button')
      clear.textContent = 'Clear goal'
      clear.addEventListener('click', () => {
        room.clearGoal()
        renderGoalPanel(interactions)
      })
      goalPanel.append(clear)
    }
  }
  goalButton.addEventListener('click', () => {
    const show = goalPanel.style.display === 'none'
    goalPanel.style.display = show ? '' : 'none'
    if (!show) return
    interface ManifestInteraction { id: string }
    interface ManifestObject { id: string; label?: string; interactions?: ManifestInteraction[] }
    const fallback = [
      { id: 'couch.sit', label: 'the couch' },
      { id: 'chair.sit', label: 'the armchair' },
      { id: 'desk.work', label: 'her desk' },
      { id: 'daybed.nap', label: 'the daybed' },
    ]
    fetch('/api/hyrax/3d/rooms/tai-loft.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((manifest) => {
        let items = fallback
        if (manifest && Array.isArray(manifest.objects)) {
          const found = (manifest.objects as ManifestObject[]).flatMap((o) =>
            (o.interactions ?? []).map((i) => ({ id: `${o.id}.${i.id}`, label: o.label ?? o.id })),
          )
          if (found.length) items = found
        }
        renderGoalPanel(items)
      })
      .catch(() => { if (!goalsLoaded) renderGoalPanel(fallback) })
  })
  controls.append(goalButton)
  shell.append(goalPanel)
  // Keep the header honest while a goal runs.
  const goalStatusTimer = setInterval(() => {
    if (goalPanel.style.display === 'none' || !goalsLoaded) return
    const head = goalPanel.querySelector('.tai-loft-goals-head')
    if (head) head.textContent = room.getGoal() ? `Goal: ${room.getGoal()}` : 'No active goal'
  }, 1000)

  // GEVS scoreboard: toggle panel showing the latest bench report
  // (hyrax-3d/tests/bench/scoreboard.json — promoted from the newest run;
  // see tests/bench/README.md). Read-only; fetch failures hide the panel.
  const scoreButton = document.createElement('button')
  scoreButton.textContent = 'Scores'
  scoreButton.title = 'Show the latest GEVS embodiment benchmark scores'
  const scorePanel = document.createElement('div')
  scorePanel.className = 'tai-loft-scoreboard'
  scorePanel.style.display = 'none'
  let scoreLoaded = false
  scoreButton.addEventListener('click', () => {
    const show = scorePanel.style.display === 'none'
    scorePanel.style.display = show ? '' : 'none'
    if (!show || scoreLoaded) return
    interface CategoryScore { score: number }
    interface ScoreReport {
      startedAt?: string
      scores?: { overall?: number; categories?: Record<string, CategoryScore> }
      checks?: { id: string; verdict: string; summary?: string }[]
    }
    fetch('/api/hyrax/3d/tests/bench/scoreboard.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((report: ScoreReport | null) => {
        scoreLoaded = true
        if (!report || !report.scores) {
          scorePanel.textContent = 'No GEVS report yet — run tests/bench/gevs.py'
          return
        }
        const when = (report.startedAt ?? '').slice(0, 10)
        const rows: string[] = [
          `<div class="tai-loft-scoreboard-overall">GEVS ${report.scores.overall ?? '?'}<small>${when}</small></div>`,
        ]
        const cats = report.scores.categories ?? {}
        for (const [name, cat] of Object.entries(cats)) {
          rows.push(`<div class="tai-loft-scoreboard-row"><span>${name}</span><b>${cat.score}</b></div>`)
        }
        const fails = (report.checks ?? []).filter((c) => c.verdict !== 'pass')
        if (fails.length) {
          rows.push('<div class="tai-loft-scoreboard-partials">partials/fails: ' +
            fails.map((c) => c.id).join(', ') + '</div>')
        }
        scorePanel.innerHTML = rows.join('')
      })
      .catch(() => {
        scoreLoaded = true
        scorePanel.textContent = 'GEVS report unavailable.'
      })
  })
  controls.append(scoreButton)
  shell.append(scorePanel)
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
    // Goal planner (spatial layer 3b): intents → motion sequences.
    setGoal: (goal: string) => room.setGoal(goal),
    clearGoal: () => room.clearGoal(),
    getGoal: () => room.getGoal(),
    // Essence driver (spatial layer 4): test-only presence override + the
    // effective state the driver reads (GEVS level-4 check / seeded-state run).
    setEssenceState: (state: object | null) => room.setEssenceOverride(state as Parameters<typeof room.setEssenceOverride>[0] | null),
    getEssenceState: () => room.getEssenceState(),
    recenterRoot: (x: number, z: number) => room.recenterArdyRoot(x, z),
    hipsWorldY: () => room.getHipsWorldY(),
    footWorldY: () => room.getFootWorldY(),
    poseProbe: (bones?: string[]) => room.getArdyPoseProbe(bones),
    // Bounded self-collision (capsule push-out): live toggle + penetration probe.
    setSelfCollision: (enabled: boolean) => room.setArdySelfCollision(enabled),
    selfCollisionReport: () => room.getArdySelfCollisionReport(),
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
    clearInterval(goalStatusTimer)
    stopShuffle()
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
