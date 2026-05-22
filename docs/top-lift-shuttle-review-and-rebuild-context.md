# Top-Lift Shuttle Review And Rebuild Context

This document is the handoff context for reviewing or rebuilding the current
`codex/traffic-v2-flow-debug` shuttle simulator branch.

The implementation is a Bullseye-like / top-lift four-way shuttle simulation
prototype based on the user's reference CAD screenshots and operating
requirements. It is not an official Bullseye model, not vendor-certified, and
not calibrated from real mechanical data. Treat it as a software DES prototype
whose assumptions must remain explicit.

## Repository And Branch

- Repository: `https://github.com/xjtuyanshi/four-way-shuttle-sim`
- Branch: `codex/traffic-v2-flow-debug`
- Main local app: `http://localhost:5180`
- API: `http://localhost:8791`
- Default current demo: `createInboundOutboundDemoScenario()`
- Current layout calibration profile: `top-lift-column-v1`
- Current controller mode: `agent-refresh`

Use `git rev-parse HEAD` to bind this document to an exact commit before an
external review.

## Product Goal

The target is a clean customer-demo model for a top-lift column-fill shuttle
warehouse:

- Lifts are on the top side of the storage array, as shown in the user's CAD
  reference screenshots.
- Each large region has one inbound lift on the left and one outbound lift on
  the right.
- Every lift has one lift position plus three compact conveyor buffer positions.
- Shuttles are globally shared. Any shuttle can serve any inbound or outbound
  lift if the route is physically valid.
- A storage column is treated as one SKU. Inbound fills a whole SKU column before
  moving to the next column. Outbound drains a whole SKU column before moving to
  another column.
- A column is not used for both inbound and outbound at the same time. An
  outbound column becomes eligible for inbound only after it is empty.
- The model should feel simple: a shuttle receives a task, follows a stable
  shortest planned route, and only performs short local avoidance when a nearby
  shuttle conflict appears.

## Current Default Demo Scenario

The current customer-demo scenario loaded through the dashboard setup is:

- `2` top-lift regions.
- `8` shared shuttles.
- `3600 PPH` inbound request.
- `3600 PPH` outbound request.
- `4` initially full outbound SKU columns.
- `agent-refresh` traffic controller.
- `sourceBufferCapacity = 4`.
- `liftApproachCapacity = 4`.

The older inbound-only MVP scenario still exists:

- `createInboundMvpBaselineScenario()`
- name: `All Inbound 8 Shuttle 7200 PPH Stress`
- layout: `top-lift-column-v1`
- controller: `agent-refresh`
- `8` shuttles / `7200` inbound PPH / `0` outbound PPH

## Physical Layout Model

The top-lift layout generator creates a repeated horizontal module:

- One region is `14` storage columns wide and `14` storage rows tall.
- Conceptually, one region is four `7x7` storage zones:
  - upper-left 7x7
  - upper-right 7x7
  - lower-left 7x7
  - lower-right 7x7
- The middle aisle separates upper and lower storage banks.
- Adjacent regions connect horizontally and can be added to the right by
  increasing `layoutProfile.liftPairCount`.

Per region:

- `lift-XX-inbound` is the left top-side lift.
- `lift-XX-outbound` is the right top-side lift.
- Each lift has:
  - `lift-XX-kind` black-box lift node
  - `lift-XX-kind-buffer-01`
  - `lift-XX-kind-buffer-02`
  - `lift-XX-kind-buffer-03`
  - `lift-XX-kind-buffer-access`
  - inbound-only standby queue nodes:
    - `parking-lift-XX-inbound-queue`
    - `parking-lift-XX-inbound-queue-02`
    - `parking-lift-XX-inbound-queue-03`

The lift/conveyor interpretation is:

- Inbound source load appears at the lift and slides along the compact conveyor
  to `buffer-03`, the shuttle pickup position.
- Outbound loaded shuttle drops at the outbound conveyor pickup/dropoff end,
  currently `lift-XX-outbound-buffer-03`.
- The three buffer slots are vertical/compact in the layout, not long horizontal
  lanes that consume large footprint.

## Lane Semantics

This is important for review because earlier problems came from treating the
wrong aisle as single-lane.

