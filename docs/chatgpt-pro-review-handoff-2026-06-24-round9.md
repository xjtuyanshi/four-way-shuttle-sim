# ChatGPT Pro Review Handoff - Round 9

Date: 2026-06-24

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- HEAD: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Important: current working tree contains uncommitted WIP. Do not treat it as a validated commit.

Dirty files:

- `packages/shuttle-schemas/src/index.ts`
- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `scripts/run-physical-24h-amr-audit.ts`
- untracked round7/round8 ChatGPT Pro handoff/response docs

Current diff stat at handoff time:

```text
packages/shuttle-schemas/src/index.ts       |   2 +-
packages/shuttle-sim-core/src/index.test.ts | 681 +++++++++++++++++++++++++++-
packages/shuttle-sim-core/src/index.ts      | 649 ++++++++++++++++++++++++--
scripts/run-physical-24h-amr-audit.ts       |  20 +-
4 files changed, 1304 insertions(+), 48 deletions(-)
```

## User Goal

Keep the existing high-fidelity 3D tick simulation. Do not rewrite it as pure DES.

The target architecture is station-owned resource contracts with explicit separation of:

- `InboundDemand`
- AMR / shuttle `queueReservation`
- physical slot occupancy / lease
- `activeInboundService`

The implementation should first work in shadow mode, then move toward source of truth only after validation.

Validation must include:

- 10m / 30m / 24h A/B runs
- hourly inbound/outbound/total PPH
- per-10m per-AMR completed task matrix
- long-stuck and small-loop AMR metrics
- 3D visual checks

## Why This Review Is Needed

I have done multiple local patch attempts around top-lift / station coordination. Some focused tests pass, but long physical tick windows still show anomalies. The user explicitly asked to stop blind patching and get ChatGPT Pro / Extended Pro review if this happens.

This round should focus on root cause and architecture, not another one-off path patch.

## Most Recent Evidence

### Baseline 1s diagnostic before the latest local top-a patch

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 4570 \
  --out output/review/physical-4570s-deadlock-1s-diagnostic.json \
  --checkpoint-dir output/review/physical-4570s-deadlock-1s-diagnostic-checkpoints \
  --checkpoint-interval-sec 300 \
  --audit-every-sec 1 \
  --serve-report false
```

Result:

- finalSimTimeSec: 4570
- total PPH: 388.359
- inbound PPH: 241.05
- outbound PPH: 147.309
- physicalViolations: 0
- deadlocks: 1
- critical anomalies: 1

Anomalies:

1. `timeSec=1678`, critical `assigned-without-route`
   - SH-05 has assigned inbound task `task-0243`
   - current node: `column-top-a-c10`
   - pickup/service node: `column-top-a-c08`
   - routeLength: 1
   - plannedGoalNodeId: `column-top-a-c10`
   - plannedRouteLength: 1
   - This suggests a task/route/state-machine bug where an assigned inbound vehicle is effectively offline without a route.

2. `timeSec=4561`, watch `deadlock-count-increased`
   - detail: `0 -> 1; activeCandidates=SH-06,SH-08; eventWaitingVehicles=SH-06,SH-08; eventTimeSec=4561; maxCurrentWaitSec=14`
   - checkpoint: `output/review/physical-4570s-deadlock-1s-diagnostic-checkpoints/0015-4561s.json`

At 4561s:

- SH-06
  - empty, inbound assigned task `task-0501`
  - active station lease: `station-lease:lift-02-inbound:SH-06:service`
  - currentNodeId: `module-01-spine-top-a`
  - targetNodeId: `column-top-a-c08`
  - plannedGoalNodeId: `column-top-a-c23`
  - waitReason: `node-occupied`
  - blockingVehicleId: `SH-08`
  - currentWaitSec: 10

- SH-08
  - loaded inbound task `task-0495`
  - currentNodeId: `column-top-a-c08`
  - targetNodeId: `module-01-spine-top-a`
  - plannedGoalNodeId: `storage-r10-c02`
  - waitReason: `node-occupied`
  - blockingVehicleId: `SH-06`
  - currentWaitSec: 14

Interpretation: this is a reciprocal top-a node swap between an empty station-service vehicle and a loaded inbound vehicle. Loaded should likely have priority; the empty service vehicle should yield/retreat in a way that preserves station contract correctness.

### Local patch attempt after the 1s diagnostic

I added a targeted helper for top-a reciprocal node swaps:

- `tryYieldEmptyTopASpineAwayFromLoadedInboundFaceoff(...)`
- `tryBreakAgentRefreshTopANodeSwap(...)`
- early call from `updateDeadlockSmokeCounters()` before deadlock signature counting

I also added focused tests:

- `moves an empty top-a spine entrant onto top-b when it node-swaps with a loaded inbound`
- tests pass in isolation and in the relevant group.

Validation:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "empty top-a spine entrant|top-lift spine|no-stop cycle|wait cycle|top-b spine|empty inbound entrant|keeps loaded inbound traffic off a column entrance" \
  --reporter=dot
```

