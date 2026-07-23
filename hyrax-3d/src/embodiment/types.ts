export type ClipId =
  | "idle_pose"
  | "idle_base"
  | "idle_shift"
  | "idle_checkwatch"
  | "idle_headscratch"
  | "walk_forward"
  | "run_forward"
  | "turn_left"
  | "turn_right"
  | "start_move"
  | "stop_move"
  | "talk_small_1"
  | "talk_small_2"
  | "talk_explain"
  | "shrug"
  | "point"
  | "greet"
  | "wave"
  | "bow"
  | "cheer"
  | "open_hand"
  | "flinch_small"
  | "surprised_recoil"
  | "head_turn_away"
  | "laugh_small"
  | "awkward_wave"
  | "minor_stumble";

export type GestureClipId =
  | "talk_small_1"
  | "talk_small_2"
  | "talk_explain"
  | "shrug"
  | "point"
  | "greet"
  | "wave"
  | "bow"
  | "cheer"
  | "open_hand";

export type ReactionClipId =
  | "flinch_small"
  | "surprised_recoil"
  | "head_turn_away"
  | "laugh_small"
  | "awkward_wave"
  | "minor_stumble";

export type ControllerClipCategory =
  | "idle"
  | "locomotion"
  | "transition"
  | "gesture"
  | "reaction";

export type BodyRegion = "lowerBody" | "upperBody" | "headNeck" | "face" | "eyes";

export type LocomotionMode = "idle" | "walk" | "approach" | "step_back" | "turn";
export type LocomotionDirection = "forward" | "backward" | "left" | "right";
export type GestureSide = "left" | "right";
export type AttentionMotion =
  | "look_left"
  | "look_right"
  | "look_sweep"
  | "nod"
  | "shake";
export type LocomotionState =
  | "idle"
  | "startingMove"
  | "walking"
  | "turningInPlace"
  | "stopping";

export interface Vector3Like {
  x: number;
  y?: number;
  z: number;
}