Top and bottom travel corridors are bidirectional double-lane corridors. They
can hold two shuttles moving in opposite directions at the same time because
there are two parallel lane levels:

- `top-a`
- `top-b`
- `bottom-a`
- `bottom-b`

The current route-planning policy assigns nominal directions:

- `top-a`: eastbound / increasing x
- `top-b`: westbound / decreasing x
- `bottom-a`: eastbound / increasing x
- `bottom-b`: westbound / decreasing x

The middle aisle is different:

- `middle` is a single-lane horizontal aisle between upper and lower storage
  zones.
- A shuttle entering or using `middle` claims a travel direction.
- Opposite-direction shuttles cannot enter until that claim clears.
- Same-direction shuttles may follow, subject to normal node occupancy and
  minimum headway checks.
- The claim is derived from live route/position state, not stored as a permanent
  reservation, so it releases automatically when no vehicle is on or entering
  the middle aisle in that direction.

## Hard Physical Conditions

These are the conditions the model must never violate. Any optimization or
avoidance rule has to fit inside these boundaries.

### Node And Vehicle Occupancy

- Every node has capacity `1` in this top-lift model.
- Two shuttles cannot occupy the same node.
- A shuttle cannot move into a node currently occupied or actively targeted by
  another shuttle unless a specific local-yield rule has already made that move
  safe.
- Rectangular vehicle footprint and configured safety clearance still apply even
  when graph-node occupancy is clear.
- Moving head-on on the same edge is illegal unless the edge/lane model provides
  separate physical lanes.

### No-Stop And No-Parking Nodes

- `lift-blackbox`, lift throats, lift buffer access nodes, top/middle/bottom
  aisle intersections, and module/boundary spine nodes are no-stop / no-parking
  transit nodes.
- A route may pass through a no-stop node only when its continuation cell is
  clear enough to keep moving.
- A local-yield or taskless standby route must not terminate on
  `*-spine-middle` or any other no-stop control point.
- Storage cells and explicit parking/queue pockets are the only legal places to
  hold a shuttle for more than a short service/action phase.

### Lifts, Buffers, And Conveyors

- Each lift is a compact black-box source/sink with one lift position plus three
  conveyor buffer positions.
- The shuttle service point is the conveyor end, currently `buffer-03`; shuttles
  should not drive through the lift body to pick or drop.
- Inbound source backlog is limited to the lift body plus the three conveyor
  buffers.
- A source load cannot have two active inbound tasks.
- A lift/conveyor buffer slot cannot be simultaneously used by multiple loads or
  multiple shuttles.

### Storage And Load Movement

- One physical storage cell holds at most one pallet/load.
- A loaded shuttle cannot route through stored-load cells except for its own
  pickup/dropoff endpoint.
- Empty shuttles may use empty storage cells as conditional travel/yield space.
  This is allowed because it does not violate pallet collision or SKU placement
  rules, but only when the cell is empty, unclaimed, and not an active inbound
  dropoff target.
- A storage column is treated as one SKU.
- A column cannot be inbound and outbound at the same time.
- Inbound fills one complete column before moving to the next inbound column.
- Outbound drains one complete column before moving to another outbound column.
- After an outbound column is empty, it becomes eligible for inbound use.

### Lane Capacity

- Top and bottom corridors are physically modeled as two parallel one-capacity
  lanes. They should support opposite-direction travel by assigning vehicles to
  different lane levels.
- The middle aisle is a single physical lane. Opposite-direction vehicles cannot
  enter the same middle-aisle segment at the same time.
- Same-direction middle-aisle vehicles may follow subject to node occupancy,
  footprint clearance, and headway.
- Module and region-boundary spines connect top, middle, and bottom corridors.
  They are usable transit, not storage or queue locations.

## Current Avoidance Rules

The desired controller behavior is stable nominal routing plus short local
avoidance, not repeated global rerouting.

### Nominal Route

- `agent-refresh` assigns a task to a shuttle, computes a nominal route, and
  keeps that route unless the task changes or the route is invalid.
- Top/bottom long travel should use the double-lane direction split:
  `top-a` / `bottom-a` for increasing x, and `top-b` / `bottom-b` for decreasing
  x.
