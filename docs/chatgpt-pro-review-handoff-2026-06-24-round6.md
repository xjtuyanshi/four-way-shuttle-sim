# ChatGPT Pro Review Handoff - Round 6

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Base HEAD before local changes: `d9bd1f36b736fbbd77dab94622fc39b6dde53b6d`
- Current state: local/uncommitted Cut3 changes plus validation evidence. Do not assume GitHub has this exact state unless the branch is committed and pushed.

Dirty tracked files at this checkpoint:

- `packages/shuttle-sim-core/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `packages/shuttle-schemas/src/index.ts`
- `apps/shuttle-dashboard/src/App.test.ts`
- `scripts/run-physical-24h-amr-audit.ts`
- `scripts/render-amr-24h-report.mjs`

## User Goal

Keep the high-fidelity 3D tick simulation as the review model. Do not replace it with a pure DES shortcut. The system must be stable and explainable enough for customer review:

- 8 default shuttles unless explicitly changed.
- Feasible yellow-grid movement only.
- No visual/physical shuttle overlap.
- Station/lift behavior must be queue-like and understandable.
- Validate with 10m, 30m, 2h, then 24h gates.
- Report hourly PPH and every-10-minute per-AMR task completion, stuck/looping metrics, and reasons for reruns in the rolling log.

## Previous External Review We Followed

Round 5 concluded:

- Keep R4.3 as a rollback/reference baseline, but do not accept it as 24h candidate.
- Do not jump directly from depth-1 outbound admission to depth-3.
- Correct rollout:
  1. Visit/lease shadow.
  2. Lease controlling while still depth-1.
  3. Enable depth=2.
  4. Run 2h gate.
  5. Enable depth=3.
  6. Only then attempt 24h.
- Implement `OutboundStationVisit`, ordered approach slot leases, and a small corridor mode lease:
  - `shared -> draining -> outbound-queue -> shared`
- For lift-01-outbound, approach slots should be:
  - head/pass: `column-bottom-a-c07`
  - slot 1: `column-bottom-a-c08`
  - tail: `column-bottom-a-c09`
  - admission edge: `column-bottom-a-c10 -> column-bottom-a-c09`
- For lift-02-outbound:
  - head/pass: `column-bottom-a-c21`
  - slot 1: `column-bottom-a-c20`
  - tail: `column-bottom-a-c19`
  - admission edge: `column-bottom-a-c18 -> column-bottom-a-c19`

## Cut3 Changes Since Round 5

### 1. Explicit Outbound Approach Topology

Added explicit outbound station approach-slot topology:

- `approachSlotNodeIdsHeadToTail`
- `admissionEdges`
- `advanceEdges`
- `serviceEntryEdge`
- `serviceEnvelopeId`

Also added:

- `outboundStationApproachTailDirection`
- `outboundStationApproachSlotNodeIdsForStation`

The station pair coordinator shadow snapshots now expose the true bottom-a outbound queue slots rather than old meter-node guesses.

Validation:

- Focused test: `defines outbound station approach slots on the yellow feasible bottom-a lane`
- 10m smoke: total 504 PPH, inbound 348, outbound 156, 0 anomaly.

### 2. Shadow Outbound Station Visits

Added schema/core diagnostics for `outboundVisits`.

Current status: shadow/diagnostic only. This is not yet an authoritative controlling visit object.

Validation:

- Existing outbound station envelope/pass test now asserts an outbound visit at `phase=at-pass`, slot 0, pass `column-bottom-a-c07`.
- 10m smoke remained: total 504, inbound 348, outbound 156, 0 anomaly.

### 3. Runtime Revocation Of Taskless Inbound Reserve Blocking Outbound Dock

Observed old failure in R4.3 / guard-only Cut3:

- At 5150s, SH-04 had active outbound task, waiting to access `lift-02-outbound`.
- SH-07 was taskless inbound reserve sitting in/targeting the same outbound dock corridor.
- They blocked each other for about 301.8s.
- A pure conversion guard was insufficient because SH-07 could already be in the corridor before SH-04's claim became active.

Implemented runtime revocation/drain:

- If a taskless, unloaded, stopped `inbound-queue-standby` vehicle is inside/targeting/planning through an outbound dock corridor while an active sibling outbound task needs that corridor, revoke its station queue reserve.
- Route it to `outbound-lift-clearance` instead of letting it hold the outbound throat.
- Emit `station-queue-reserve-released` details with reason `inbound-reserve-revoked-for-outbound-corridor`.

Validation:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Passed.

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "outbound clear-through into sibling inbound reserve|revokes a taskless inbound reserve|outbound station approach slots|outbound station envelope passes|limits outbound station work admission" \
  --reporter=dot
```

Passed: 5 tests, 516 skipped.

## Latest Physical 2h Gate

Command:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 7200 \
  --out output/review/physical-2h-cut3-corridor-revocation-rerun.json \
  --checkpoint-dir output/review/physical-2h-cut3-corridor-revocation-rerun-checkpoints \
  --change-note "Cut3 corridor revocation 2h gate rerun" \
  --run-reason "上一轮 2h gate 在线程切换时只留下 0s/60s checkpoint，没有主结果；这次用新文件名重跑，验证 revocation/drain 是否跨过旧 5150s SH-04/SH-07 deadlock。" \
  --problems-observed "R4.3/Cut3 guard-only 在 5150s critical；Cut3 revocation 90m 已修复该链，但还需要 2h gate 确认不是推迟故障。" \
  --problems-solved "运行中撤销位于 outbound dock corridor 的 taskless inbound reserve，并改为 outbound-lift-clearance，使 active outbound AMR 能进入 throat。" \
  --run-decision "2h gate before depth=2/ordered slot lease; 必须 0 critical/anomaly，且不能出现 final waiting/stuck。" \
  --stop-on-critical
