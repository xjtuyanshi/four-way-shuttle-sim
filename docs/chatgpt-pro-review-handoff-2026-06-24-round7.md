# ChatGPT Pro Review Handoff - Round 7 - 2026-06-24

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Last pushed commit: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Working tree: intentionally dirty, not committed because the latest 2h gate failed.
- Dirty files:
  - `packages/shuttle-schemas/src/index.ts`
  - `packages/shuttle-sim-core/src/index.ts`
  - `packages/shuttle-sim-core/src/index.test.ts`

## User Goal

Build a high-fidelity physical 3D tick four-way shuttle simulation that can run long windows without AMR/shuttle overlap, pass-point deadlock, small-area oscillation, or hidden stuck vehicles. The user wants 24h runs with hourly PPH, 10-minute per-AMR task counts, stuck/loop metrics, and a rolling HTML log explaining every rerun, problem, fix, and result.

The user explicitly asked not to keep blindly patching. If the local work is still stuck, consult ChatGPT Pro Extended with a clear, complete failure description and wait for the full review.

## Architecture Direction Already Chosen

This is not a DES rewrite. The target remains the physical 3D tick simulation, but the resource model should use DES-like station contracts:

- AMR/shuttle is a resource.
- Lift station owns queue/pass/service resources.
- AMR should queue in order on yellow feasible grid nodes only.
- Outbound/inbound station ownership must be authoritative enough to prevent crossing, pass-point blocking, and mutual waiting.
- Long-run validation must drive the design, not only short visual checks.

## Previous External Review Summary

Round 6 ChatGPT Pro review advised:

1. Stop adding local blockers.
2. Implement authoritative `OutboundStationController` / `OutboundStationVisit` depth=1 first.
3. Make slot-0/head lease the source of truth.
4. Only then handle corridor/envelope draining.
5. Then consider depth=2.

## Local Changes Since Last Pushed Commit

These changes are uncommitted because the 2h gate still failed.

### Cut A - Authoritative Outbound Slot-0

Changed outbound station admission from legacy active-task cap to a controller-owned slot:

- `outboundStationWorkAdmissionBlockReason` now checks `runtime.slotOwnerRequestId`.
- The block reason changed from `outbound-station-work-admission-full:<station>` to `outbound-station-visit-capacity-full:<station>`.
- `grantOutboundStationEnvelopePass` only grants if the request owns `slotOwnerRequestId`.
- Shadow diagnostics expose:
  - `resourceKey: station:<stationId>:outbound-slot:0`
  - `slotIndex: 0`
  - `kind: queueSlotLease`

Schema adjustment:

- `ShadowStationRouteLeaseSchema.slotIndex` now allows nonnegative values so `slotIndex: 0` is valid.
- `StationKernelQueueLeaseSchema.slotIndex` remains positive.

### Cut B - Foreign Vehicle Envelope Egress

The first 2h slot-0 run failed at 4685s:

- SH-02 owned `lift-02-outbound` slot/envelope.
- SH-02 waited for SH-05 at `column-bottom-b-c21`.
- SH-05 was already inside the outbound service route and wanted to move to `module-02-spine-bottom-b`.
- SH-05 was blocked by `outbound-station-envelope-owned`, forming a circular wait.

Patch added:

- Foreign vehicles outside an active outbound envelope remain blocked from entering.
- A foreign vehicle already inside an active outbound envelope may drain forward along the owner's active route.
- It cannot move backward.
- It cannot enter the final service node.

Focused regression added:

- Owner route for `lift-02-outbound -> column-bottom-b-c22`:
  - `column-bottom-a-c21 -> column-bottom-b-c21 -> module-02-spine-bottom-b -> column-bottom-b-c22`
- Foreign vehicle at `column-bottom-b-c21`:
  - allowed to move to `module-02-spine-bottom-b`
  - blocked from moving to service node `column-bottom-b-c22`
  - blocked from moving backward to `column-bottom-a-c21`
  - after clearing to `module-02-spine-bottom-a`, blocked from re-entering `module-02-spine-bottom-b`

## Validation Run Results

### Unit / Typecheck

Passed:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit

./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "outbound clear-through into sibling inbound reserve|revokes a taskless inbound reserve|outbound station approach slots|outbound station envelope passes|allows foreign vehicles already inside an outbound envelope|limits outbound station work admission|grants only the slot owner|holds outbound station envelope ownership" \
  --reporter=dot
