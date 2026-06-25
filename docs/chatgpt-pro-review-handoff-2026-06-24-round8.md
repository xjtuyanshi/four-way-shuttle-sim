# ChatGPT Pro Review Handoff - Round 8 - 2026-06-24

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Last pushed commit: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Remote branch: `origin/codex/traffic-v2-flow-debug`
- Working tree: intentionally dirty. Do not treat this as a passing version.
- Dirty tracked files:
  - `packages/shuttle-schemas/src/index.ts`
  - `packages/shuttle-sim-core/src/index.ts`
  - `packages/shuttle-sim-core/src/index.test.ts`
- New local review docs:
  - `docs/chatgpt-pro-review-handoff-2026-06-24-round7.md`
  - `docs/chatgpt-pro-review-response-2026-06-24-round7.md`
  - `docs/chatgpt-pro-review-handoff-2026-06-24-round8.md`

## User Goal

The user wants the existing high-fidelity physical 3D tick simulation fixed, not replaced by a pure DES rewrite. The system must:

- keep all AMRs/shuttles on yellow feasible grid nodes only;
- prevent 3D/2D overlap, pass-point crossing, and hidden stuck vehicles;
- make lift queue behavior simple and resource-based: AMR is a resource, lift/station owns queue/pass/service resources, and queue order should be explicit;
- run long windows, ultimately 24h, with hourly PPH, per-10-minute AMR task counts, stuck/loop metrics, and a rolling HTML log explaining each rerun, problem, fix, and result.

The user explicitly asked Codex not to keep blindly patching. This handoff is for an external architecture review before the next local implementation step.

## Round 7 External Review Summary

ChatGPT Pro Round 7 concluded:

- The current slot0 + egress dirty worktree should not be committed as a passing version.
- Do not fully roll back: keep slot0, visit, explicit envelope topology, and foreign egress direction.
- Root cause was split-brain station ownership:
  - a vehicle at pass/slot0/head did not atomically become the controller head reservation;
  - egress depended on an active transition;
  - active transition depended on a drained envelope;
  - therefore service grant and drain had a circular dependency.
- Recommended minimum fix:
  - use `activeVisit` as the aggregate root;
  - separate active visit admission from physical slot0/envelope leases;
  - allow a pre-service station-owned draining epoch before service grant;
  - do not mutate controller state from read/query paths;
  - no `gap=unknown`, no long `outbound-station-await-transition`, no hidden circular waits.

## WIP Implemented After Round 7

This WIP is uncommitted because the validation gate still does not pass.

Implemented direction:

- Added `activeVisitRequestId`, `mode: shared | draining | exclusive`, and `drainEpoch` to outbound station runtime.
- Added request states `at-slot0` and `draining`.
- Moved station admission/read paths toward `activeVisitRequestId` instead of mutating slot-owner reconciliation.
- Added active-visit reconciliation and projection from active visit to slot owner.
- Changed transition selection:
  - if active visit vehicle is loaded at pass and the service envelope is clear, grant pass/service transition;
  - if foreign occupants exist, start a drain epoch before active transition;
  - foreign vehicles inside protected nodes get an egress route instead of waiting in place.
- Added focused regression test for foreign occupant drain before granting outbound service transition.

## Local Validation

Passed:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit

./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "outbound station envelope passes|allows foreign vehicles already inside an outbound envelope|drains foreign occupants before granting an outbound slot0 service transition|limits outbound station work admission|grants only the slot owner|holds outbound station envelope ownership" \
  --reporter=dot
```

Result: `6 passed | 517 skipped`.

## First WIP 10m Gate - Failed Early

File:

- `output/review/physical-10m-activevisit-drain-smoke.json`

Result:

- stopped at `finalSimTimeSec: 480`
- total PPH: `270`
- inbound PPH: `202.5`
- outbound PPH: `67.5`
- `deadlock-count-increased`: 1

Observed root:

- Active visit for `lift-02-outbound` needed approach nodes around `column-bottom-a-c19/c20/c21`.
- A foreign vehicle was already in the approach area.
- Protection logic blocked it from moving further into the active visit approach, but did not give it a valid egress route.
- This created a wait chain involving SH-01, SH-02, SH-04, SH-05, and SH-07.

Local patch after this:

- Included approach-slot occupants in active-visit protected nodes.
- Foreign vehicles already in approach/service protected nodes get an egress goal to the nearest outside feasible node.
- Outside vehicles are blocked from entering protected nodes.

## Second WIP 10m Gate - Completed But Bad

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 600 \
  --out output/review/physical-10m-activevisit-drain-approach-smoke.json \
  --checkpoint-dir output/review/physical-10m-activevisit-drain-approach-smoke-checkpoints \
  --change-note "Active visit drain including approach-slot occupants" \
  --run-reason "Previous 10m activeVisit smoke failed at 480s because a foreign vehicle in an outbound approach slot was blocked from pass but not given an egress route. This run validates station-owned egress for both approach slots and service envelope." \
  --problems-observed "480s failure: SH-07 active visit for lift-02-outbound needed c20/c21, SH-05 was in c20 and blocked from entering c21, causing SH-01/SH-02/SH-04/SH-05/SH-07 wait chain." \
  --problems-solved "Active visit protected nodes now include approach slots and service envelope; foreign vehicles already in protected nodes get an egress goal to the nearest outside feasible node, while outside vehicles remain blocked from entering." \
  --run-decision "10m smoke; expect no recurrence of 480s approach-slot deadlock and 0 critical anomalies." \
  --stop-on-critical
```

