# ChatGPT Pro Review Handoff - 2026-06-21

## Context

This repo is the four-way shuttle / top-lift simulation project for customer review.

Current branch:

```text
codex/traffic-v2-flow-debug
```

The immediate user concern is that we have spent too long trying local queue and avoidance fixes. The next review should avoid blind patching and focus on the system-level resource model.

## Current Retained State

The only new behavioral fix from the last loop that is intentionally retained is the read-purity fix:

- Public reads through `getState()` are now guarded by `diagnosticReadOnlyDepth`.
- Inbound source-buffer compaction and source-load promotion are blocked while the simulation is being read for dashboard/audit/diagnostics.
- Regression test added: `does not compact inbound source buffers while reading public state`.

Why this matters:

- Before the fix, dashboard/audit reads could mutate the physical tick model.
- A direct A/B run showed divergence by 90s: source loads swapped buffer slots depending on whether `getState()` was called every 30s.
- After the fix, no-read and read-every-30s runs matched at 600s for KPIs, loads, tasks, vehicles, and reservations.

## Validated Baseline

Accepted 30m physical audit after the read-purity fix:

```text
output/review/current-0p5h-after-read-purity-audit.json
```

Result:

```text
totalPph    = 508
inboundPph  = 200
outboundPph = 308
anomalies   = 0
critical    = 0
```

Queue reserve diagnosis after the accepted fix:

```text
output/review/local-queue-reserve-after-read-purity-0p5h.json
```

Important summary:

```text
averageCoveredDepth                 = 0.478
averageStandbyDepth                 = 0
averageReserveVehicles              = 0
averageActiveInboundInQueueSlot      = 0.267
averageActiveInboundInTransitToQueue = 1.022
farActiveInboundRouteSamples         = 97
offQueueWaitingSamples               = 90
```

Interpretation:

- A stable taskless lift-side queue is not actually forming.
- Current throughput relies on active inbound vehicles, often coming from storage/middle/bottom levels, being bound to inbound queue or pickup work.
- With only 8 shuttles at this load, there is rarely a truly idle shuttle available to act as a dedicated taskless reserve queue.

## Rejected Experiments

The following queue/resource experiments were tried and reverted because short physical windows regressed badly.

1. Broad planned-goal queue identity

```text
output/review/current-0p5h-after-queue-identity-audit.json
totalPph=474
inboundPph=204
outboundPph=270
anomalies=1
```

Reason rejected:

- Counting any planned inbound queue goal as a queue resource improved accounting too broadly and hurt total flow/outbound stability.

2. Local top-level queue staging route cap

```text
output/review/current-0p5h-after-local-queue-staging-audit.json
10m sample:
totalPph=450
inboundPph=144
outboundPph=306
anomalies=0
```

Reason rejected:

- It prevented long fake queue tours but starved inbound.

3. Delayed task binding until the vehicle reaches a queue slot

```text
output/review/current-0p5h-after-taskless-queue-dispatch-audit.json
10m sample:
totalPph=432
inboundPph=114
outboundPph=318
anomalies=0
```

Reason rejected:

- The queue became conceptually cleaner, but lift pickup dispatch was starved.

4. Blocking lower-level direct task binding into inbound queue

```text
output/review/local-queue-reserve-after-lower-level-queue-bind-guard-10m.json
farActiveInboundRouteSamples=2
totalPph=438
inboundPph=132
outboundPph=306
anomalies=0
```

Reason rejected:

- It reduced ugly far active inbound queue routes, but the model currently depends on those lower/middle/storage vehicles to replenish inbound. Blocking them makes inbound collapse.

## Current Diagnosis

The issue does not look like a single infinite bug loop.

The current evidence points to a resource-model mismatch:

- The desired behavior is a DES-like lift queue: AMR is a resource, lift is a station, queue slots are ordered physical resources.
- The current tick model often binds inbound tasks directly to available vehicles and routes them toward queue/pickup.
- Trying to force a taskless reserve queue with local guards reduces visual weirdness but removes the vehicles that currently keep inbound moving.
- Therefore local guard patches keep trading one problem for another: cleaner queue visuals versus much worse inbound PPH.

## Review Request

Please review the latest branch with the following focus:

1. Is the read-purity fix correct and sufficient?
2. Is the above interpretation correct: the main lift delay problem is a resource-contract issue, not just a pathfinding bug?
3. What is the minimum refactor to make inbound lift queueing DES-like without breaking the existing 3D tick model?
4. Should the model support two resource states instead of only taskless reserve vs assigned task?
   - Proposed direction:
     - `queueReservation`: a vehicle is reserved for a lift queue but not yet bound to a specific load.
     - `activeInboundService`: a vehicle has consumed a lift queue position and is now serving a concrete inbound load.
5. How should the dispatch policy choose between:
   - waiting for a near lift-side vehicle,
   - using a far storage/middle/bottom vehicle,
   - allowing the lift to idle briefly,
   - or reducing outbound work temporarily?

## Suggested Success Criteria For Next Attempt

Do not accept another patch unless it passes a short A/B gate:

```text
10m:
  totalPph >= 500 or no worse than read-purity baseline by more than 3 percent
  inboundPph >= 190
  anomalies = 0
  physicalViolations = 0

30m:
  totalPph >= 508 baseline or explain any tradeoff explicitly
  inboundPph >= 200 baseline or explain any tradeoff explicitly
  critical anomalies = 0
  no AMR long-stuck windows
```

Any patch that only makes the queue visually cleaner but drops inbound below these gates should be rejected.

## Commands Already Used

Targeted tests:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "does not compact inbound source buffers|holds taskless inbound queue standby|does not let inbound work steal an en-route inbound queue reserve" --reporter verbose
```

Typecheck:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

30m accepted audit:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --audit-every-sec 30 --out output/review/current-0p5h-after-read-purity-audit.json --checkpoint-dir output/review/current-0p5h-after-read-purity-checkpoints --stop-on-critical
```

Queue reserve diagnosis:

```bash
./node_modules/.bin/tsx scripts/diagnose-queue-reserve-efficiency.ts --duration-sec 1800 --sample-sec 10 --dt-sec 0.2 --initial-fill-policy zone-balanced-50 --out output/review/local-queue-reserve-after-read-purity-0p5h.json
```

