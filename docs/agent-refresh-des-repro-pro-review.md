# ChatGPT Pro Review Packet: Agent-Refresh DES Reproducibility and Avoidance Stabilization

Use this packet to review the current `codex/traffic-v2-flow-debug` branch for the four-way shuttle demo.

Repository:

- `https://github.com/xjtuyanshi/four-way-shuttle-sim`

Primary review scope:

- `agent-refresh` control mode for the all-inbound 8-shuttle demo.
- DES determinism, snapshot/replay, and avoidance stability.
- Do not review outbound feature completeness yet. Outbound is the next phase.

Required output:

1. Must-fix findings before we continue to outbound, ordered by severity.
2. Concrete implementation recommendations for deterministic replay and local dynamic avoidance.
3. Whether the current `agent-refresh` direction is salvageable with bounded fixes, or should be reworked into a cleaner event-sourced / conflict-session controller.

## Current Product Goal

The demo scenario is:

- 8 shuttles.
- 8 inbound lifts.
- 7200 PPH inbound requested.
- 0 outbound.
- `agent-refresh` is the demo default control mode.
- 2D/3D dashboard consumes SimCore state and should not drive scheduling.

The user wants the MVP logic to feel simple and natural:

- Each shuttle receives a task and computes one shortest planned route.
- It follows that planned route.
- Only near-field dynamic shuttle conflicts should trigger local avoidance.
- Empty shuttles should yield to loaded shuttles.
- A yielding shuttle should side-yield into a legal pocket if possible.
- Reversing should be rare, only when side-yield space is unavailable.
- After local avoidance, the shuttle should return to the next viable waypoint on its planned route.

## Current Recent Changes

### Inbound Source Buffer Model

The previous inbound source model coupled load creation to task creation. When active task WIP was saturated or a row was temporarily locked, a lift could visually appear empty even though the upstream source should have replenished it.

This branch changes inbound source behavior:

- `replenishInboundSourceBuffers()` fills every inbound lift with exactly one waiting load if it is empty.
- Source loads are independent of task WIP.
- Inbound task creation now selects an existing waiting source load instead of creating a new load inline.
- A source load cannot be assigned to two active inbound tasks.
- The replenisher runs before task generation and after vehicle advancement each tick.
- `inbound-lift-source-empty` now means truly no waiting lift source loads.
- `inbound-lift-source-assigned` means waiting source loads exist but are already bound to active tasks.

Primary code:

- `packages/shuttle-sim-core/src/index.ts`
  - `replenishInboundSourceBuffers()`
  - `selectInboundSourceLoadForTask()`
  - `inboundSourceUnavailableReason()`
- `apps/shuttle-api/src/validation.ts`
  - maps new source reasons into `liftSource`.
- `packages/shuttle-sim-core/src/index.test.ts`
  - `keeps inbound source buffers replenished independently of task WIP`
- `scripts/audit-shuttle-behavior.ts`
  - `auditInboundSourceBuffers()`

### Source / Audit Results

Verification run after the source model change:

- Typecheck passed.
- Targeted source test passed.
- High-inbound key tests passed when run individually.
- 600s behavior audit passed:
  - completed inbound: 103
  - inbound PPH: 618
  - active tasks: 8
  - queued tasks: 2
  - deadlocks: 0
  - livelocks: 0
  - physical violations: 0
  - anomaly counts: none
- 600s source-gap script passed:
  - max empty lift buffers while storage not full: 0
  - source gap ticks: 0
  - max waiting loads per lift: 1
  - deadlocks: 0
  - physical violations: 0

Notes:

- A broad Vitest pattern run can still hit a Vitest worker `Timeout calling "onTaskUpdate"` after many long tests. Single targeted tests pass. This appears to be test-runner reporting overhead, not a failed assertion, but review should flag if this should be fixed before CI use.

## Known Live Demo Problem

The user observed an unnatural local-avoidance interaction around 3 minutes, specifically involving shuttles 4 and 5.

Live API event log evidence from the running packaged demo:

- `SH-04` reached `storage-r12-c19` at about `191.4s`.
- `SH-04` tried to return to `inbound-lift-top-02-row-12-transfer`.
- It first waited with:
  - reason: `avoidance-clearance`
  - blocker: `SH-08`
- Around `194.5s`, its blocker changed to:
  - reason: `avoidance-clearance`
  - blocker: `SH-05`
- It did not leave the temporary pocket until about `198.5s`.
- Total pocket wait was about `7.1s`, with about `4s` attributed to `SH-05`.

Interpretation:

- This is not a source starvation issue.
- This is not a missing task issue.
- This is a local avoidance / clearance exit issue.
- `SH-04` already yielded into a pocket, but the exit logic required the return path to look too clear before it could move.
- It does not behave like a local human/AMR rule of "move forward when the immediate next segment is clear enough, then resolve the next near-field interaction later."