```

Result:

- Completed full 7200s.
- Wall clock: 1,218,148 ms.
- Total PPH: 356.
- Inbound PPH: 204.5.
- Outbound PPH: 151.5.
- Completed inbound/outbound: 409 / 303.
- Critical anomalies: 0.
- Anomalies: 0.
- Physical violations: 0.
- Deadlocks/livelocks: 0 / 0.
- Final min vehicle separation: 2.357954 m.
- Rolling log updated:
  - `output/review/sim-run-rolling-log.json`
  - `output/review/sim-run-rolling-log.html`

Hourly result:

| Hour | Hourly In | Hourly Out | Hourly Total | Cumulative Total PPH | Waiting | Blocked | Ledger Violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| H1 | 259 | 137 | 396 | 396 | 0 | 0 | 0 |
| H2 | 150 | 166 | 316 | 356 | 2 | 2 | 0 |

10-minute window totals:

| Window | Sec | In | Out | Total | Max Loopiness |
| --- | --- | ---: | ---: | ---: | ---: |
| W1 | 0-600 | 58 | 26 | 84 | 46.807 |
| W2 | 600-1200 | 60 | 25 | 85 | 37.633 |
| W3 | 1200-1800 | 55 | 15 | 70 | 61.503 |
| W4 | 1800-2400 | 28 | 21 | 49 | 61.479 |
| W5 | 2400-3000 | 21 | 21 | 42 | 67.417 |
| W6 | 3000-3600 | 37 | 29 | 66 | 296.925 |
| W7 | 3600-4200 | 28 | 30 | 58 | 108.859 |
| W8 | 4200-4800 | 27 | 29 | 56 | 487.899 |
| W9 | 4800-5400 | 20 | 26 | 46 | 63.944 |
| W10 | 5400-6000 | 21 | 25 | 46 | 320.060 |
| W11 | 6000-6600 | 37 | 29 | 66 | 128.956 |
| W12 | 6600-7200 | 17 | 27 | 44 | 55.548 |

Largest per-AMR loopiness windows:

- SH-01: 487.899, W8, 7 tasks, 1 inbound / 6 outbound, 105 blocked sec.
- SH-05: 320.060, W10, 8 tasks, 4 inbound / 4 outbound, 30 blocked sec.
- SH-08: 296.925, W6, 9 tasks, 5 inbound / 4 outbound, 30 blocked sec.

There were no flagged/critical AMR windows under the current thresholds, but these loopiness spikes should be reviewed before a 24h acceptance run.

Final waiting vehicles:

- SH-01 at `column-bottom-a-c08`, target `module-01-spine-bottom-a`, wait `node-target-near`, blocker SH-03, current wait 0.8s.
- SH-02 at `column-bottom-a-c17`, target `column-bottom-a-c16`, wait `loaded-route-precedence`, blocker SH-05, current wait 6.4s.

These are small tail waits, not the old 5150s deadlock chain.

## Remaining Symptoms / Evidence

The old SH-04/SH-07 outbound dock corridor deadlock did not recur in 2h.

However, throughput still degrades:

- 10m total tasks drop from 84/85 early to 44 at the final 10m window.
- H1 total 396 PPH, H2 total 316 PPH.
- Cumulative total PPH falls to 356 by 2h.

Top blocked reasons indicate the main remaining bottleneck:

H1 top:

- `vehicle-unavailable`: 7415.8s
- `outbound-station-work-admission-full:lift-01-outbound`: 7099.8s
- `outbound-station-work-admission-full:lift-02-outbound`: 7054.2s

H2 top:

- `outbound-station-work-admission-full:lift-01-outbound`: 9829.6s
- `outbound-station-work-admission-full:lift-02-outbound`: 9817.4s
- `storage-full`: 4287s
- `storage-empty`: 3434s

Shadow ledger final invariant count is 0, but sampled watch violations occurred during the run:

- `lift-fifo-inversion`: 220 samples.
- `conflict-session-without-yield-hold`: 14 samples.
- `duplicate-resource-owner`: 2 samples.

Duplicate examples:

- 6000s: `node:storage-r14-c03` had SH-05 and SH-07 shadow owners via `plannedRouteNodeIds`, `targetNodeId`, and `post-dropoff-column-exit`.
- 6600s: `node:module-boundary-01-spine-top-b` had SH-05 and SH-08 shadow owners via `targetNodeId` and planned routes.

## Current Interpretation

Cut3 seems to fix one concrete stability fault: taskless inbound reserve can no longer sit in the outbound dock corridor and block active outbound service indefinitely.

But the model is not ready for 24h acceptance because:

- outbound remains artificially serialized by `outbound-station-work-admission-full`;
- PPH declines materially in the second hour;
- loopiness spikes show inefficient local behavior even when no anomaly threshold is breached;
- shadow watch violations show resource ownership is still not clean enough for confidence;
- the Pro Round 5 recommended core architecture is only partially shadowed, not controlling.

## Questions For ChatGPT Pro

1. Given the Cut3 2h result, do you agree the next move should still be ordered `OutboundStationVisit` / approach slot lease / corridor mode, rather than more local blockers?
2. Should the sampled `lift-fifo-inversion` and duplicate-resource-owner watch violations be treated as hard blockers before depth=2, or as diagnostics that will be resolved by the visit/slot lease rollout?
3. For the next minimal implementation, should we make the existing shadow `outboundVisits` authoritative first while keeping depth=1, or implement corridor mode (`shared -> draining -> outbound-queue`) first?
4. How should depth=2 be introduced without recreating R4.4's pileup?
5. What exact acceptance criteria should gate the next 30m/2h/24h runs?