- The middle aisle remains available for column access and cross-region moves
  but is dynamically direction-claimed.
- Loaded inbound routes avoid stored loads and approach the selected column-fill
  target.
- Loaded outbound routes leave storage through a legal column/side access path
  before going to the outbound conveyor.

### Move Check Order

Before starting a leg, the controller checks:

- middle-aisle opposite-direction claims
- no-stop continuation clearance before entering critical middle-spine nodes
- target node occupancy
- target node claims / local route claims
- opposite edge movement
- minimum separation / swept-footprint clearance
- lift-column near conflicts
- storage-exit lookahead for vehicles leaving storage

### Local Yield

- Loaded shuttles have priority over empty shuttles.
- Earlier work has priority over later work.
- Shuttle id is only a deterministic final tiebreaker.
- Empty shuttles may yield into a legal adjacent storage, parking, access, or
  queue pocket.
- In the middle aisle, an empty shuttle may hide into the adjacent upper or
  lower storage cell when that cell is empty and unclaimed.
- If the first side step is a middle-aisle access node, the continuation may go
  one more step into an empty storage cell; this prevents the yielder from
  simply occupying the next middle-aisle cell and recreating the conflict.
- Yield endpoints are forbidden on `*-spine-middle` no-stop nodes.
- A yielding shuttle is held only until the winner has cleared the contested
  resume node, then it can resume a normal route.
- Queue-tail yielding may move a shuttle deeper into legal queue pockets so an
  earlier same-lift task can use the front pickup position.

### Deadlock And Livelock Handling

- The smoke detector still watches wait-for cycles and stale blockers.
- If a blocker no longer applies, the wait is cleared instead of being counted
  as a persistent deadlock.
- Special breakers handle loaded storage swaps, adjacent top-lift node swaps,
  and top-lift spine cycles.
- A repeated side-yield should be interpreted as a model bug unless the yielder
  is moving into a legal pocket that actually releases the blocked resource.

## Underused Physical Freedom

These are the places where the current model is still more conservative than
the physical rules require. They should be used deliberately rather than patched
case by case.

1. Empty shuttles can use more empty storage cells as real conditional travel
   space.

   The code now allows middle-aisle local yield into adjacent empty storage, but
   empty task routes still often treat storage as expensive or exceptional. The
   stronger rule should be: if the shuttle is empty, the cell is empty, and the
   cell is not claimed as an active load endpoint, it is legal temporary track.
   That can reduce unnecessary waiting in the middle aisle and near lift exits.

2. Top and bottom double lanes should absorb more long-distance traffic.

   The layout provides `top-a/top-b` and `bottom-a/bottom-b`, but routing can
   still send vehicles into middle/spine conflicts when a longer but cleaner
   double-lane path exists. Long cross-region travel should prefer double-lane
   corridors and reserve the middle aisle for column entry/exit or short local
   moves.

3. Region-boundary spines and one-lane gaps are under-modeled as traffic
   resources.

   The physical layout has vertical pass-through gaps between large regions.
   These should be treated as explicit single-lane resources with direction and
   release rules, not just anonymous graph edges. Same-direction convoy should
   be allowed; opposing direction should be gated before entry.

4. Lift-side queue pockets should be treated as real staging capacity.

   The physical idea is simple: one shuttle services the conveyor end while
   others wait off the aisle. The model should continue moving idle/assigned
   empty shuttles into legal queue pockets instead of leaving them far away or
   blocking no-stop nodes.

5. No-stop/no-parking should be a route invariant, not only a runtime check.

   The latest fix prevents some no-stop endpoints, but a cleaner invariant is:
   route planning may pass through no-stop nodes only if the full route contains
   a legal continuation and a legal terminal hold node. Any generated route that
   terminates on no-stop should be rejected immediately.

6. Column direction rules can be made more explicit.

   Inbound and outbound both use column-wise SKU logic, but the path planner
   should know whether a storage column is being filled, drained, or only used
   as empty-shuttle transit. That would reduce unnecessary conservative blocks
   while still preventing loaded shuttles from crossing stored loads.

7. Same-direction following can be used more confidently.

   Middle aisle and vertical gap rules should distinguish "opposite direction"
   from "same direction, safe headway." Overblocking same-direction followers is
   one reason shuttles appear idle even when there is work.

