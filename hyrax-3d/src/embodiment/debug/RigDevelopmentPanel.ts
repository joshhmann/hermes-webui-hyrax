import { DEFAULT_PROCEDURAL_TUNING, type ProceduralTuning } from '../locomotion/ProceduralLocomotion'
import { type MotionPreview, TaiRoomScene } from '../TaiRoomScene'

const STORAGE_KEY = 'division.embodiment.tai.rigTuning.v1'
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']
const EXPRESSIONS = ['neutral', 'relaxed', 'happy', 'thinking', 'surprised', 'sad', 'angry']

type NumericTuningKey = Exclude<keyof ProceduralTuning, 'legDirection'>
type SliderDefinition = { key: NumericTuningKey; label: string; min: number; max: number; step: number }

const SLIDERS: SliderDefinition[] = [
  { key: 'breathScale', label: 'Breath', min: 0, max: 0.14, step: 0.005 },
  { key: 'idleLife', label: 'Idle sway', min: 0, max: 0.12, step: 0.005 },
  { key: 'armDrop', label: 'Arm rest', min: 0.7, max: 1.7, step: 0.01 },
  { key: 'armSwing', label: 'Arm swing', min: 0, max: 0.7, step: 0.01 },
  { key: 'legSwing', label: 'Leg swing', min: 0, max: 1.4, step: 0.01 },
  { key: 'strideScale', label: 'Stride', min: 0.2, max: 1.4, step: 0.01 },
  { key: 'kneeBend', label: 'Knee bend', min: 0, max: 1.2, step: 0.01 },
  { key: 'torsoTwist', label: 'Torso twist', min: 0, max: 0.3, step: 0.005 },
]

const MOTIONS: Array<{ id: MotionPreview; label: string }> = [
  { id: 'idle', label: 'Stop / idle' },
  { id: 'walk', label: 'Walk cycle' },
  { id: 'crouch', label: 'Crouch' },
  { id: 'bend', label: 'Bend' },
  { id: 'jump', label: 'Jump' },
  { id: 'jumping-jacks', label: 'Jumping jacks' },
  { id: 'kick-left', label: 'Kick L' },
  { id: 'kick-right', label: 'Kick R' },
  { id: 'balance-left', label: 'Balance L' },
  { id: 'balance-right', label: 'Balance R' },
]

export class RigDevelopmentPanel {
  readonly element = document.createElement('aside')
  private readonly readout = document.createElement('pre')
  private readonly boneSelect = document.createElement('select')
  private readonly tabs = new Map<string, HTMLElement>()
  private interval = 0
  private open = false

  constructor(private readonly room: TaiRoomScene) {
    this.element.className = 'rig-workbench'
    this.element.setAttribute('aria-label', 'Tai embodiment development workbench')
    this.element.innerHTML = '<header><div><small>LOCAL OPERATOR TOOL</small><strong>Embodiment Workbench</strong><span>Renderer-only · no Hermes commands</span></div><button type="button" data-close aria-label="Close workbench">×</button></header>'
    this.element.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', () => this.setOpen(false))

    const nav = document.createElement('nav')
    nav.className = 'rig-workbench-tabs'
    const body = document.createElement('div')
    body.className = 'rig-workbench-body'
    for (const [id, label] of [['rig', 'Rig Lab'], ['motion', 'Motion Deck']] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.addEventListener('click', () => this.showTab(id))
      button.dataset.tabButton = id
      nav.append(button)
      const section = document.createElement('section')
      section.dataset.tab = id
      body.append(section)
      this.tabs.set(id, section)
    }
    this.element.append(nav, body)
    this.buildRigTab(this.tabs.get('rig')!)
    this.buildMotionTab(this.tabs.get('motion')!)
    this.showTab('rig')
  }

  setOpen(open: boolean): void {
    this.open = open
    this.element.classList.toggle('is-open', open)
    this.element.setAttribute('aria-hidden', String(!open))
    if (open) this.refreshReadout()
  }

  toggle(): void { this.setOpen(!this.open) }

  destroy(): void {
    window.clearInterval(this.interval)
    this.room.setSkeletonVisible(false)
    this.element.remove()
  }

  private showTab(id: string): void {
    for (const [tabId, section] of this.tabs) section.hidden = tabId !== id
    this.element.querySelectorAll<HTMLButtonElement>('[data-tab-button]').forEach((button) => button.classList.toggle('is-active', button.dataset.tabButton === id))
  }

