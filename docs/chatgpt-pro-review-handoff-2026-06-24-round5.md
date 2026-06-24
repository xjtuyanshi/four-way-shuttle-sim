# ChatGPT Pro Review Handoff - Round 5

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- HEAD: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Important caveat: the latest R4.3 code and validation evidence are local/uncommitted. Do not assume GitHub has the latest state.

Dirty tracked files at handoff time:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `packages/shuttle-schemas/src/index.ts`
- `apps/shuttle-dashboard/src/App.test.ts`
- `scripts/run-physical-24h-amr-audit.ts`
- `scripts/render-amr-24h-report.mjs`

Round 5 is asking for architecture review before more local patching.

## User Goal

Keep the current high-fidelity 3D tick simulation. Do not replace it with a pure DES shortcut. Fix the resource contracts so the simulation is stable and explainable for customer review:

- station-owned coordinator
- explicit separation of inbound demand, AMR queue reservation, physical slot occupancy/lease, active service
- 10m/30m/24h A/B validation
- hourly PPH
- every-10-minute per-AMR completed-task matrix
- long-wait/stationary/small-loop detection
- visual 3D sanity checks

## Prior Pro Round 4 Conclusion We Followed

Round 4 concluded the issue is systemic outbound station/lift queue/resource ownership, not a coordinate bug. The recommended final shape was:

- one continuous `stationVisitId`
- multi-slot approach lease
- task-specific inner pass node
- service-envelope owner lasting through clear-through
- pass is edge/service authorization, not a normal node lock
- approach/meter nodes must not require service pass
- no generic deadlock breaker as a substitute for resource ownership

## Changes Made After Round 4

### R4.1: Approach / Service Envelope Split

Implemented `outboundStationPlanForDropoff(stationId, dropoffNodeId)`:

- `column-bottom-b-c08` maps to pass `column-bottom-a-c07`
- `column-bottom-b-c22` maps to pass `column-bottom-a-c21`
- approach nodes are separated from service envelope
- service pass protects only pass-to-dropoff/clear-through interior

Validation:

- Focused tests passed.
- Typecheck passed.
- 10m gate passed: total 480 PPH, inbound 330, outbound 150, 0 anomaly.
- 30m gate failed: SH-05/SH-08 blocked by stale SH-01 outbound envelope owner for 600s.

### R4.2: Stale Outbound Envelope Release

Added stale active-pass release when a vehicle leaves the outbound clearance lifecycle but still owns an old outbound envelope.

Validation:

- Focused tests passed.
- Typecheck passed.
- 10m gate passed: total 504, inbound 348, outbound 156, 0 anomaly.
- 30m gate passed: total 478, inbound 346, outbound 132, 0 anomaly, 0 critical, final waiting vehicles empty.

### R4.2 Long-Window Attempt

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 7200 \
  --out output/review/physical-2h-after-stale-envelope-release-r4-2.json \
  --checkpoint-dir output/review/physical-2h-after-stale-envelope-release-r4-2-checkpoints \
  --stop-on-critical
```

Result: failed at 3000s / 50m.

Key failure:

- SH-03 loaded outbound task `task-0279`, dropoff `column-bottom-b-c22`, stuck at `column-bottom-b-c15`
- SH-07 loaded outbound task `task-0245`, dropoff `column-bottom-b-c08`, stuck at `column-bottom-b-c12`
- both had `waitReason=outbound-station-await-transition`
- both had `targetNodeId=null`, `blockingVehicleId=null`
- both were stationary for 600s

Interpretation:

The move blocker set `outbound-station-await-transition` before the vehicle reached its task-specific pass node. After that, `targetNodeId` was cleared and the vehicle could never continue to the true pass.

### R4.3: Allow Non-Service Approach Route To Pass

Code changed so:

- `outbound-station-await-transition` is only valid when the current node equals the task-specific pass node
- if a loaded outbound is not at pass yet, and its next node is on a route to pass that avoids the service envelope, the move is allowed
- example fixed routes:
  - `column-bottom-b-c12 -> column-bottom-a-c12 -> ... -> column-bottom-a-c07`
  - `column-bottom-b-c15 -> column-bottom-a-c15 -> ... -> column-bottom-a-c21`

Validation:

- Typecheck passed:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

- Focused tests passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "outbound station envelope passes|stale outbound clearing envelope|stale taskless inbound queue reserve|taskless inbound queue reserve parked" \
  --reporter=dot
```

