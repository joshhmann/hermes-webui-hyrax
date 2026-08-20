/**
 * FleetLayer — multi-operator 2D embodiment for the Synthesis Loft.
 *
 * Card t_ee790be9: the loft is the fleet's living room. Tai stays a full
 * VRM rig (TaiRoomScene); every other operator is embodied as a billboard:
 * their VN portrait on a ground-grounded sprite, expression-swapped from
 * her own /api/hyrax/presence item, with a DOM badge carrying kanban-in-
 * room state (current task + running/blocked counts + completion reaction).
 *
 * Presence flow: TaiRoomScene owns the ~30s presence poll; it pushes the
 * full items array into `updatePresence` here. No new polling loop — the
 * fleet rides the existing cadence (acceptance: "updates flow at the
 * existing cadence without manual refresh").
 *
 * Fail-closed: a missing/stale presence item keeps the actor's last state
 * (texture stays, badge shows the last known mood as stale). A texture
 * load failure falls back to the operator's chibi, then to a neutral
 * placeholder sprite. The room never fails because a sprite failed.
 */
import {
  CanvasTexture,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  type Camera,
} from 'three'
import type { FleetOperatorConfig } from './fleetConfig'

/** The presence item fields the fleet consumes (anything else is ignored). */
export interface FleetPresenceItem {
  operatorId?: string
  available?: boolean
  activity?: { type?: string }
  expression?: { current?: string; intensity?: number }
  kanban?: { running?: number; blocked?: number }
  currentTask?: { id?: string; title?: string } | null
  derivedState?: { fresh?: boolean; mood?: string | null }
}

/** Debug/test probe shape (window.__fleet.probe()). */
export interface FleetActorProbe {
  operatorId: string
  expression: string
  textureUrl: string | null
  mood: string | null
  activity: string | null
  kanban: { running: number; blocked: number }
  task: { id: string; title: string } | null
  reaction: string | null
  badgeText: string
}

/** Max texture height after client-side downscale (memory: 14MB portraits). */
const MAX_TEXTURE_HEIGHT = 768
const CROSSFADE_MS = 320
const IDLE_BOB_AMPLITUDE = 0.035
const IDLE_BOB_RATE = 1.25

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Load an image URL, downscale to MAX_TEXTURE_HEIGHT, return a canvas texture
 * (also used to read the aspect ratio before upload). */
function loadDownscaledTexture(url: string): Promise<{ texture: CanvasTexture; aspect: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const ratio = image.height / MAX_TEXTURE_HEIGHT
        const w = Math.max(1, Math.round(image.width / ratio))
        const h = Math.min(MAX_TEXTURE_HEIGHT, image.height)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('2d context unavailable')
        ctx.drawImage(image, 0, 0, w, h)
        const texture = new CanvasTexture(canvas)
        texture.colorSpace = 'srgb'
        texture.anisotropy = 2
        resolve({ texture, aspect: w / h })
      } catch (error) {
        reject(error)
      }
    }
    image.onerror = () => reject(new Error(`image load failed: ${url}`))
    image.src = url
  })
}

/** One billboard actor: sprite + pedestal + DOM badge + presence state. */
class FleetActor {
  readonly group = new Group()
  readonly operatorId: string
  readonly label: string
  readonly role: string
  private readonly config: FleetOperatorConfig
  private readonly sprite: Sprite
  private readonly material: SpriteMaterial
  private readonly overlay: HTMLElement
  private readonly scene: Scene
  private readonly camera: Camera
  private readonly badgeEl: HTMLElement
  private readonly reactionEl: HTMLElement
  private readonly textureCache: Map<string, Texture>
  private readonly textureAspect: Map<string, number>

  private expression: string = 'neutral'
  private currentTextureUrl: string | null = null
  private pendingTextureUrl: string | null = null
  private fadeT = 0
  private fadeDurMs = 0
  private mood: string | null = null
  private activity: string | null = null
  private kanban: { running: number; blocked: number } = { running: 0, blocked: 0 }
  private task: { id: string; title: string } | null = null
  private reaction: string | null = null
  private reactionUntil = 0
  private baseY: number
  private lastTaskId: string | null = null
  private lastBlocked = 0
  private readonly vector = new Vector3()