Result:

- completed `600s`
- no deadlock/livelock/physical violation
- total PPH: `132`
- inbound PPH: `72`
- outbound PPH: `60`
- `anomalies`: 6
- `criticalAnomalies`: 0
- final waiting vehicles: 5
- all anomalies are `long-wait-window`

Final waiting vehicles:

```json
[
  {
    "vehicleId": "SH-01",
    "currentNodeId": "storage-r14-c08",
    "targetNodeId": "column-bottom-a-c08",
    "waitReason": "outbound-station-visit-owned",
    "blockingVehicleId": "SH-05",
    "currentWaitSec": 441.2
  },
  {
    "vehicleId": "SH-02",
    "currentNodeId": "storage-r13-c08",
    "targetNodeId": "storage-r14-c08",
    "waitReason": "node-occupied",
    "blockingVehicleId": "SH-01",
    "currentWaitSec": 442.2
  },
  {
    "vehicleId": "SH-03",
    "currentNodeId": "storage-r14-c09",
    "targetNodeId": "column-bottom-a-c09",
    "waitReason": "outbound-station-visit-owned",
    "blockingVehicleId": "SH-05",
    "currentWaitSec": 441.2
  },
  {
    "vehicleId": "SH-06",
    "currentNodeId": "module-02-spine-bottom-a",
    "targetNodeId": "column-bottom-a-c21",
    "waitReason": "storage-exit-precedence",
    "blockingVehicleId": "SH-08",
    "currentWaitSec": 402
  },
  {
    "vehicleId": "SH-08",
    "currentNodeId": "storage-r14-c21",
    "targetNodeId": "column-bottom-a-c21",
    "waitReason": "outbound-station-visit-owned",
    "blockingVehicleId": "SH-06",
    "currentWaitSec": 405.2
  }
]
```

Station diagnostics at 600s:

- `lift-01-outbound`
  - active outbound visit: `task-0020`, vehicle `SH-05`
  - visit phase: `slot-reserved`
  - vehicle current: `column-bottom-a-c10`
  - vehicle target: `column-bottom-b-c10`
  - station service transition gap: `waiting-for-head-reservation`
  - head reservation supply gap: `unknown`
  - ready demand count: 3
  - claimed demand count: 1
  - dispatchable candidate count: 0
- `lift-02-outbound`
  - active outbound visit: `task-0026`, vehicle `SH-06`
  - visit phase: `slot-reserved`
  - vehicle current: `module-02-spine-bottom-a`
  - target: `column-bottom-a-c21`
  - wait reason: `storage-exit-precedence`
  - service transition gap: `waiting-for-head-reservation`
  - head reservation supply gap: `unknown`

## Current Hypothesis

The WIP fixed one class of failures but introduced an overly broad protection boundary:

- `activeVisit` starts at station work admission, which may happen while the vehicle is not yet physically near slot0/pass.
- The code then protects full approach slots and service envelope for that active visit.
- This blocks ordinary traffic around bottom column entrances for hundreds of seconds, even though the active visit is not actually in the physical station handoff yet.
- The approach-slot egress patch is too aggressive: it prevents pass-point deadlock but turns normal storage/column movements into long station-owned holds.

In short:

- Round 7 said `activeVisit` should be the logical aggregate root.
- My WIP likely made `activeVisit` too physically authoritative too early.
- We need a precise boundary between:
  - logical station capacity/admission;
  - physical approach slot lease;
  - pre-service drain epoch;
  - envelope/service exclusivity.

## Exact Questions For ChatGPT Pro

Please review this as a station resource-contract design problem, not a one-off blocker patch.

1. When should `activeVisit` begin physically protecting approach nodes?
   - At task admission?
   - Only after outbound pickup/load is complete?
   - Only when the active vehicle is within N nodes / has a concrete bounded route to slot0?
   - Only when a separate `approachLease` or `slot0Lease` is issued?

2. Should approach-slot occupants be handled by the same `drainEpoch` as service-envelope occupants, or should there be separate phases?
   - Example phases: `admitted`, `loaded-ready`, `approach-reserved`, `approach-draining`, `at-slot0`, `service-draining`, `service-granted`.

3. What is the minimum physical protection set before the owner is at pass?
   - Protect the whole approach chain?
   - Protect only the next one or two nodes in the owner's planned path?
   - Protect only a station-defined bounded handoff area after the owner reaches a pre-entry checkpoint?

4. How should foreign vehicles already inside an approach slot be egressed without freezing a whole module or bottom column entrance for hundreds of seconds?

5. Is the current WIP salvageable by narrowing physical protection activation, or should we revert back to the previous slot0 + foreign-envelope-egress state and re-implement with explicit `approachLease` / `slot0Lease` / `drainEpoch` phases?

6. What are the next focused red tests before another 10m/30m/2h run?
   - We need tests that prove no `outbound-station-visit-owned` wait can persist for hundreds of seconds before the owner is actually near slot0/pass.

7. Which invariants should be hard failures in the audit?
   - Examples:
     - activeVisit without physical lease must not block unrelated traffic;
     - physical protected node target by non-owner must be cleared within a bounded time;
     - `gap=unknown` under active outbound visit is invalid;
     - `outbound-station-visit-owned` longer than T seconds is invalid unless a drain route is actively progressing.

Please give a minimal architecture correction and validation plan. Avoid a pure DES rewrite; keep the physical 3D tick model as the target.