  private buildRigTab(section: HTMLElement): void {
    section.append(this.heading('Coordinate truth'))
    const skeleton = this.checkbox('Skeleton overlay')
    skeleton.input.addEventListener('change', () => this.room.setSkeletonVisible(skeleton.input.checked))
    section.append(skeleton.label)

    const boneRow = document.createElement('label')
    boneRow.textContent = 'Inspect bone'
    for (const bone of BONES) this.boneSelect.add(new Option(bone, bone))
    boneRow.append(this.boneSelect)
    section.append(boneRow)
    this.readout.className = 'rig-readout'
    section.append(this.readout)

    section.append(this.heading('Face preview'))
    const expressionRow = document.createElement('div')
    expressionRow.className = 'rig-inline'
    const expression = document.createElement('select')
    for (const name of EXPRESSIONS) expression.add(new Option(name, name))
    expression.value = 'relaxed'
    const intensity = document.createElement('input')
    intensity.type = 'range'; intensity.min = '0'; intensity.max = '1'; intensity.step = '0.05'; intensity.value = '0.5'
    const applyExpression = () => this.room.setExpression(expression.value, Number(intensity.value))
    expression.addEventListener('change', applyExpression)
    intensity.addEventListener('input', applyExpression)
    expressionRow.append(expression, intensity)
    section.append(expressionRow)

    section.append(this.heading('Capture'))
    const actions = document.createElement('div')
    actions.className = 'rig-actions'
    actions.append(
      this.button('Screenshot', () => this.room.captureScreenshot()),
      this.button('Export JSON', () => this.room.exportDiagnostics(this.boneSelect.value)),
    )
    section.append(actions)
    this.interval = window.setInterval(() => { if (this.open) this.refreshReadout() }, 250)
  }

  private buildMotionTab(section: HTMLElement): void {
    section.append(this.heading('Manual motion sandbox'))
    const note = document.createElement('p')
    note.className = 'rig-note'
    note.textContent = 'Preview gestures locally. Walk loops until stopped; one-shots return to idle.'
    section.append(note)
    const deck = document.createElement('div')
    deck.className = 'motion-deck'
    for (const motion of MOTIONS) deck.append(this.button(motion.label, () => this.room.triggerMotion(motion.id)))
    section.append(deck)

    section.append(this.heading('Procedural tuning'))
    const stored = this.readStoredTuning()
    if (stored) this.room.setProceduralTuning(stored)
    const controls = document.createElement('div')
    controls.className = 'rig-sliders'
    const sliderInputs = new Map<NumericTuningKey, HTMLInputElement>()
    for (const definition of SLIDERS) {
      const row = document.createElement('label')
      const name = document.createElement('span')
      const value = document.createElement('output')
      name.textContent = definition.label
      const input = document.createElement('input')
      input.type = 'range'; input.min = String(definition.min); input.max = String(definition.max); input.step = String(definition.step)
      input.value = String(stored?.[definition.key] ?? this.room.getProceduralTuning()[definition.key])
      value.textContent = input.value
      input.addEventListener('input', () => {
        value.textContent = input.value
        this.room.setProceduralTuning({ [definition.key]: Number(input.value) })
        this.storeTuning(this.room.getProceduralTuning())
      })
      row.append(name, value, input)
      controls.append(row)
      sliderInputs.set(definition.key, input)
    }
    section.append(controls)
    section.append(this.button('Reset tuning', () => {
      localStorage.removeItem(STORAGE_KEY)
      this.room.setProceduralTuning(DEFAULT_PROCEDURAL_TUNING)
      for (const definition of SLIDERS) {
        const input = sliderInputs.get(definition.key)!
        input.value = String(DEFAULT_PROCEDURAL_TUNING[definition.key])
        input.dispatchEvent(new Event('input'))
      }
    }))
  }

  private refreshReadout(): void {
    const snapshot = this.room.getDiagnosticSnapshot(this.boneSelect.value)
    const bone = snapshot.bone
    this.readout.textContent = [
      `${snapshot.frameRate.toFixed(1)} fps · ${snapshot.frameTimeMs.toFixed(1)} ms`,
      `bounds ${snapshot.visualBounds?.size.join(', ') ?? 'unavailable'}`,
      bone?.found ? `local° ${bone.localEulerDegrees?.join(', ')}\nworld° ${bone.worldEulerDegrees?.join(', ')}\npos ${bone.worldPosition?.join(', ')}` : `${bone?.name ?? 'bone'} not found`,
    ].join('\n')
  }

  private readStoredTuning(): Partial<ProceduralTuning> | null {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Record<string, unknown> | null
      if (!raw || typeof raw !== 'object') return null
      const tuning: Partial<ProceduralTuning> = {}
      for (const definition of SLIDERS) {
        const value = raw[definition.key]
        if (typeof value === 'number' && Number.isFinite(value)) tuning[definition.key] = Math.max(definition.min, Math.min(definition.max, value))
      }
      if (raw.legDirection === 1 || raw.legDirection === -1) tuning.legDirection = raw.legDirection
      return tuning
    } catch { return null }
  }

  private storeTuning(tuning: ProceduralTuning): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning))
  }

  private heading(text: string): HTMLElement {
    const heading = document.createElement('h3'); heading.textContent = text; return heading
  }

  private button(text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.addEventListener('click', action); return button
  }

  private checkbox(text: string): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = document.createElement('label'); label.className = 'rig-check'
    const input = document.createElement('input'); input.type = 'checkbox'
    label.append(input, document.createTextNode(text)); return { label, input }
  }
}