  constructor(
    config: FleetOperatorConfig,
    scene: Scene,
    camera: Camera,
    overlay: HTMLElement,
    textureCache: Map<string, Texture>,
    textureAspect: Map<string, number>,
  ) {
    this.config = config
    this.operatorId = config.id
    this.label = config.label
    this.role = config.role
    this.scene = scene
    this.camera = camera
    this.overlay = overlay
    this.textureCache = textureCache
    this.textureAspect = textureAspect
    this.baseY = config.position[1]

    // Grounding: dark disc + light ring (the sprite reads as standing).
    const disc = new Mesh(
      new CircleGeometry(0.52, 32),
      new MeshBasicMaterial({ color: 0x05080d, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    disc.rotation.x = -Math.PI / 2
    disc.position.set(0, 0.012, 0)
    const ring = new Mesh(
      new RingGeometry(0.52, 0.6, 32),
      new MeshBasicMaterial({ color: 0x6ecbf5, transparent: true, opacity: 0.4, depthWrite: false }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(0, 0.02, 0)
    this.group.add(disc, ring)

    // The billboard sprite (portrait holo-card).
    this.material = new SpriteMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0,
      rotation: 0,
    })
    this.sprite = new Sprite(this.material)
    this.sprite.position.set(0, config.height / 2, 0)
    // Neutral placeholder until the texture resolves (never a blank hole).
    this.sprite.scale.set(0.9, config.height, 1)
    this.group.add(this.sprite)
    this.group.position.set(config.position[0], 0, config.position[2])
    scene.add(this.group)

    // DOM badge (nameplate + kanban-in-room).
    this.badgeEl = document.createElement('div')
    this.badgeEl.className = 'fleet-actor-badge'
    this.badgeEl.setAttribute('data-operator', config.id)
    this.badgeEl.innerHTML =
      `<div class="fleet-actor-head"><b>${escapeHtml(config.label)}</b><span>${escapeHtml(config.role)}</span>` +
      `<i class="fleet-actor-dot" data-activity="idle"></i></div>` +
      `<div class="fleet-actor-mood" data-state="empty"></div>` +
      `<div class="fleet-actor-kanban">0 running · 0 blocked</div>` +
      `<div class="fleet-actor-task"></div>`
    this.reactionEl = document.createElement('div')
    this.reactionEl.className = 'fleet-actor-reaction'
    this.badgeEl.append(this.reactionEl)
    overlay.append(this.badgeEl)

    // Load the base texture (async; the sprite shows the placeholder until
    // it lands, then fades in).
    void this.loadTexture(config.base, config.fallback)
  }

  /** Load + apply a texture URL; on failure try the fallback, then give up
   * (the placeholder keeps the actor visible). */
  private async loadTexture(url: string, fallback?: string): Promise<void> {
    try {
      let cached = this.textureCache.get(url)
      let aspect = this.textureAspect.get(url)
      if (!cached) {
        const loaded = await loadDownscaledTexture(url)
        cached = loaded.texture
        aspect = loaded.aspect
        this.textureCache.set(url, cached)
        this.textureAspect.set(url, aspect)
      }
      if (this.pendingTextureUrl !== url) return // superseded by a newer swap
      this.applyTexture(cached, aspect ?? 0.5)
    } catch (error) {
      console.warn(`[fleet] ${this.operatorId} texture failed (${url}): ${String(error)}`)
      if (fallback && fallback !== url) {
        await this.loadTexture(fallback)
      }
    }
  }

  private applyTexture(texture: Texture, aspect: number): void {
    this.material.map = texture
    this.material.needsUpdate = true
    this.sprite.scale.set(Math.min(1.25, this.config.height * aspect), this.config.height, 1)
    this.currentTextureUrl = this.configUrlFor(this.expression)
    // Fade in on mount and on every swap.
    this.fadeT = 0
    this.fadeDurMs = CROSSFADE_MS
  }

  private configUrlFor(expression: string): string {
    return this.config.expressions[expression] ?? this.config.base
  }

  /** Apply a presence item (polled or overridden). */
  applyPresence(item: FleetPresenceItem | null): void {
    if (!item) return
    const ds = item.derivedState ?? {}
    this.mood = typeof ds.mood === 'string' && ds.mood ? ds.mood : null
    this.activity = typeof item.activity?.type === 'string' ? item.activity.type : null
    this.kanban = {
      running: Math.max(0, item.kanban?.running ?? 0),
      blocked: Math.max(0, item.kanban?.blocked ?? 0),
    }
    const task =
      item.currentTask && typeof item.currentTask?.title === 'string' && item.currentTask.title
        ? { id: item.currentTask.id ?? '', title: item.currentTask.title }
        : null
    this.task = task
    const taskTitle = task?.title ?? ''

    // Expression: the presence expression is server-normalized per operator.
    const token = typeof item.expression?.current === 'string' ? item.expression.current : null
    const expression = token && this.config.expressions[token] ? token : 'neutral'
    if (expression !== this.expression) {
      this.expression = expression
      const url = this.configUrlFor(expression)
      this.pendingTextureUrl = url
      // Cache hit → apply immediately; miss → async load (fade-in on arrival).
      const cached = this.textureCache.get(url)
      if (cached) {
        this.applyTexture(cached, this.textureAspect.get(url) ?? 0.5)
      } else {
        void this.loadTexture(url, this.config.fallback)
      }
    }

    // Kanban-in-room reactions (task completion / new blockage).
    const taskId = task?.id ?? null
    if (taskId && this.lastTaskId !== null && taskId !== this.lastTaskId) {
      this.showReaction(`✓ ${this.lastTaskTitleShort()} done → ${truncate(taskTitle, 26)}`, 'ok')
    }
    if (taskId && this.lastTaskId === null) {
      this.showReaction(`on: ${truncate(taskTitle, 30)}`, 'info')
    }
    if (this.kanban.blocked > 0 && this.lastBlocked === 0) {
      this.showReaction('⚠ blocked', 'warn')
    }
    this.lastTaskId = taskId
    this.lastBlocked = this.kanban.blocked
    if (task) this.lastTaskTitle = task.title

    this.renderBadge()
  }

  private lastTaskTitleShort(): string {
    return truncate(this.lastTaskTitle ?? 'task', 20)
  }

  private lastTaskTitle: string | null = null

  private showReaction(text: string, kind: 'ok' | 'warn' | 'info'): void {
    this.reaction = text
    this.reactionUntil = performance.now() + 4200
    this.reactionEl.textContent = text
    this.reactionEl.dataset.kind = kind
    this.reactionEl.classList.remove('is-pop')
    // Restart the CSS pop animation.
    void this.reactionEl.offsetWidth
    this.reactionEl.classList.add('is-pop')
  }

  private renderBadge(): void {
    const dot = this.badgeEl.querySelector('.fleet-actor-dot') as HTMLElement | null
    if (dot) dot.dataset.activity = this.activity ?? 'idle'
    const mood = this.badgeEl.querySelector('.fleet-actor-mood') as HTMLElement | null
    if (mood) {
      if (this.mood) {
        mood.textContent = this.mood
        mood.dataset.state = 'live'
      } else {
        mood.textContent = ''
        mood.dataset.state = 'empty'
      }
    }
    const kanban = this.badgeEl.querySelector('.fleet-actor-kanban') as HTMLElement | null
    if (kanban) {
      kanban.textContent = `${this.kanban.running} running · ${this.kanban.blocked} blocked`
      kanban.dataset.blocked = this.kanban.blocked > 0 ? 'yes' : 'no'
    }
    const task = this.badgeEl.querySelector('.fleet-actor-task') as HTMLElement | null
    if (task) {
      task.textContent = this.task ? `on: ${truncate(this.task.title, 34)}` : ''
      task.dataset.state = this.task ? 'live' : 'empty'
    }
  }

  /** Per-frame: idle bob, crossfade, badge projection. */
  update(dt: number, now: number): void {
    const t = now / 1000
    this.sprite.position.y =
      this.baseY + this.config.height / 2 + Math.sin(t * IDLE_BOB_RATE + this.phase) * IDLE_BOB_AMPLITUDE
    if (this.fadeDurMs > 0) {
      this.fadeT += dt * 1000
      const k = Math.min(1, this.fadeT / this.fadeDurMs)
      this.material.opacity = 0.15 + 0.85 * k
      if (k >= 1) this.fadeDurMs = 0
    }

    // Project the sprite top to screen space for the badge anchor.
    this.vector.set(0, this.config.height + 0.09, 0)
    this.group.localToWorld(this.vector)
    this.vector.project(this.camera)
    const canvas = this.camera as unknown as { canvas?: HTMLCanvasElement }
    const width = canvas?.canvas?.clientWidth ?? window.innerWidth
    const height = canvas?.canvas?.clientHeight ?? window.innerHeight
    if (this.vector.z > 1 || this.vector.z < -1) {
      this.badgeEl.style.display = 'none'
      return
    }
    this.badgeEl.style.display = 'block'
    const x = (this.vector.x * 0.5 + 0.5) * width
    const y = (-this.vector.y * 0.5 + 0.5) * height
    this.badgeEl.style.transform = `translate(-50%, 0) translate(${Math.round(x)}px, ${Math.round(y)}px)`

    if (this.reaction && now > this.reactionUntil) {
      this.reaction = null
      this.reactionEl.textContent = ''
      this.reactionEl.classList.remove('is-pop')
    }
  }

  probe(): FleetActorProbe {
    return {
      operatorId: this.operatorId,
      expression: this.expression,
      textureUrl: this.currentTextureUrl,
      mood: this.mood,
      activity: this.activity,
      kanban: { ...this.kanban },
      task: this.task ? { ...this.task } : null,
      reaction: this.reaction,
      badgeText: [
        `${this.label} · ${this.role}`,
        this.mood ? `mood:${this.mood}` : '',
        `${this.kanban.running}r/${this.kanban.blocked}b`,
        this.task ? this.task.title : '',
      ].filter(Boolean).join(' | '),
    }
  }

  /** Remove DOM + scene objects. Textures stay in the layer cache for reuse. */
  destroy(): void {
    this.badgeEl.remove()
    this.scene.remove(this.group)
  }

  private readonly phase = Math.random() * Math.PI * 2
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

export class FleetLayer {
  readonly overlay: HTMLElement
  private readonly actors = new Map<string, FleetActor>()
  private readonly textureCache = new Map<string, Texture>()
  private readonly textureAspect = new Map<string, number>()
  private readonly overrides = new Map<string, FleetPresenceItem>()
  private overrideAll: FleetPresenceItem[] | null = null
  private lastItems: FleetPresenceItem[] = []
  private destroyed = false

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    container: HTMLElement,
    operators: FleetOperatorConfig[],
  ) {
    this.overlay = document.createElement('div')
    this.overlay.className = 'fleet-overlay'
    this.overlay.setAttribute('aria-hidden', 'true')
    container.append(this.overlay)
    for (const config of operators) {
      const actor = new FleetActor(config, scene, camera, this.overlay, this.textureCache, this.textureAspect)
      this.actors.set(config.id, actor)
    }
  }

  get operatorCount(): number {
    return this.actors.size
  }

  /** Push the full presence items array (called from the scene's own poll). */
  updatePresence(items: FleetPresenceItem[]): void {
    this.lastItems = items
    this.apply()
  }

  /** Test/dev seam (window.__fleet): pin one operator's presence item. */
  setOverride(operatorId: string, item: FleetPresenceItem | null): void {
    if (item === null) this.overrides.delete(operatorId)
    else this.overrides.set(operatorId, item)
    this.apply()
  }

  /** Test/dev seam: replace the whole presence set (deterministic dogfood). */
  setOverrideAll(items: FleetPresenceItem[] | null): void {
    this.overrideAll = items
    this.apply()
  }

  private apply(): void {
    if (this.destroyed) return
    const source = this.overrideAll ?? this.lastItems
    const byId = new Map(source.map((item) => [item.operatorId ?? '', item]))
    for (const [id, actor] of this.actors) {
      const item = this.overrides.get(id) ?? byId.get(id) ?? null
      actor.applyPresence(item)
    }
  }

  /** Per-frame update — call from the scene's animation loop. */
  update(dt: number, now: number): void {
    if (this.destroyed) return
    for (const actor of this.actors.values()) actor.update(dt, now)
  }

  /** Debug probes for every actor (window.__fleet.probe()). */
  probe(): FleetActorProbe[] {
    return [...this.actors.values()].map((actor) => actor.probe())
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const actor of this.actors.values()) actor.destroy()
    this.actors.clear()
    for (const texture of this.textureCache.values()) texture.dispose()
    this.textureCache.clear()
    this.overlay.remove()
  }
}