## Storage And SKU Rules

The current SKU simplification is column-level:

- One storage column equals one SKU.
- Inbound fills one whole column before switching columns.
- Outbound drains one whole column before switching columns.
- Outbound seeded columns start full enough for outbound testing.
- While a column is active outbound, inbound cannot store into it.
- After outbound drains a column, the column can become inbound-eligible.

Storage row numbering:

- Higher row numbers are lower/bottom positions in the rendered grid.
- Outbound selection currently drains bottom-up, for example `r14`, then `r13`,
  then `r12`.
- Inbound target selection also works column-wise and preserves the column-fill
  ordering.

Loaded shuttle constraints:

- A loaded inbound shuttle cannot route through stored-load cells while carrying
  another pallet to a dropoff.
- A loaded outbound shuttle exits the storage cell through a side/column access
  route and then goes to the outbound conveyor.
- Empty shuttles may use some storage cells as temporary movement space, but not
  if the cell is occupied, claimed, or reserved as another active inbound
  dropoff.

## Traffic Controller: Agent Refresh

`agent-refresh` is the current controller mode. Its intended mental model:

1. Assign a task to the nearest available shuttle.
2. Compute a stable nominal route to the task goal.
3. Keep that nominal route unless the task changes or the route becomes invalid.
4. Detect only near-field dynamic conflicts.
5. Resolve local conflicts with short local yield routes.
6. Return to a viable future waypoint on the nominal route.

Priority rules:

- Loaded shuttle over empty shuttle.
- Earlier task/load over later task/load.
- Smaller shuttle id as deterministic final tiebreaker.

Avoidance behavior:

- Side-yield into a legal nearby storage/access/queue pocket where possible.
- Avoid reversing unless there is no local pocket or no forward clearance.
- Local-yield nodes are short claims so another vehicle does not immediately
  move into the yielder's planned pocket.
- Queue-tail yielding can move a queued shuttle deeper into `queue-02` or
  `queue-03` when an earlier same-lift pickup needs the front position.

Recent controller fixes in this version:

- `agentRefreshShortestPath()` now applies top-lift lane direction filtering.
  Before this, the direction policy existed but agent-refresh shortest path
  ignored it.
- Top/bottom double lanes now split opposing travel by `*-a` / `*-b`.
- Middle aisle uses `middle-aisle-opposing-claim` to block only opposite
  direction entry.
- Same-direction middle aisle followers are allowed unless normal occupancy or
  clearance rules block them.
- Vehicles waiting outside the middle aisle on an opposing claim do not keep
  claiming the aisle forever.
- Empty inbound and outbound shuttles in the middle aisle may now yield into
  adjacent empty upper/lower storage pockets.
- Side-yield continuation can move from middle aisle to an adjacent middle access
  node and then into storage, so the yielder actually clears the conflict lane.
- Local-yield endpoints are blocked from `*-spine-middle` no-stop nodes.
- No-stop continuation checks can inspect the candidate route being installed,
  not only the vehicle's previously active route.
- Later same-lift inbound tasks get deeper queue targets based on earlier
  unreleased pickup work:
  - first waiting task: `queue`
  - second waiting task: `queue-02`
  - third waiting task: `queue-03`
- Later same-lift inbound tasks should wait behind earlier pickup tasks instead
  of forcing earlier pickup vehicles to bounce.

## Inbound Flow

Inbound source behavior:

- Each inbound lift has `sourceBufferCapacity = 4` source positions:
  - the lift body
  - `buffer-01`
  - `buffer-02`
  - `buffer-03`
- Source loads are independent of task WIP.
- Task generation selects an existing waiting source load.
- A source load cannot be assigned to two active inbound tasks.
- The pickup goal is usually `buffer-03`.
- If earlier same-lift pickup work is not released yet, later tasks route to a
  queue node rather than the pickup cell.

Inbound loaded behavior:

- After pickup, shuttle carries the load to the selected column-fill storage
  node.
- After dropoff, empty shuttle exits through the opposite side or through legal
  storage transit so it does not block the next load in the same column.

## Outbound Flow

