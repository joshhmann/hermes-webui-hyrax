import { Vector3 } from "three";
import type { SceneManifest } from "../room/sceneManifest";

type RoomBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type RoomObstacle = {
  id: string;
  center: Vector3;
  halfSize: Vector3;
  padding: number;
  /** Human-readable name from the scene manifest (reflex telemetry). */
  label?: string;
};

/** Manifest-literal id used when a move clamps against the room bounds. */
export const ROOM_BOUNDARY_ID = "room_boundary";
/** Reflex/reaction label for the room boundary (spec: room_boundary → "the wall"). */
export const ROOM_BOUNDARY_LABEL = "the wall";

export type MovementConstraintResult = {
  position: Vector3;
  hit: boolean;
  obstacleId?: string;
};

const EPSILON = 0.0001;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function segmentIntersectsAabb2D(start: Vector3, end: Vector3, obstacle: RoomObstacle): boolean {
  const minX = obstacle.center.x - obstacle.halfSize.x - obstacle.padding;
  const maxX = obstacle.center.x + obstacle.halfSize.x + obstacle.padding;
  const minZ = obstacle.center.z - obstacle.halfSize.z - obstacle.padding;
  const maxZ = obstacle.center.z + obstacle.halfSize.z + obstacle.padding;

  let tMin = 0;
  let tMax = 1;
  const dx = end.x - start.x;
  const dz = end.z - start.z;

  if (Math.abs(dx) < EPSILON) {
    if (start.x < minX || start.x > maxX) return false;
  } else {
    const tx1 = (minX - start.x) / dx;
    const tx2 = (maxX - start.x) / dx;
    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
  }

  if (Math.abs(dz) < EPSILON) {
    if (start.z < minZ || start.z > maxZ) return false;
  } else {
    const tz1 = (minZ - start.z) / dz;
    const tz2 = (maxZ - start.z) / dz;
    tMin = Math.max(tMin, Math.min(tz1, tz2));
    tMax = Math.min(tMax, Math.max(tz1, tz2));
  }

  return tMax >= tMin && tMax >= 0 && tMin <= 1;
}

export class RoomNavigation {
  private readonly obstacles: RoomObstacle[] = [];

  constructor(
    private readonly bounds: RoomBounds,
    private readonly actorRadius = 0.28,
  ) {}

  /**
   * Build navigation from a scene manifest (the room as data — spec
   * SCENE_MANIFEST_SPEC.md). Bounds come from `manifest.bounds`, obstacles
   * from `manifest.obstacles`. Manifest `padding` is the authored clearance
   * in meters; the actor radius is added on top exactly like addBoxObstacle,
   * so a manifest authored from the old hardcoded values is behavior-
   * identical. Each obstacle keeps its manifest `label` for the reflex
   * layer ("coffee table" not "coffee-table").
   */
  static fromManifest(manifest: SceneManifest, actorRadius = 0.28): RoomNavigation {
    const navigation = new RoomNavigation(manifest.bounds, actorRadius);
    for (const obstacle of manifest.obstacles) {
      navigation.obstacles.push({
        id: obstacle.id,
        label: obstacle.label,
        center: new Vector3(obstacle.center[0], 0, obstacle.center[1]),
        halfSize: new Vector3(obstacle.halfSize[0], 0, obstacle.halfSize[1]),
        padding: obstacle.padding + actorRadius,
      });
    }
    return navigation;
  }

  /** Human-readable label for a blocker id: room_boundary → "the wall",
   * manifest obstacles → their authored label, unknown → the raw id. */
  labelForBlockerId(id: string): string {
    if (id === ROOM_BOUNDARY_ID) return ROOM_BOUNDARY_LABEL;
    return this.obstacles.find((obstacle) => obstacle.id === id)?.label ?? id;
  }

  addBoxObstacle(id: string, center: Vector3, size: Vector3, padding = 0.18): void {
    this.obstacles.push({
      id,
      center: center.clone(),
      halfSize: new Vector3(Math.abs(size.x) / 2, Math.abs(size.y) / 2, Math.abs(size.z) / 2),
      padding: padding + this.actorRadius,
    });
  }

  listObstacles(): RoomObstacle[] {
    return this.obstacles.map((obstacle) => ({
      ...obstacle,
      center: obstacle.center.clone(),
      halfSize: obstacle.halfSize.clone(),
    }));
  }

  firstBlockingObstacleId(start: Vector3, route: Vector3[]): string | null {
    let cursor = start.clone();
    for (const point of route) {
      const blocker = this.findBlockingObstacle(cursor, point);
      if (blocker) {
        return blocker.id;
      }
      cursor = point;
    }
    return null;
  }

  isRouteClear(start: Vector3, route: Vector3[]): boolean {
    return this.firstBlockingObstacleId(start, route) === null;
  }