```

Result: `8 passed | 514 skipped`.

### 10m Gate After Egress Patch

Command output:

- `finalSimTimeSec`: 600
- Total PPH: 552
- Inbound PPH: 384
- Outbound PPH: 168
- anomalies: 0
- criticalAnomalies: 0

File:

- `output/review/physical-10m-authoritative-slot0-egress-smoke.json`

### 30m Gate After Egress Patch

Command output:

- `finalSimTimeSec`: 1800
- Total PPH: 484
- Inbound PPH: 350
- Outbound PPH: 134
- anomalies: 0
- criticalAnomalies: 0
- deadlocks: 0
- livelocks: 0
- physicalViolations: 0
- minVehicleSeparationM: 2.030394
- finalWaitingVehicles: []

File:

- `output/review/physical-30m-authoritative-slot0-egress-gate.json`

### 2h Gate Before Egress Patch

Failed at 4685s.

- Total PPH: 375.752
- Inbound PPH: 232.828
- Outbound PPH: 142.924
- traffic.deadlocks: 30
- critical: 1
- root pattern: SH-02/SH-05 circular wait inside `lift-02-outbound` service envelope.

File:

- `output/review/physical-2h-authoritative-visit-slot0-gate.json`

### 2h Gate After Egress Patch

Failed later, at 6600s.

- Status: stopped early by `--stop-on-critical`
- `finalSimTimeSec`: 6600
- Total PPH: 341.455
- Inbound PPH: 206.727
- Outbound PPH: 134.727
- traffic.deadlocks: 1
- livelocks: 0
- physicalViolations: 0
- minVehicleSeparationM: 1.25
- anomalies: 7
- criticalAnomalies: 6

File:

- `output/review/physical-2h-authoritative-slot0-egress-gate.json`
- final checkpoint:
  - `output/review/physical-2h-authoritative-slot0-egress-gate-checkpoints/0015-6600s.json`

Final waiting vehicles:

```json
[
  {
    "vehicleId": "SH-02",
    "currentNodeId": "column-bottom-b-c07",
    "targetNodeId": "column-bottom-a-c07",
    "waitReason": "node-occupied",
    "blockingVehicleId": "SH-05",
    "currentWaitSec": 726.4
  },
  {
    "vehicleId": "SH-03",
    "currentNodeId": "column-bottom-a-c06",
    "targetNodeId": "column-bottom-a-c07",
    "waitReason": "node-occupied",
    "blockingVehicleId": "SH-05",
    "currentWaitSec": 730.8
  },
  {
    "vehicleId": "SH-05",
    "currentNodeId": "column-bottom-a-c07",
    "targetNodeId": null,
    "waitReason": "outbound-station-await-transition",
    "blockingVehicleId": null,
    "currentWaitSec": 724.2
  }
]
```

Relevant task/station state at 6600s:

- SH-05:
  - loaded outbound task `task-0594`
  - at `column-bottom-a-c07`
  - dropoff `column-bottom-b-c08`
  - holds `station:lift-01-outbound:outbound-slot:0`
  - outbound visit phase: `at-pass`
  - waitReason: `outbound-station-await-transition`
- SH-02:
  - unloaded inbound task `task-0625`
  - at `column-bottom-b-c07`
  - target `column-bottom-a-c07`
  - blocked by SH-05
- SH-03:
  - unloaded outbound assigned task `task-0611`
  - at `column-bottom-a-c06`
  - target `column-bottom-a-c07`
  - blocked by SH-05
- `lift-01-outbound`:
  - slot-0 route lease occupied by SH-05 at `column-bottom-a-c07`
  - outbound visit phase `at-pass`
  - `serviceTransition.gap`: `waiting-for-head-reservation`
  - `headReservationSupply.gap`: `unknown`
  - no active service vehicle

## Current Hypothesis

The 4685s circular wait was likely cut, because the egress-patched run crossed 4800s and did not reproduce that SH-02/SH-05 envelope case.

The new 6600s failure looks like a different station controller gap:

- SH-05 is correctly at the pass point / slot-0 for `lift-01-outbound`.
- It cannot get a service transition and holds the pass point for over 700s.
- Other vehicles physically need `column-bottom-a-c07` and pile up behind or around it.
- The shadow station reports `waiting-for-head-reservation` / `headReservationSupply.gap = unknown` even though SH-05 is already the claimed outbound visit at pass.

This suggests the controller is not treating the slot-0/pass occupant as the head reservation / ready service owner, or the transition grant preconditions are missing a state path for `at-pass`.

## Exact Questions For ChatGPT Pro

Please review this as a system/resource-contract problem, not a local pathfinding patch.

1. In this architecture, should the `OutboundStationController` treat `slotOwnerRequestId` at pass (`currentSlotIndex=0`, `phase=at-pass`) as sufficient head reservation to grant service transition, assuming the service envelope is clear?
2. Is the current separation between "queueSlotLease", "outboundVisit", "headReservationSupply", and "serviceTransition" over-split? What minimal authoritative contract should replace it?
3. For depth=1, what are the exact station states and allowed transitions?
   - admitted
   - loaded-ready
   - approaching slot
   - at pass / slot0 occupied
   - service granted
   - entering envelope
   - servicing
   - clearing
   - completed
4. What invariant should prevent a vehicle from holding pass point `column-bottom-a-c07` for 700s with `outbound-station-await-transition` and no active service?
5. Should inbound/unloaded vehicles like SH-02 ever target `column-bottom-a-c07` while an outbound slot owner sits there? If no, where should they be routed/yielded?
6. Should the next fix be:
   - promote slot0 occupant to head reservation/service grant immediately;
   - add station-level "draining mode" before service grant;
   - add explicit pass-point egress/yield lane;
   - or revert the slot0/effect and redesign controller state machine?
7. What tests should be added before another 2h/24h run?

## What Not To Do

- Do not suggest a broad rewrite unless strictly necessary.
- Do not solve by adding one-off blockers for SH-02/SH-03/SH-05.
- Do not ignore the physical yellow feasible path constraint.
- Do not rely only on 10m or 30m success; 2h/24h is the gate.
- Do not call this fixed until no AMR has a 10-minute stationary-active or long-wait window.