export interface MotionIntent {
  locomotion?: {
    mode: LocomotionMode;
    direction?: LocomotionDirection;
    speed?: number;
    target?: string;
    targetPosition?: Vector3Like;
  };
  gesture?: {
    type: string;
    intensity: number;
    side?: GestureSide;
  };
  posture?: {
    profile: "relaxed" | "attentive" | "confident" | "nervous" | "tired" | "crouching";
    intensity: number;
  };
  face?: {
    expression: string;
    intensity: number;
    talking: boolean;
  };
  attention?: {
    targetId?: string;
    weight: number;
    mode?: "none" | "soft" | "focused";
    motion?: AttentionMotion;
  };
  reaction?: {
    type: string;
    priority: number;
    prompt?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface AttentionTarget {
  id: string;
  position: Vector3Like;
  weight: number;
}

export interface MotionIntentEnvelope {
  intent: MotionIntent;
  metadata?: Record<string, unknown>;
}

export interface ControllerClipEntry {
  category: ControllerClipCategory;
  kind: "bvh" | "vrma" | "fbx";
  path: string;
  available: boolean;
  fallbackTo?: ClipId;
  label?: string;
  semanticTags?: string[];
  source?: string;
  stability?: "stable" | "offline_retargeted" | "experimental";
}

export interface ControllerManifest {
  version: number;
  clips: Record<ClipId, ControllerClipEntry>;
}

export interface MovementState {
  velocityX: number;
  velocityZ: number;
  desiredVelocityX: number;
  desiredVelocityZ: number;
  facingYaw: number;
  desiredYaw: number;
  speed: number;
  grounded: boolean;
}

export interface LayerRegionState {
  owner: string;
  active: boolean;
  detail?: string;
}

export interface LayeredStateSummary {
  lowerBody: LayerRegionState;
  upperBody: LayerRegionState;
  headNeck: LayerRegionState;
  face: LayerRegionState;
  eyes: LayerRegionState;
}

export type ObservationEmitter = (
  observationType: string,
  data: Record<string, unknown>,
) => void;

export type ActionStatus = "idle" | "running" | "succeeded" | "failed";

export type Affordance =
  | "inspect"
  | "sit"
  | "use"
  | "open"
  | "close"
  | "pick_up"
  | "place_on"
  | "talk_to"
  | "walk_to"
  | "look_at";

export type RoomObjectState = Record<string, unknown>;

export interface RoomObjectDefinition {
  id: string;
  type: string;
  displayName?: string;
  position: Vector3Like;
  approachPoint?: Vector3Like;
  lookTarget?: boolean;
  lookTargetPosition?: Vector3Like;
  placementPoint?: Vector3Like;
  interactionRange?: number;
  affordances?: Affordance[];
  state?: RoomObjectState;
  walkTarget?: boolean;
  label?: string;
  description?: string;
}

export type CurrentAction = {
  id: string;
  type: "walk_to" | "interact" | "look_at" | "speak" | "run_task";
  target?: string;
  startedAt: number;
  status: ActionStatus;
  durationMs?: number;
};

export type WalkFinishedEvent = {
  target: string;
  finalPosition: Vector3Like;
  distanceToTarget: number;
  durationMs: number;
};

export type WalkFailedEvent = {
  target: string;
  reason: "unknown_target" | "no_path" | "stuck" | "timeout" | "interrupted";
  finalPosition: Vector3Like;
  durationMs: number;
};

export type InteractFinishedEvent = {
  target: string;
  interaction: string;
  durationMs: number;
  actorHolding?: string | null;
  changedObjects?: Array<{
    id: string;
    state: RoomObjectState;
    position?: Vector3Like;
  }>;
};

export type TaskStepFinishedEvent = {
  index: number;
  success: boolean;
  action: string;
  target: string;
  result?: Record<string, unknown>;
};

export type InteractFailedEvent = {
  target: string;
  interaction?: string;
  reason:
    | "unknown_target"
    | "target_too_far"
    | "not_interactable"
    | "actor_busy"
    | "interrupted"
    | "missing_interaction"
    | "not_supported"
    | "invalid_state";
  distanceToTarget?: number;
};

export type TaskStep = {
  action: "walk_to" | "interact" | "look_at" | "speak";
  target: string;
  interaction?: Affordance;
  text?: string;
};

export type Goal =
  | { type: "object_on_surface"; object: string; surface: string }
  | { type: "actor_holding_object"; object: string }
  | { type: "actor_at_location"; target: string }
  | { type: "actor_sitting"; target: string };

export type GoalStartedEvent = {
  goal: Goal;
};

export type GoalPlanCreatedEvent = {
  goal: Goal;
  steps: TaskStep[];
  metadata?: {
    recoveryStepsAdded?: boolean;
    recoveryReason?: string;
  };
};

export type GoalFinishedEvent = {
  goal: Goal;
  alreadySatisfied: boolean;
  durationMs: number;
};

export type GoalFailedEvent = {
  goal: Goal;
  reason:
    | "unknown_object"
    | "unknown_surface"
    | "object_not_pickupable"
    | "surface_not_placeable"
    | "actor_holding_different_object"
    | "task_failed"
    | "invalid_goal";
  error?: string;
};

export type ThoughtTrigger =
  | "goal_started"
  | "goal_plan_created"
  | "goal_finished"
  | "goal_failed"
  | "task_finished"
  | "task_failed"
  | "interact_finished"
  | "interact_failed"
  | "walk_failed"
  | "idle";

export type ThoughtVisibility = "private" | "click_to_reveal" | "auto_speak";

export type ThoughtPriority = "low" | "normal" | "high";

export type AutonomyMode = "manual" | "suggestive" | "bounded" | "full";

export interface AgentThought {
  id: string;
  actorId: string;
  trigger: ThoughtTrigger;
  visibility: ThoughtVisibility;
  priority: ThoughtPriority;
  text: string;
  createdAt: number;
  expiresAt?: number;
  consumed: boolean;
  relatedObjectIds?: string[];
  sourceEventType?: string;
  proposedGoal?: Goal;
  proposedCommand?: Record<string, unknown>;
}

export type ThoughtAvailableEvent = {
  thoughtId: string;
  actorId: string;
  priority: ThoughtPriority;
  trigger: ThoughtTrigger;
  relatedObjectIds?: string[];
  expiresAt?: number;
  text?: string;
};

export type ThoughtConsumedEvent = {
  thoughtId: string;
  actorId: string;
  text: string;
};

export interface ActorSnapshot {
  id: string;
  position: Vector3Like;
  state: string;
  currentAction?: string;
  currentTarget?: string;
  holding?: string;
}

export interface WorldObjectSnapshot {
  id: string;
  type: string;
  displayName: string;
  position: Vector3Like;
  distance: number;
  affordances: Affordance[];
  interactionRange: number;
  isInInteractionRange: boolean;
  approachPoint?: Vector3Like;
  lookTarget?: Vector3Like;
  state?: RoomObjectState;
}

export interface WorldSnapshot {
  actor: ActorSnapshot;
  world: WorldObjectSnapshot[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SpecialMotionRequest {
  prompt: string;
  duration: number;
  style?: "subtle" | "natural" | "awkward" | "energetic";
  bodyRegion?: "upperBody" | "fullBody";
  priority: number;
}