  planRoute(start: Vector3, rawGoal: Vector3): Vector3[] {
    const goal = this.resolveStandingPoint(rawGoal);
    if (!this.findBlockingObstacle(start, goal)) {
      return [goal];
    }

    const candidates = this.buildWaypointCandidates(start, goal);
    const directClearCandidates = candidates
      .filter((candidate) => !this.findBlockingObstacle(start, candidate))
      .filter((candidate) => !this.findBlockingObstacle(candidate, goal))
      .sort((a, b) => this.routeCost(start, a, goal) - this.routeCost(start, b, goal));

    if (directClearCandidates[0]) {
      return [directClearCandidates[0], goal];
    }

    const twoHop = this.findTwoHopRoute(start, goal, candidates);
    if (twoHop) {
      return [...twoHop, goal];
    }

    const perimeterRoute = this.findPerimeterRoute(start, goal);
    if (perimeterRoute.length) {
      return perimeterRoute;
    }

    const gridRoute = this.findGridRoute(start, goal);
    if (gridRoute.length) {
      return gridRoute;
    }

    return [this.closestClearPoint(start, goal)];
  }

  constrainMovement(from: Vector3, to: Vector3): MovementConstraintResult {
    const position = to.clone();
    let hit = false;
    let obstacleId: string | undefined;

    position.x = clamp(position.x, this.bounds.minX, this.bounds.maxX);
    position.z = clamp(position.z, this.bounds.minZ, this.bounds.maxZ);
    if (Math.abs(position.x - to.x) > EPSILON || Math.abs(position.z - to.z) > EPSILON) {
      hit = true;
      obstacleId = ROOM_BOUNDARY_ID;
    }

    for (const obstacle of this.obstacles) {
      const resolved = this.pushOutsideObstacle(position, obstacle);
      if (resolved) {
        position.copy(resolved);
        hit = true;
        obstacleId = obstacle.id;
      } else if (segmentIntersectsAabb2D(from, position, obstacle)) {
        const fallback = this.closestClearPoint(from, position);
        position.copy(fallback);
        hit = true;
        obstacleId = obstacle.id;
      }
    }

    position.x = clamp(position.x, this.bounds.minX, this.bounds.maxX);
    position.z = clamp(position.z, this.bounds.minZ, this.bounds.maxZ);
    return { position, hit, obstacleId };
  }

