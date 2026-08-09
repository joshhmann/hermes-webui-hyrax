/**
 * Interactable state machine (INTERACTABLES_SPEC.md — spatial layer 5).
 *
 * The manifest declares per-object state machines (`states.<s>.obstacle` +
 * `states.<s>.mesh_rotation`) and interactions that REQUIRE a state and
 * SET one on completion. This module owns the truth: which state each
 * stateful object is in, and what a completed interaction transitions —
 * journaled. Rendering + collision effects are the host's job (TaiRoomScene
 * applies mesh_rotation to the object's mesh and `obstacle` to
 * RoomNavigation on transition).
 *
 * Discipline: fail-closed everywhere. An interaction with `sets` pointing
 * at an undeclared state is refused by the manifest validator at load, so
 * a runtime `applySets` miss is defense-in-depth (warn + no-op, never
 * invent a state). An object without a machine has no state to gate on.
 */
import type { SceneInteraction, SceneManifest, SceneObject } from './sceneManifest'

export interface StateJournalEntry {
  /** Wall clock (ms) of the transition. */
  t: number
  objectId: string
  from: string
  to: string
  /** Interaction id that caused the transition. */
  interaction: string
}

export class InteractableStateMachine {
  private readonly current = new Map<string, string>()
  private readonly entries: StateJournalEntry[] = []

  constructor(
    manifest: SceneManifest,
    private readonly nowMs: () => number = () => performance.now(),
  ) {
    for (const object of manifest.objects) {
      if (object.states && object.state) this.current.set(object.id, object.state)
    }
  }

  /** Current state of a stateful object (null when the object has no
   * declared machine — fail-closed: no machine → nothing to gate on). */
  stateOf(objectId: string): string | null {
    return this.current.get(objectId) ?? null
  }

  /**
   * Apply the interaction's `sets` transition (spec: state changes on
   * interaction COMPLETION — arrival + prompt finished — journaled).
   *
   * Returns the from → to transition when the completion legitimately
   * changes state; null when the interaction has no `sets`, the object has
   * no machine, the target equals the current state (no-op), or the target
   * is unknown (fail-closed — never invent a state). The caller applies
   * the mesh/nav effects for the new state.
   */
  applySets(object: SceneObject, interaction: SceneInteraction): { from: string; to: string } | null {
    if (interaction.sets === undefined) return null
    const from = this.current.get(object.id)
    if (from === undefined) return null
    if (!object.states || object.states[interaction.sets] === undefined) {
      console.warn(
        `[interactables] ${object.id}.${interaction.id} sets unknown state "${interaction.sets}" — ignored (fail-closed)`,
      )
      return null
    }
    if (from === interaction.sets) return null
    this.current.set(object.id, interaction.sets)
    this.entries.push({
      t: this.nowMs(),
      objectId: object.id,
      from,
      to: interaction.sets,
      interaction: interaction.id,
    })
    return { from, to: interaction.sets }
  }

  /** Journal copy (GEVS evidence: state transitions are journaled in
   * telemetry per spec AC). */
  journal(): StateJournalEntry[] {
    return [...this.entries]
  }
}