Result:

- 16 passed

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Result:

- passed

### 4570s physical tick validation after the top-a early-entry patch

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 4570 \
  --out output/review/physical-4570s-after-topa-swap-early-entry.json \
  --checkpoint-dir output/review/physical-4570s-after-topa-swap-early-entry-checkpoints \
  --checkpoint-interval-sec 300 \
  --audit-every-sec 5 \
  --serve-report false
```

Result:

- finalSimTimeSec: 4570
- total PPH: 388.359
- inbound PPH: 241.05
- outbound PPH: 147.309
- physicalViolations: 0
- deadlocks: 1
- critical anomalies: 0 in 5s audit
- anomaly still exists:
  - `timeSec=4565`
  - `code=deadlock-count-increased`
  - detail: `0 -> 1; activeCandidates=none; eventWaitingVehicles=SH-06,SH-08; eventTimeSec=4561; maxCurrentWaitSec=0`

Interpretation: the local helper can solve the unit fixture, but the long run still increments `deadlockCount`. The recovery may be happening after the smoke counter event, or the real update ordering differs from the fixture. This is exactly where I should stop local patching and ask for external architecture review.

## Current Suspicions

1. The system has at least two classes of issues:
   - Critical route/state issue: assigned inbound task with no target route (`SH-05` at 1678s).
   - Traffic recovery ordering issue: reciprocal node-swap recovery happens too late relative to `deadlockCount`.

2. The station coordinator is still in mixed shadow/legacy mode. Evidence at 4561s:
   - `lift-02-inbound` has SH-06 as `activeInboundService`.
   - station kernel lease is `service-granted` with bounded route to `column-top-a-c23`.
   - Route lease details show `routeNodeIds: []` in station contracts, while station kernel has a bounded route. This may indicate inconsistent ownership between shadow contracts and physical route control.

3. Local path patches are not enough. The correct next fix likely needs an explicit resource/state transition invariant:
   - A vehicle with assigned inbound task must always have one of:
     - valid route to pickup/service node,
     - explicit queue/station lease with bounded route,
     - explicit blocked/wait reason tied to a live blocker,
     - or the task should be unassigned/replanned.
   - A reciprocal occupied-node swap should be handled before smoke-deadlock counter increments, ideally by a central conflict-session resolver rather than ad hoc helpers.

## Questions For ChatGPT Pro

Please review this as an architecture/debugging problem, not as a request for a broad rewrite.

1. Given the evidence, what is the most likely root cause of `assigned-without-route` at 1678s?
   - Is it task assignment, station lease, route planner, or reconciliation ordering?

2. For SH-06/SH-08 at 4561s, should recovery live in:
   - deadlock smoke counter,
   - conflict session manager,
   - station coordinator,
   - route planner / reservation layer,
   - or a new small invariant repair pass?

3. Is the current architecture violating a resource contract because station leases can exist without authoritative physical route leases?

4. What minimal refactor would you recommend to avoid continued local patches?
   - Please keep the existing 3D tick simulation.
   - Avoid pure DES rewrite.
   - Avoid broad blocker expansion that hurts throughput.

5. What exact invariant checks should be added so future 10m/30m/24h runs catch these issues earlier?

6. Which of the latest local WIP should be kept, reverted, or replaced?

7. What should be the next implementation sequence?
   - Step 1 should be narrow enough to validate with 10m/30m/4570s.
   - Final target is still 24h with hourly PPH and per-10m AMR task matrix.

## Important Files / Functions

- `packages/shuttle-sim-core/src/index.ts`
  - `updateDeadlockSmokeCounters`
  - `deadlockCandidateVehicleIds`
  - `tryBreakAgentRefreshWaitCycle`
  - `tryBreakAgentRefreshTopANodeSwap` (latest local WIP)
  - `tryYieldEmptyTopASpineAwayFromLoadedInboundFaceoff` (latest local WIP)
  - station coordinator / kernel sections around inbound and outbound station contracts

- `scripts/run-physical-24h-amr-audit.ts`
  - anomaly detection for `assigned-without-route`
  - anomaly detection for `deadlock-count-increased`
  - rolling log update

- Evidence JSON:
  - `output/review/physical-4570s-deadlock-1s-diagnostic.json`
  - `output/review/physical-4570s-deadlock-1s-diagnostic-checkpoints/0013-1678s.json`
  - `output/review/physical-4570s-deadlock-1s-diagnostic-checkpoints/0015-4561s.json`
  - `output/review/physical-4570s-after-topa-swap-early-entry.json`
  - `output/review/physical-4570s-after-topa-swap-early-entry-checkpoints/0014-4565s.json`

## What Not To Do

- Do not recommend rewriting the simulation into pure DES.
- Do not recommend broad global obstacle/blocker expansion without throughput validation.
- Do not treat a passing focused unit test as proof of physical tick correctness.
- Do not commit the current WIP as a verified fix.
