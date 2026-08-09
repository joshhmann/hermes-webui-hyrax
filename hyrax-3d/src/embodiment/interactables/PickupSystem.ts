/**
 * PickupSystem — bounded pickup for cup-style interactables (spatial layer 5).
 *
 * Spec: docs/gestalt-vn/specs/INTERACTABLES_SPEC.md (§ Pick-up (bounded v1))
 *
 * On `kind: "pickup"` interaction COMPLETION the object's mesh parents to
 * the attach bone with the bone-local offset — parenting IS the tracking:
 * the mesh follows the hand every rendered frame with zero per-frame code,
 * no IK, no physics engine. `putdown` (a `kind: "use"` interaction on the
 * same object) reverses the attach and places the mesh at the object's
 * authored home position, where it stays.
 *
 * Bounded interaction range: a pick-up is only honored when the actor root
 * is within PICKUP_RANGE_M of the object's position at completion time —
 * the fail-closed version of "she can't grab the cup from across the
 * room" (the goal planner already walks her to the spot; this is the
 * belt-and-suspenders bound at the moment of truth).
 *
 * v1 scope (per spec non-goals): one held object at a time, in-memory
 * state only, no obstacle mutation (the cup has no obstacle entry — it
 * sits on the coffee table; the door task owns obstacle/state machines).
 */
import { Object3D, Quaternion, Vector3 } from 'three'

import type { SceneAttachSpec } from '../room/sceneManifest'

/** Max distance (m) from the actor root to the object at pick-up completion
 * for the attach to be honored. Sized from the LIVE loft geometry
 * (measured 2026-08-03, pickup-cup bench): the nav reflex keeps her
 * ~0.7 m off an obstacle's padded band, and the reach motion pushes her
 * back from the table edge — the measured steady-state standoff for a
 * table-surface grab is ~1.2-1.4 m (recentered spawn → spot → interact
 * completion landed 1.21 m from a south-rim cup). 1.4 m bounds the grab
 * to arm's reach of the table while still refusing any across-the-room
 * grab (the room is 7.3 m wide; a mid-room completion is 2+ m away). */
export const PICKUP_RANGE_M = 1.4

export interface PickupHold {
  objectId: string
  mesh: Object3D
  /** The bone node the mesh is parented to while held (VRM normalized bone,
   * resolved by the scene — the system itself is VRM-agnostic). */
  boneNode: Object3D
  boneName: string
  attach: SceneAttachSpec
  /** The mesh's parent before the pick-up (the scene root) — restored on
   * putdown so the object keeps its render-layer membership. */
  originalParent: Object3D | null
  /** Wall-clock ms of the attach (telemetry/probe). */
  attachedAtMs: number
}

/** Post-release memory of the last put-down (probe continuity: the mesh's
 * world position after placement is real measured state — the "stays there"
 * evidence — not a self-reported constant). */
interface ReleasedObject {
  objectId: string
  mesh: Object3D
  placedAt: Vector3
}

/** Live probe shape for the GEVS pickup-cup check (__ardy.pickupProbe). */
export interface PickupProbe {
  holding: string | null
  attached: boolean
  bone: string | null
  /**
   * Object mesh world position — while held (hand-following), or the last
   * released placement after putdown. Null only before the first pick-up.
   */
  cupWorld: [number, number, number] | null
  /** Attach bone's world position (null when no hold/bone). */
  handWorld: [number, number, number] | null
  /** Bone-local offset of the active attach spec (null when not held). */
  offset: [number, number, number] | null
  /**
   * |cupWorld − (handWorld + R_bone·offset)| — the carry-follow error.
   * Exactly 0 while parented (three.js applies the parent transform); the
   * GEVS check uses it as the ATTACHMENT detector: a detach mid-carry
   * (or a failed attach) blows this past the bound immediately.
   */
  followErrorM: number | null
  /** World position of the last putdown placement (null until one happens). */
  placedAt: [number, number, number] | null
  /** The object's authored home position (the putdown target). */
  home: [number, number, number] | null
  /** Distance root→object at the last refused pick-up (null when none). */
  lastRangeRefusalM: number | null
}

export interface PickupOptions {
  /** Wall clock override (tests). */
  nowMs?: () => number
}

export class PickupSystem {
  private readonly nowMs: () => number
  private hold: PickupHold | null = null
  private released: ReleasedObject | null = null
  private readonly homeByObject = new Map<string, Vector3>()
  private lastRangeRefusalM: number | null = null

  constructor(options: PickupOptions = {}) {
    this.nowMs = options.nowMs ?? (() => performance.now())
  }

  /** True while an object is held (v1: one held object at a time). */
  get holding(): boolean {
    return this.hold !== null
  }

  /** Object id of the held object (null when empty). */
  get heldObjectId(): string | null {
    return this.hold?.objectId ?? null
  }

  /** Last refusal/cancel reason (probe + diagnostics). */
  lastReason: string | null = null