Important caveat:

- A fresh seed replay from zero using both the TS source SimCore and packaged compiled SimCore did not reproduce the exact same `SH-04` / `SH-05` interaction at the same timestamp.
- This means the project still lacks industrial-grade DES reproducibility tooling.
- Same seed is not enough for debugging live dashboard behavior unless the exact scenario, tick history, commands, event log, and state snapshot are captured.

## Current Avoidance Architecture To Review

Relevant code paths in `packages/shuttle-sim-core/src/index.ts`:

- `agentRefreshMoveBlocker()`
- `agentRefreshColumnEdgeBlocker()`
- `agentRefreshLoadedColumnPathBlockingVehicleId()`
- `agentRefreshNearColumnSweptFootprintBlocker()`
- `agentRefreshHandleMoveBlock()`
- `agentRefreshHasHigherPriority()`
- `agentRefreshInstallSideYield()`
- `agentRefreshCommittedLocalRoute()`
- `agentRefreshNominalRouteToGoal()`
- `agentRefreshYieldHoldBlocker()`
- `agentRefreshDeadlockBlockerStillApplies()`
- `agentRefreshFootprintBlockerStillApplies()`
- `tryRetreatAgentRefreshNearFaceoff()`

Current intended behavior:

- Main route is stable.
- Local route is only temporary.
- Higher priority: loaded over empty, then earlier task/load, then smaller shuttle id.
- Lower-priority vehicle should side-yield into nearest legal storage/pocket.
- The local route should be short and should be cleared once no longer needed.

Observed risk:

- The current logic appears to be a set of local checks, not a durable "conflict session."
- Blocker identity can change while the yielder is waiting.
- The yielder may wait on clearance that is larger than the user expects.
- There is no explicit session owner/yielder contract that prevents flip-flop, over-waiting, or stale local-yield state.

## Review Questions

Please answer these directly:

1. DES reproducibility:
   - What is the correct implementation pattern for deterministic replay here?
   - Should every run be event-sourced, or is periodic full-state snapshot plus command log enough?
   - What exact data must be captured to reproduce the live dashboard state at 190s?
   - How should API playback speed and wall-clock ticking be structured so dashboard runs do not diverge from headless replay?

2. Avoidance architecture:
   - Is it acceptable to keep the current local-check based `agent-refresh` avoidance?
   - Or should we introduce explicit `ConflictSession` records, e.g. pair/resource, winner, yielder, start time, target clearance, local route, timeout fallback?
   - How should we prevent blocker flipping, mutual yielding, and excessive waiting in pockets?

3. Clearance logic:
   - Is `dynamicAvoidanceClearanceM = 0.5m` being used too broadly?
   - Should the return-from-pocket rule only check the immediate next edge/node and near-field swept footprint?
   - Should lift-column / transfer exit checks be restricted to a short horizon instead of treating a larger column path as blocked?

4. Testing:
   - What regression tests should be added for the `SH-04` / `SH-05` class of behavior?
   - Should tests assert "no tasked shuttle waits in a pocket longer than X seconds unless the immediate next edge/node is still occupied"?
   - Should audit scripts fail if a blocker is farther than the near-field threshold or if a blocker changes repeatedly while a local route is active?

5. Go/no-go:
   - Can we move to outbound after implementing snapshot/replay and one bounded avoidance-session fix?
   - Or are there deeper control issues that should be solved before adding outbound complexity?

## My Proposed Next Fix, Pending Review

I am leaning toward this as the next engineering step:

1. Add deterministic run capture:
   - `runId`
   - scenario JSON
   - seed
   - playback commands
   - fixed tick `dt`
   - event log
   - periodic full-state snapshots
   - optional user "mark anomaly now" snapshot button/API.

2. Add replay tools:
   - `scripts/replay-shuttle-run.ts --snapshot <file> --from <sec> --to <sec>`
   - dashboard export button for current run trace.

3. Replace ad hoc local-yield waiting with explicit conflict sessions:
   - pair key or resource key
   - winner/yielder fixed at session creation
   - yielder local route fixed until pocket reached or timeout
   - return allowed as soon as immediate next move is clear
   - session expires once separation/resource conflict clears
   - no blocker identity flipping without closing and opening a new session.

4. Add targeted tests:
   - empty vs loaded head-on: empty side-yields, loaded continues.
   - yielder leaves pocket within threshold after winner clears immediate path.
   - blocker identity does not oscillate within one conflict session.
   - no local route remains active longer than threshold unless immediate next move is physically blocked.
   - same seed plus command log plus snapshot replay reproduces state hash.

Please review this direction and the current code. Return blockers and a concrete recommended implementation order.