Outbound is intentionally simplified for the demo:

- Some columns are initially full.
- Outbound selects from outbound-designated columns only.
- It drains a complete column bottom-up before switching.
- A column is not mixed inbound/outbound at the same time.
- The dropoff target is the outbound conveyor end (`buffer-03`), not the lift
  body.
- All shuttles are shared; an inbound-capable shuttle can be assigned outbound
  work when available.

Current outbound limitations:

- It is not yet a full industrial outbound sequencer.
- Same-column multi-shuttle outbound has limited concurrency to avoid loaded
  vehicles blocking each other in a narrow column.
- More work is needed to model multiple shuttles loading from the same outbound
  SKU column with strict bottom/second-bottom ordering and safe queue positions.

## Dashboard / UI Scope

The dashboard is a visual/debug subscriber, not the source of simulation truth.

Current UI features:

- Setup before run:
  - region count
  - shuttle count
  - initial outbound full columns
- 2D / 3D / Statistics tabs.
- Sidebar controls and dashboard metrics.
- Per-lift PPH in lift diagnostics.
- Aggregate PPH time curve.
- Per-lift PPH sparklines/time curves.

Authoritative state comes from `ShuttleSimCore`; 2D and 3D should render the
same state and should not schedule traffic.

## Important Files

Core simulation:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`

Schema:

- `packages/shuttle-schemas/src/index.ts`

API:

- `apps/shuttle-api/src/server.ts`
- `apps/shuttle-api/src/validation.ts`

Dashboard:

- `apps/shuttle-dashboard/src/App.tsx`
- `apps/shuttle-dashboard/src/App.test.ts`
- `apps/shuttle-dashboard/src/styles.css`
- `apps/shuttle-dashboard/src/ShuttleScene3D.tsx`

Layout/profile/static contract:

- `packages/shuttle-sim-core/src/layout-profile.ts`
- `packages/shuttle-sim-core/src/static-scene.ts`
- `docs/layout-reference.md`
- `docs/real-layout-calibration.md`

## Local Commands

Install:

```bash
corepack pnpm install
```

Validate:

```bash
corepack pnpm run typecheck
corepack pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts
corepack pnpm exec vitest run apps/shuttle-dashboard/src/App.test.ts
```

Run:

```bash
corepack pnpm dev:api
corepack pnpm preview:dashboard
```

Open:

```text
http://localhost:5180
```

Load the current two-region mixed demo through the API:

```bash
curl -X POST http://localhost:8791/api/shuttle/setup \
  -H 'content-type: application/json' \
  -d '{"regionCount":2,"shuttleCount":8,"initialOutboundFullColumns":4}'