- 1h gate passed:
  - output: `output/review/physical-1h-after-outbound-approach-route-to-pass-r4-3.json`
  - final sim time: 3600s
  - total PPH: 396
  - inbound PPH: 259
  - outbound PPH: 137
  - anomalies: 0
  - critical anomalies: 0
  - physical violations: 0
  - deadlocks/livelocks: 0/0
  - final waiting vehicles: empty

R4.3 crossed the previous 50m failure point successfully.

Remaining problem:

Throughput still declines over the hour:

- first 10m total/outbound: 504 / 156
- 30m total/outbound: 478 / 132
- 40m total/outbound: 432 / 130.5
- 50m total/outbound: 396 / 129.6
- 60m total/outbound: 396 / 137

Top blocked reasons in the 1h result:

- `vehicle-unavailable`: 7415.8s
- `outbound-station-work-admission-full:lift-01-outbound`: 7099.8s
- `outbound-station-work-admission-full:lift-02-outbound`: 7054.2s
- `storage-empty`: 3035.4s
- `storage-full`: 2876.4s

Interpretation:

The system is stable at 1h, but outbound admission is still serialized too early. It does not yet behave like a true queue.

### R4.4 Failed Experiment: Meter-Slot Admission Without Ordered Leases

Tried changing outbound station work admission from depth-1 active task mutex to physical meter-slot capacity using `topLiftOutboundApproachMeterNodeIds(stationId).length`.

This was reverted after validation failed.

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 1800 \
  --out output/review/physical-30m-after-outbound-meter-admission-r4-4.json \
  --checkpoint-dir output/review/physical-30m-after-outbound-meter-admission-r4-4-checkpoints \
  --stop-on-critical
```

Result: failed at 1200s / 20m.

Failure:

- total PPH: 312
- inbound PPH: 198
- outbound PPH: 114
- anomalies: 11
- critical anomalies: 10

Final waiting chain:

- SH-04 loaded outbound at `column-bottom-a-c21`, waiting `outbound-station-await-transition`, no blocker.
- SH-05 loaded outbound at `column-bottom-a-c20`, waiting `node-occupied`, blocked by SH-04.
- SH-07 empty/inbound-assigned at `column-bottom-a-c19`, waiting `node-occupied`, blocked by SH-05.
- SH-02 loaded outbound at `column-bottom-a-c18`, waiting `node-occupied`, blocked by SH-07.
- SH-01 and SH-08 were also blocked near `module-02-spine-bottom-a/b`.

Interpretation:

Simply increasing work admission creates a queue pileup because there is no authoritative ordered approach-slot lease. This supports Round 4's warning: do not make approach a big mutex, but also do not allow multiple active outbound tasks without ordered slot ownership and forward progress rules.

The R4.4 admission change was reverted. Current candidate remains R4.3.

## Current Candidate State

Keep:

- R4.1 approach/service split
- R4.2 stale outbound envelope release
- R4.3 route-to-pass allowance before service transition

Rejected:

- R4.4 naive multi-task station admission without real approach leases

Known gaps:

- no continuous `stationVisitId` yet
- no authoritative multi-slot outbound approach lease yet
- outbound station admission still depth-1, causing high `outbound-station-work-admission-full`
- no 24h pass yet
- 3D visual check still pending for current candidate

## Questions For Review

1. Given R4.3 stability but PPH degradation, and R4.4 immediate queue pileup, what is the minimal correct next architecture step?
2. Should the next step be an explicit `OutboundStationVisit` with approach slots before changing task assignment/admission?
3. How exactly should approach slots be represented for this topology?
   - For left outbound `c08`, example pass is `bottom-a-c07`; upstream vehicles may come through `bottom-b-c12 -> bottom-a-c12 -> ...`.
   - For right outbound `c22`, example pass is `bottom-a-c21`; upstream vehicles may come through `bottom-b-c15 -> bottom-a-c15 -> ...`.
4. How should we avoid the R4.4 pileup where head waits at pass and followers/inbound vehicles become physically trapped behind it?
5. Is depth-1 outbound task admission acceptable as a temporary stable candidate, or should it be replaced before any 24h gate?
6. What exact 10m/30m/2h/24h gates should we run after the next change?
7. Which current logic should be preserved, and which should stop receiving local patches?

Please answer as an external architecture reviewer. The priority is not a quick patch; it is a minimal resource-contract design that can survive 24h high-fidelity 3D tick simulation.