  /** Push a point out of every obstacle AABB (up to 6 passes) and clamp to
   * the room bounds — the WALKABLE version of a goal spot. Public for the
   * goal planner: interaction spots may sit inside collision AABBs (the
   * daybed's spot is its center), and the planner targets the standing
   * point while keeping the authored spot as the goal's identity. */
  resolveStandingPoint(point: Vector3): Vector3 {
    let resolved = point.clone();
    resolved.x = clamp(resolved.x, this.bounds.minX, this.bounds.maxX);
    resolved.z = clamp(resolved.z, this.bounds.minZ, this.bounds.maxZ);
    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      for (const obstacle of this.obstacles) {
        const next = this.pushOutsideObstacle(resolved, obstacle);
        if (next) {
          resolved = next;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    return resolved;
  }

  private pushOutsideObstacle(point: Vector3, obstacle: RoomObstacle): Vector3 | null {
    const minX = obstacle.center.x - obstacle.halfSize.x - obstacle.padding;
    const maxX = obstacle.center.x + obstacle.halfSize.x + obstacle.padding;
    const minZ = obstacle.center.z - obstacle.halfSize.z - obstacle.padding;
    const maxZ = obstacle.center.z + obstacle.halfSize.z + obstacle.padding;

    if (point.x < minX || point.x > maxX || point.z < minZ || point.z > maxZ) {
      return null;
    }

    const distances = [
      { axis: "x" as const, value: minX, distance: Math.abs(point.x - minX) },
      { axis: "x" as const, value: maxX, distance: Math.abs(point.x - maxX) },
      { axis: "z" as const, value: minZ, distance: Math.abs(point.z - minZ) },
      { axis: "z" as const, value: maxZ, distance: Math.abs(point.z - maxZ) },
    ].sort((a, b) => a.distance - b.distance);

    const next = point.clone();
    const nearest = distances[0];
    if (nearest.axis === "x") {
      next.x = nearest.value + (nearest.value < obstacle.center.x ? -EPSILON : EPSILON);
    } else {
      next.z = nearest.value + (nearest.value < obstacle.center.z ? -EPSILON : EPSILON);
    }
    next.x = clamp(next.x, this.bounds.minX, this.bounds.maxX);
    next.z = clamp(next.z, this.bounds.minZ, this.bounds.maxZ);
    return next;
  }

  private findBlockingObstacle(start: Vector3, goal: Vector3): RoomObstacle | null {
    for (const obstacle of this.obstacles) {
      if (segmentIntersectsAabb2D(start, goal, obstacle)) {
        return obstacle;
      }
    }
    return null;
  }

  private isPointBlocked(point: Vector3): boolean {
    return this.obstacles.some((obstacle) => {
      const minX = obstacle.center.x - obstacle.halfSize.x - obstacle.padding;
      const maxX = obstacle.center.x + obstacle.halfSize.x + obstacle.padding;
      const minZ = obstacle.center.z - obstacle.halfSize.z - obstacle.padding;
      const maxZ = obstacle.center.z + obstacle.halfSize.z + obstacle.padding;
      return point.x >= minX && point.x <= maxX && point.z >= minZ && point.z <= maxZ;
    });
  }

  private buildWaypointCandidates(start: Vector3, goal: Vector3): Vector3[] {
    const candidates: Vector3[] = [];
    const relevant = this.obstacles
      .filter((obstacle) => segmentIntersectsAabb2D(start, goal, obstacle))
      .slice(0, 4);

    for (const obstacle of relevant) {
      const clearance = obstacle.padding + 0.24;
      const xs = [
        obstacle.center.x - obstacle.halfSize.x - clearance,
        obstacle.center.x + obstacle.halfSize.x + clearance,
      ];
      const zs = [
        obstacle.center.z - obstacle.halfSize.z - clearance,
        obstacle.center.z + obstacle.halfSize.z + clearance,
      ];
      for (const x of xs) {
        for (const z of zs) {
          candidates.push(this.resolveStandingPoint(new Vector3(x, 0, z)));
        }
      }
    }

    return candidates;
  }

  private findTwoHopRoute(start: Vector3, goal: Vector3, candidates: Vector3[]): [Vector3, Vector3] | null {
    let best: [Vector3, Vector3] | null = null;
    let bestCost = Infinity;
    for (const first of candidates) {
      if (this.findBlockingObstacle(start, first)) continue;
      for (const second of candidates) {
        if (first.distanceToSquared(second) < 0.01) continue;
        if (this.findBlockingObstacle(first, second)) continue;
        if (this.findBlockingObstacle(second, goal)) continue;
        const cost = start.distanceTo(first) + first.distanceTo(second) + second.distanceTo(goal);
        if (cost < bestCost) {
          best = [first, second];
          bestCost = cost;
        }
      }
    }
    return best;
  }

  private findPerimeterRoute(start: Vector3, goal: Vector3): Vector3[] {
    const inset = 0.24;
    const corridors: Array<[Vector3, Vector3]> = [
      [
        new Vector3(this.bounds.minX + inset, 0, start.z),
        new Vector3(this.bounds.minX + inset, 0, goal.z),
      ],
      [
        new Vector3(this.bounds.maxX - inset, 0, start.z),
        new Vector3(this.bounds.maxX - inset, 0, goal.z),
      ],
      [
        new Vector3(start.x, 0, this.bounds.minZ + inset),
        new Vector3(goal.x, 0, this.bounds.minZ + inset),
      ],
      [
        new Vector3(start.x, 0, this.bounds.maxZ - inset),
        new Vector3(goal.x, 0, this.bounds.maxZ - inset),
      ],
    ];

    const routes = corridors
      .map(([first, second]) => [this.resolveStandingPoint(first), this.resolveStandingPoint(second), goal])
      .filter(([first, second, final]) =>
        !this.findBlockingObstacle(start, first) &&
        !this.findBlockingObstacle(first, second) &&
        !this.findBlockingObstacle(second, final),
      )
      .sort((a, b) => this.polylineCost(start, a) - this.polylineCost(start, b));

    return routes[0] ?? [];
  }

  private polylineCost(start: Vector3, points: Vector3[]): number {
    let cost = 0;
    let cursor = start;
    for (const point of points) {
      cost += cursor.distanceTo(point);
      cursor = point;
    }
    return cost;
  }

  private findGridRoute(start: Vector3, goal: Vector3): Vector3[] {
    const cellSize = 0.35;
    const cols = Math.floor((this.bounds.maxX - this.bounds.minX) / cellSize) + 1;
    const rows = Math.floor((this.bounds.maxZ - this.bounds.minZ) / cellSize) + 1;
    const key = (x: number, z: number) => `${x},${z}`;
    const toCell = (point: Vector3): { x: number; z: number } => ({
      x: clamp(Math.round((point.x - this.bounds.minX) / cellSize), 0, cols - 1),
      z: clamp(Math.round((point.z - this.bounds.minZ) / cellSize), 0, rows - 1),
    });
    const toWorld = (cell: { x: number; z: number }): Vector3 =>
      new Vector3(
        clamp(this.bounds.minX + cell.x * cellSize, this.bounds.minX, this.bounds.maxX),
        0,
        clamp(this.bounds.minZ + cell.z * cellSize, this.bounds.minZ, this.bounds.maxZ),
      );

    const startCell = this.closestOpenCell(toCell(start), toWorld, cols, rows);
    const goalCell = this.closestOpenCell(toCell(goal), toWorld, cols, rows);
    if (!startCell || !goalCell) {
      return [];
    }

    const open = new Set([key(startCell.x, startCell.z)]);
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>([[key(startCell.x, startCell.z), 0]]);
    const fScore = new Map<string, number>([[
      key(startCell.x, startCell.z),
      Math.hypot(goalCell.x - startCell.x, goalCell.z - startCell.z),
    ]]);
    const closed = new Set<string>();
    const directions = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
      [-1, -1], [-1, 1], [1, -1], [1, 1],
    ];

    while (open.size) {
      let currentKey = "";
      let currentScore = Infinity;
      for (const candidate of open) {
        const score = fScore.get(candidate) ?? Infinity;
        if (score < currentScore) {
          currentKey = candidate;
          currentScore = score;
        }
      }

      if (currentKey === key(goalCell.x, goalCell.z)) {
        return this.simplifyGridRoute(this.reconstructGridRoute(currentKey, cameFrom, toWorld), start, goal);
      }

      open.delete(currentKey);
      closed.add(currentKey);
      const [cx, cz] = currentKey.split(",").map(Number);

      for (const [dx, dz] of directions) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= cols || nz < 0 || nz >= rows) continue;
        const neighborKey = key(nx, nz);
        if (closed.has(neighborKey)) continue;
        const world = toWorld({ x: nx, z: nz });
        if (this.isPointBlocked(world)) continue;

        const stepCost = dx !== 0 && dz !== 0 ? Math.SQRT2 : 1;
        const tentative = (gScore.get(currentKey) ?? Infinity) + stepCost;
        if (tentative >= (gScore.get(neighborKey) ?? Infinity)) continue;

        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentative);
        fScore.set(neighborKey, tentative + Math.hypot(goalCell.x - nx, goalCell.z - nz));
        open.add(neighborKey);
      }
    }

    return [];
  }

  private closestOpenCell(
    origin: { x: number; z: number },
    toWorld: (cell: { x: number; z: number }) => Vector3,
    cols: number,
    rows: number,
  ): { x: number; z: number } | null {
    for (let radius = 0; radius < Math.max(cols, rows); radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const x = origin.x + dx;
          const z = origin.z + dz;
          if (x < 0 || x >= cols || z < 0 || z >= rows) continue;
          const world = toWorld({ x, z });
          if (!this.isPointBlocked(world)) {
            return { x, z };
          }
        }
      }
    }
    return null;
  }

  private reconstructGridRoute(
    finalKey: string,
    cameFrom: Map<string, string>,
    toWorld: (cell: { x: number; z: number }) => Vector3,
  ): Vector3[] {
    const cells: string[] = [finalKey];
    let cursor = finalKey;
    while (cameFrom.has(cursor)) {
      cursor = cameFrom.get(cursor)!;
      cells.push(cursor);
    }
    cells.reverse();
    return cells.map((cellKey) => {
      const [x, z] = cellKey.split(",").map(Number);
      return toWorld({ x, z });
    });
  }

  private simplifyGridRoute(points: Vector3[], start: Vector3, goal: Vector3): Vector3[] {
    if (!points.length) {
      return [];
    }
    const simplified: Vector3[] = [];
    let anchor = start.clone();
    let index = 0;
    while (index < points.length) {
      let best = index;
      for (let candidate = points.length - 1; candidate >= index; candidate -= 1) {
        if (!this.findBlockingObstacle(anchor, points[candidate])) {
          best = candidate;
          break;
        }
      }
      const next = points[best].clone();
      if (next.distanceTo(anchor) > 0.15) {
        simplified.push(next);
        anchor = next;
      }
      index = best + 1;
    }
    if (!this.findBlockingObstacle(anchor, goal)) {
      if (!simplified.length || simplified[simplified.length - 1].distanceTo(goal) > 0.15) {
        simplified.push(goal.clone());
      }
    }
    return simplified;
  }

  private closestClearPoint(start: Vector3, goal: Vector3): Vector3 {
    const direction = goal.clone().sub(start);
    const length = direction.length();
    if (length < EPSILON) {
      return this.resolveStandingPoint(start);
    }
    direction.normalize();
    let candidate = start.clone();
    for (let distance = 0.2; distance <= length; distance += 0.2) {
      const probe = start.clone().addScaledVector(direction, distance);
      if (this.findBlockingObstacle(start, probe)) {
        break;
      }
      candidate = this.resolveStandingPoint(probe);
    }
    return candidate;
  }

  private routeCost(start: Vector3, waypoint: Vector3, goal: Vector3): number {
    return start.distanceTo(waypoint) + waypoint.distanceTo(goal);
  }
}