```

## Verification From This Version

Local verification completed before this handoff:

- `corepack pnpm run typecheck`: passed.
- `corepack pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts`:
  passed, `173/173`.

Mixed 2-region / 8-shuttle offline smoke after the middle-aisle yield clearing
fix:

- 900s:
  - inbound completed: `31`
  - outbound completed: `60`
  - inbound PPH: `124`
  - outbound PPH: `240`
  - total PPH: `364`
  - deadlock count: `0`
  - livelock count: `0`
  - physical violations: `0`
  - no invalid `*-spine-middle` side-yield endpoints
- 1800s:
  - inbound completed: `71`
  - outbound completed: `108`
  - inbound PPH: `142`
  - outbound PPH: `216`
  - total PPH: `358`
  - active tasks: `6`
  - queued tasks: `0`
  - deadlock count: `0`
  - livelock count: `0`
  - physical violations: `0`
  - current continuous waits at end: `0`
  - no invalid `*-spine-middle` side-yield endpoints
  - no `no-stop-continuation-blocked` waits with a missing blocker

Interpretation:

- The middle-aisle storage-pocket yield rule is now explicitly covered by
  targeted tests for inbound and outbound empty shuttles.
- The controller now blocks entry into no-stop middle-spine nodes unless the
  continuation cell is clear or visible in the candidate route.
- The build is more stable than the prior 300s/600s smoke result, but it is not
  yet a final throughput-stable industrial capacity model.
- The next serious logic area is not "avoid any conflict"; it is using the
  available legal space more aggressively so shuttles do not wait far from
  useful work.

## Known Residual Risks

These are not hidden. A reviewer should focus here.

1. Throughput is still far below requested demand.
   - `3600 inbound + 3600 outbound PPH` is a demand stress input, not achieved
     throughput.
   - The current 1800s mixed smoke achieved `358` total PPH.
   - The model is now better at staying alive, but not yet good enough as a
     capacity claim.

2. Legal empty-storage transit is still underused.
   - The latest fix allows middle-aisle conflict yield into adjacent empty
     storage.
   - Empty shuttle nominal routing still does not fully treat empty storage
     cells as general conditional track.
   - This is probably one reason shuttles still appear idle or wait away from
     useful lift queue positions.

3. Outbound is simplified.
   - It supports seeded outbound columns and conveyor dropoff.
   - It does not yet fully implement highly parallel same-column outbound
     loading where shuttle 1 takes bottom, shuttle 2 takes second bottom, etc.

4. Single-lane resources are implicit.
   - Middle aisle claims work as a live route/position rule.
   - Region-boundary vertical gaps and spine resources should become explicit
     segment claims with same-direction convoy and opposite-direction gating.

5. No-stop route invariants need to be stricter.
   - Runtime checks now prevent the observed no-stop middle-spine stranding.
   - A stronger planner invariant should reject any route whose terminal node is
     no-stop/no-parking unless it is an immediate service action.

6. Geometry is assumption-grade.
   - It is inspired by Bullseye-like reference images and user-provided CAD
     screenshots.
   - It is not calibrated to a real Bullseye machine footprint, acceleration,
     lift cycle time, or conveyor takt time.

7. The visual twin is demo-quality.
   - 2D is closer to the logic truth.
   - 3D needs continued asset/lighting/material polish.

8. The current model uses graph nodes and point-to-point vehicle bodies.
   - It has rectangular footprint overlap checks, but it is not a full
     high-fidelity mechanical clearance / PLC safety simulation.

## Review Questions For Another AI

Ask the reviewer:

1. Is the top/bottom double-lane direction model correct and globally valid?
2. Is the middle-aisle direction claim implemented as a real traffic rule rather
   than a one-off patch?
3. Does the inbound queue target logic correctly model one pickup cell plus
   queue positions without creating artificial starvation?
4. Where should same-column outbound parallel loading be added without causing
   loaded shuttle swaps inside the storage column?
5. Should `agent-refresh` remain local-rule based, or should the single-lane and
   queue resources become explicit event-sourced reservations?
6. What invariants should be added before calling the mixed inbound/outbound demo
   stable?
7. Are the PPH metrics and per-lift curves measuring completed work correctly,
   or do we need separate lift service cycle instrumentation?

## Build-From-Scratch Blueprint

A clean rebuild should keep these layers separate.

### 1. Scenario Schema

Define:

- vehicles:
  - count
  - length/width/clearance
  - loaded/empty speed limits
- layout:
  - nodes with id/type/x/z/noStop/noParking/liftKind
  - edges with from/to/length/direction/conflict group
  - calibration profile id and assumption notes
- task generation:
  - inbound PPH
  - outbound PPH
  - initial outbound full columns
  - max active tasks
- traffic policy:
  - controller mode
  - source buffer capacity
  - lift approach capacity
  - collision avoidance on/off

### 2. Layout Generator

Generate top-lift regions horizontally:

- `regionCount * 14` storage columns.
- `14` storage rows.
- `top-a`, `top-b`, `middle`, `bottom-a`, `bottom-b` access levels.
- One inbound lift and one outbound lift per region.
- Three buffer nodes per lift.
- Three inbound queue nodes per inbound lift.
- Region-boundary spine nodes so adjacent regions connect with a one-lane-sized
  pass-through gap.

### 3. Load And Task Model

Inbound:

- Replenish lift source buffers independently of task WIP.
- Generate tasks from waiting source loads.
- Select inbound storage by active SKU column until full.
- Assign later same-lift tasks to queue targets while earlier pickup tasks are
  unreleased.

Outbound:

- Seed dedicated outbound columns.
- Select bottom-most load from the active outbound SKU column.
- When column empty, release it to inbound eligibility.
- Drop loads at outbound conveyor end.

### 4. Routing

Use Dijkstra/A* over graph edges.

Route rules:

- Top/bottom double-lane directional filter:
  - `top-a` / `bottom-a`: increasing x
  - `top-b` / `bottom-b`: decreasing x
- Middle aisle remains physically bidirectional but dynamically direction-claimed.
- Loaded inbound cannot route through stored loads.
- Loaded outbound should exit its storage cell via legal side/column access before
  going to the outbound conveyor.
- Empty vehicles may use legal temporary storage pockets only if unoccupied,
  unclaimed, and not blocking active load placement.

### 5. Traffic Control

Implement a stable nominal route plus local avoidance:

- Assign route once per task unless target/route invalidates.
- Before each move, check:
  - current occupancy consistency
  - target occupancy
  - local route claims
  - target claims
  - opposite edge movement
  - middle aisle opposing claim
  - min separation / footprint overlap
- If blocked:
  - if same-direction follower, wait.
  - if middle opposing claim, wait.
  - otherwise install a short side-yield if legal.
  - avoid long global reroute for a local conflict.

### 6. Metrics

Track:

- completed inbound / outbound
- total PPH
- inbound PPH
- outbound PPH
- per-lift completed count and PPH
- task wait/cycle time
- blocked time by reason
- deadlock/livelock counters
- physical violations
- vehicle utilization and idle time

### 7. Tests And Invariants

Minimum tests before customer demo:

- schema accepts generated top-lift layout.
- region count expands by whole regions.
- every route node pair has a graph edge.
- top/bottom lanes reject wrong-direction horizontal moves.
- middle aisle blocks opposite-direction entry and allows same-direction follow.
- inbound source buffer does not starve while storage is available.
- later same-lift inbound tasks queue behind earlier pickup.
- outbound drains seeded columns bottom-up.
- no load has multiple active tasks.
- no two vehicles occupy the same node.
- no loaded route crosses a stored load except its own pickup/dropoff endpoint.
- long smoke has zero physical violations.

## Suggested External Review Prompt

```text
Please review this shuttle simulator branch from a logic/modeling perspective.

