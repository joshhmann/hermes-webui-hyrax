/**
 * Geometry repro for door_01.open — is the standing point reachable from
 * the recenter point, with the door obstacle ENABLED (closed) and DISABLED
 * (open)? Pure math, no ARDY. Mirrors TaiRoomScene registration exactly.
 */
import { readFile } from 'node:fs/promises'
import { Vector3 } from 'three'
import { RoomNavigation } from '../src/embodiment/navigation/RoomNavigation.ts'

const LOFT_ACTOR_RADIUS = 0.22

const manifest = JSON.parse(
  await readFile(new URL('../rooms/tai-loft.json', import.meta.url), 'utf8'),
)

const nav = RoomNavigation.fromManifest(manifest, LOFT_ACTOR_RADIUS)

// registerStatefulObstacles — door_01
for (const object of manifest.objects) {
  if (!object.states || !object.obstacle) continue
  nav.addBoxObstacle(
    object.id,
    new Vector3(object.obstacle.center[0], 0, object.obstacle.center[1]),
    new Vector3(object.obstacle.halfSize[0] * 2, 1, object.obstacle.halfSize[1] * 2),
    object.obstacle.padding,
  )
}

const door = manifest.objects.find((o) => o.id === 'door_01')
const open = door.interactions.find((i) => i.id === 'open')

console.log('=== manifest obstacles ===')
for (const o of manifest.obstacles) console.log(`  ${o.id} center=(${o.center}) half=(${o.halfSize}) pad=${o.padding}`)
console.log('=== nav obstacles (incl stateful) ===')
for (const o of nav.listObstacles()) console.log(`  ${o.id} center=(${o.center.x.toFixed(2)},${o.center.z.toFixed(2)}) half=(${o.halfSize.x.toFixed(2)},${o.halfSize.z.toFixed(2)}) pad=${o.padding.toFixed(2)} enabled=${o.enabled}`)

const start = new Vector3(0, 0, 0.15)
const spot = new Vector3(open.spot[0], 0, open.spot[1])
const standing = nav.resolveStandingPoint(spot)

console.log('\n=== door_01.open ===')
console.log(`  interaction spot: (${spot.x}, ${spot.z})`)
console.log(`  resolved standing: (${standing.x.toFixed(3)}, ${standing.z.toFixed(3)})`)

for (const [label, enabled] of [['closed(enabled)', true], ['open(disabled)', false]]) {
  nav.setObstacleEnabled('door_01', enabled)
  const route = nav.planRoute(start, standing)
  const clear = nav.isRouteClear(start, route)
  const blocked = nav.firstBlockingObstacleId(start, route)
  const cost = route.reduce((acc, p) => acc + (p === route[0] ? 0 : p.distanceTo(route[route.indexOf(p) - 1])), 0)
  console.log(`\n  door ${label}: planRoute(${start.x},${start.z}) -> (${standing.x},${standing.z})`)
  console.log(`    waypoints: ${route.map((p) => `(${p.x.toFixed(2)},${p.z.toFixed(2)})`).join(' -> ')}`)
  console.log(`    clear=${clear} firstBlocking=${blocked} length=${cost.toFixed(2)}m`)
}

// also: direct segment check from a few plausible positions
console.log('\n=== direct-segment blocking from recenter (constrainMovement path) ===')
for (const from of [[0, 0.15], [0.12, 0.42]]) {
  const f = new Vector3(from[0], 0, from[1])
  nav.setObstacleEnabled('door_01', true)
  const blocked = nav.firstBlockingObstacleId(f, [standing])
  console.log(`  from (${from}): firstBlocking=${blocked}`)
}