  /**
   * Pick up: bound-check the interaction range, then parent the mesh to the
   * bone node with the attach offset. Returns the hold on success; null
   * (journaled via `lastReason`) when out of range, bone missing, or
   * already holding.
   */
  pickUp(
    objectId: string,
    mesh: Object3D,
    attach: SceneAttachSpec,
    boneNode: Object3D | null,
    rootXZ: { x: number; z: number },
    objectHome: Vector3,
  ): PickupHold | null {
    this.homeByObject.set(objectId, objectHome.clone())
    if (this.hold !== null) {
      this.lastReason = `already holding "${this.hold.objectId}"`
      return null
    }
    if (!boneNode) {
      this.lastReason = `attach bone "${attach.bone}" not found on the rig`
      return null
    }
    // Bounded interaction range (spec: "remains within a bounded
    // interaction range"): the attach only happens when she is within
    // PICKUP_RANGE_M of the object at completion. Fail-closed — out of
    // range is a refusal, not a silent grab.
    const rangeM = Math.hypot(rootXZ.x - objectHome.x, rootXZ.z - objectHome.z)
    if (rangeM > PICKUP_RANGE_M) {
      this.lastRangeRefusalM = rangeM
      this.lastReason = `pick-up out of bounded range (${rangeM.toFixed(2)} m > ${PICKUP_RANGE_M} m)`
      return null
    }
    const originalParent = mesh.parent
    // Bone-local placement: local position = offset, so the world position
    // is exactly handWorld + R_bone·offset. Setting position BEFORE
    // re-parenting avoids a world-transform jump on add().
    mesh.position.set(attach.offset[0], attach.offset[1], attach.offset[2])
    mesh.updateMatrixWorld()
    boneNode.add(mesh)
    const hold: PickupHold = {
      objectId,
      mesh,
      boneNode,
      boneName: attach.bone,
      attach,
      originalParent,
      attachedAtMs: this.nowMs(),
    }
    this.hold = hold
    this.lastReason = null
    return hold
  }

  /**
   * Put down: unparent the mesh and place it at the object's authored home
   * position, restoring its original parent. Returns true when a hold was
   * released. No-op (false) when nothing is held or the held object does
   * not match (a stale/foreign putdown must not release someone else's
   * hold — fail-closed).
   */
  putDown(objectId: string): boolean {
    const hold = this.hold
    if (!hold) {
      this.lastReason = 'putdown with nothing held'
      return false
    }
    if (hold.objectId !== objectId) {
      this.lastReason = `putdown "${objectId}" does not match held "${hold.objectId}"`
      return false
    }
    const home = this.homeByObject.get(objectId) ?? new Vector3()
    hold.mesh.removeFromParent()
    hold.mesh.position.copy(home)
    hold.mesh.updateMatrixWorld()
    if (hold.originalParent) hold.originalParent.add(hold.mesh)
    this.released = { objectId, mesh: hold.mesh, placedAt: home.clone() }
    this.hold = null
    this.lastReason = null
    return true
  }

  /** Live probe for the GEVS pickup-cup check — measured, never dead-reckon. */
  probe(): PickupProbe {
    const hold = this.hold
    const subjectId = hold?.objectId ?? this.released?.objectId ?? null
    const home = subjectId ? this.homeByObject.get(subjectId) ?? null : null
    if (!hold) {
      return {
        holding: null,
        attached: false,
        bone: null,
        cupWorld: this.released
          ? (this.released.mesh.getWorldPosition(new Vector3()).toArray() as [number, number, number])
          : null,
        handWorld: null,
        offset: null,
        followErrorM: null,
        placedAt: this.released
          ? (this.released.placedAt.toArray() as [number, number, number])
          : null,
        home: home ? (home.toArray() as [number, number, number]) : null,
        lastRangeRefusalM: this.lastRangeRefusalM,
      }
    }
    const cupWorld = hold.mesh.getWorldPosition(new Vector3())
    const handWorld = hold.boneNode.getWorldPosition(new Vector3())
    // Expected world = handWorld + R_bone·offset (the same transform three.js
    // applies to the parented child). Computed independently of the mesh's
    // own transform — an honest comparison, not a self-check.
    const offset = new Vector3(hold.attach.offset[0], hold.attach.offset[1], hold.attach.offset[2])
    const expected = handWorld.clone().add(
      offset.applyQuaternion(hold.boneNode.getWorldQuaternion(new Quaternion())),
    )
    return {
      holding: hold.objectId,
      attached: true,
      bone: hold.boneName,
      cupWorld: cupWorld.toArray() as [number, number, number],
      handWorld: handWorld.toArray() as [number, number, number],
      offset: [...hold.attach.offset],
      followErrorM: cupWorld.distanceTo(expected),
      placedAt: this.released
        ? (this.released.placedAt.toArray() as [number, number, number])
        : null,
      home: home ? (home.toArray() as [number, number, number]) : null,
      lastRangeRefusalM: this.lastRangeRefusalM,
    }
  }
}