Repo:
https://github.com/xjtuyanshi/four-way-shuttle-sim

Branch:
codex/traffic-v2-flow-debug

Commit:
<paste current git commit hash>

Context:
The model is a Bullseye-like top-lift four-way shuttle prototype, not an
official Bullseye implementation. It uses a repeated top-lift region layout:
one left inbound lift and one right outbound lift per region; each lift has one
lift position plus three compact conveyor buffer positions. Storage is modeled
as 14x14 cells per region, conceptually four 7x7 zones. One storage column is
one SKU. Inbound fills a full column; outbound drains a full column; a column is
not inbound and outbound at the same time.

Current focus:
- top/bottom corridors are double-lane and should split opposite directions.
- middle aisle is single-lane and should be direction-claimed: opposite
  direction cannot enter, same direction can follow.
- agent-refresh should keep a stable nominal shortest route and only do local
  avoidance near conflicts.
- empty shuttles may use empty, unclaimed storage cells as temporary travel or
  yield space, especially to clear the middle aisle.
- no-stop / no-parking nodes must never become local-yield or standby route
  endpoints.
- all shuttles are shared across all lifts.
- outbound is still simplified.

Please inspect:
- packages/shuttle-sim-core/src/index.ts
- packages/shuttle-sim-core/src/index.test.ts
- packages/shuttle-schemas/src/index.ts
- apps/shuttle-api/src/server.ts
- apps/shuttle-dashboard/src/App.tsx

Local verification:
- typecheck passed.
- SimCore tests passed: 173/173.
- mixed 2-region/8-shuttle 1800s smoke:
  - deadlock count: 0
  - livelock count: 0
  - physical violations: 0
  - current waits at end: 0
- throughput remains low relative to the 3600 + 3600 PPH demand input.

Please answer:
1. Are the top/bottom double-lane and middle-aisle claim rules globally valid?
2. Which legal empty-space opportunities are still underused by the planner?
3. Which code looks like one-off patching rather than a clean model rule?
4. What would you change if rebuilding from scratch?
5. What tests/invariants are missing?
```
