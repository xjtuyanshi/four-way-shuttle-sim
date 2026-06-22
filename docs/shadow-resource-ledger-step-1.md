# Shadow Resource Ledger Step 1

Date: 2026-06-19
Branch: `codex/traffic-v2-flow-debug`

## Goal

Add a non-controlling shadow resource ledger so long-window audits can observe resource ownership problems before they become visible AMR dropouts, deadlocks, or ugly 3D behavior.

This step intentionally does not change routing, task assignment, collision avoidance, or deadlock recovery behavior.

## What Changed

- Added `traffic.shadowLedger` to the public simulation state schema.
- Added core diagnostics that derive shadow leases from:
  - current node occupancy
  - active reservations
  - `targetNodeId`
  - `plannedRouteNodeIds`
  - active `localRouteNodeIds`
- Added invariant counters for:
  - stale local route claim
  - blocked waiter future claim
  - orphaned yield hold
  - reservation owner mismatch
  - duplicate resource owner
  - conflict session mismatch
  - lift FIFO inversion
  - column mode conflict
- Extended the 24h AMR audit JSON and Plotly report with shadow-ledger trend lines, max invariant counts, and sampled violations.
- Added regression tests for stale local-route and blocked-waiter future-claim visibility.

## Baseline Comparison

Baseline before this step:

- File: `output/review/physical-6h-after-claim-lifecycle-fix-audit.json`
- 6h PPH: total `504.333`, inbound `237.667`, outbound `266.667`
- AMR anomalies: `0`
- Physical violations: `0`
- Wall clock: `2,081,152 ms`

After shadow ledger:

- File: `output/review/physical-6h-shadow-ledger-audit.json`
- Report: `output/review/physical-6h-shadow-ledger-report.html`
- 6h PPH: total `504.333`, inbound `237.667`, outbound `266.667`
- AMR anomalies: `0`
- Physical violations: `0`
- Wall clock: `1,984,775 ms`
- Final shadow-ledger invariant total: `0`

The behavior-level baseline is unchanged for the 6h run.

## Shadow Ledger Evidence

6h shadow-ledger audit:

- Samples: `720`
- Samples with violations: `578`
- First violation: `60s`
- Max invariant total in any sample: `16`

Top sampled violation codes:

- `duplicate-resource-owner`: `1477`
- `blocked-waiter-future-claim`: `350`
- `lift-fifo-inversion`: `115`
- `orphaned-yield-hold`: `105`
- `stale-local-route-claim`: `104`
- `conflict-session-without-yield-hold`: `17`
- `column-mode-conflict`: `9`

Interpretation:

- The latest behavioral fix still reaches the same 6h throughput and no visible AMR anomaly.
- The resource model still has frequent short-lived ownership ambiguity.
- Because the final shadow-ledger total returns to `0`, the 6h run does not show persistent orphan ownership, but the transient counts are strong evidence for the next architectural cleanup step.

## Validation Commands

```bash
./node_modules/.bin/tsc -p packages/shuttle-schemas/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "shadow resource ledger|stale local-route|blocked waiters"
npx tsx scripts/run-physical-24h-amr-audit.ts --hours 6 --out output/review/physical-6h-shadow-ledger-audit.json --checkpoint-dir output/review/physical-6h-shadow-ledger-checkpoints --audit-every-sec 30 --quiet-critical
npx tsx scripts/render-amr-24h-report.mjs output/review/physical-6h-shadow-ledger-audit.json output/review/physical-6h-shadow-ledger-report.html
```

## Next Step

Use the shadow-ledger evidence to implement the first behavior-changing cleanup narrowly:

1. Stop treating blocked waiters as owners of future resources.
2. Convert stale local-route ownership from predicate logic into a revision/lease lifecycle.
3. Keep 6h PPH within 1% of `504.333`, keep AMR anomalies at `0`, and reduce `blocked-waiter-future-claim` and `stale-local-route-claim` max counts materially before moving to 12h/24h.

## Step 2: Blocked Waiter / Stale Local Route Cleanup

Date: 2026-06-19

Behavior change:

- Centralized the future-claim eligibility rule so `waiting-blocked` vehicles only keep physical/current occupancy, not future target or route ownership.
- Changed `nodeClaimedByOtherVehicle()` so reservation-blocked waiters no longer target-claim their next node.
- Added post-advance cleanup for inactive `localRouteNodeIds` / `localRouteReason`.
- Changed `blocked-waiter-future-claim` diagnostics to mean a waiting vehicle still owns an actual future lease or reservation, not merely that it has route fields for resume/debug.

Validation commands:

```bash
./node_modules/.bin/tsc -p packages/shuttle-schemas/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "shadow resource ledger|stale local-route|blocked waiters|reservation-blocked|waiting route fields"
npx tsx scripts/run-physical-24h-amr-audit.ts --hours 0.25 --out output/review/shadow-ledger-step2-smoke-15m-audit.json --checkpoint-dir output/review/shadow-ledger-step2-smoke-15m-checkpoints --audit-every-sec 30 --quiet-critical
npx tsx scripts/render-amr-24h-report.mjs output/review/shadow-ledger-step2-smoke-15m-audit.json output/review/shadow-ledger-step2-smoke-15m-report.html
npx tsx scripts/run-physical-24h-amr-audit.ts --hours 6 --out output/review/physical-6h-shadow-ledger-step2-audit.json --checkpoint-dir output/review/physical-6h-shadow-ledger-step2-checkpoints --audit-every-sec 30 --quiet-critical
npx tsx scripts/render-amr-24h-report.mjs output/review/physical-6h-shadow-ledger-step2-audit.json output/review/physical-6h-shadow-ledger-step2-report.html
```

6h comparison against Step 1:

| Metric | Step 1 | Step 2 |
| --- | ---: | ---: |
| Total PPH | `504.333` | `493.500` |
| Inbound PPH | `237.667` | `232.167` |
| Outbound PPH | `266.667` | `261.333` |
| AMR anomalies | `0` | `0` |
| Critical anomalies | `0` | `0` |
| Physical violations | `0` | `0` |
| Min vehicle separation | `2.100879m` | `1.540667m` |
| Wall clock | `1,984,775 ms` | `2,110,651 ms` |
| Shadow samples with violations | `578 / 720` | `445 / 720` |
| Max shadow invariant total | `16` | `11` |
| Max blocked-waiter future claim | `4` | `0` |
| Max stale local-route claim | `2` | `0` |
| Duplicate owner samples | `1477` | `1192` |
| Blocked-waiter future-claim samples | `350` | `0` |
| Stale local-route samples | `104` | `0` |

AMR 10-minute task matrix:

- Every shuttle has `36 / 36` OK windows.
- `zeroTaskMovingWindows = 0` for all 8 shuttles.
- `riskWindows = 0` for all 8 shuttles.
- Minimum completed tasks per 10-minute window by shuttle:
  - SH-01: `7`
  - SH-02: `8`
  - SH-03: `5`
  - SH-04: `6`
  - SH-05: `8`
  - SH-06: `9`
  - SH-07: `5`
  - SH-08: `8`

Interpretation:

- This step solved the target issue: blocked waiters are no longer shadow owners of future resources, and stale local-route claims are cleared.
- The run did not show the earlier long-dropout pattern: no shuttle had a zero-task moving window or risk window.
- The 6h PPH regression is about `2.1%`, so this is not yet a final commit candidate under the current target.
- The remaining system-level issue is duplicate future ownership, concentrated around shared spine and column nodes such as `module-boundary-01-spine-bottom-a`, `module-01-spine-middle`, and nearby middle/bottom column nodes.

Next Step 3:

Reduce duplicate future ownership without reintroducing hidden waiter holds. The likely principle is to shorten planned-route claim horizon and/or replace route-wide planned claims on shared spine/aisle nodes with a narrower lease window, then rerun the same 15m and 6h comparison.

## Step 3 Experiment: Waiting Route Demand Signal Rejected

Date: 2026-06-19

Experiment:

- Keep `waiting-blocked` excluded from real future resource ownership.
- Re-allow waiting vehicles' future route fields as a demand signal in taskless storage-exit / active-route clearing heuristics.
- Hypothesis: this would restore the Step 1 PPH lost in Step 2 without reintroducing hidden future ownership.

Result:

- File: `output/review/physical-6h-shadow-ledger-step3-audit.json`
- Failure report: `output/review/physical-6h-shadow-ledger-step3-failed-report.html`
- Final 6h PPH: total `477.667`, inbound `224.333`, outbound `253.333`
- AMR anomalies: `24`
- Critical anomalies: `20`
- Physical violations: `0`
- Final waiting/blocking vehicles: `6`
- The failure starts around `20,400s` / window `34` and becomes critical by `21,000s` / window `35`.

Representative final wait state:

- SH-02: `inbound-column-predecessor-wait`, blocked for `2965.796s`
- SH-03: `top-lift-spine-opposing-claim`, blocked by SH-07 for `3120.224s`
- SH-05: `inbound-lift-fifo-wait`, blocked for `2837.033s`
- SH-07: `min-separation`, blocked by SH-08 for `2905.540s`
- SH-08: `top-lift-spine-opposing-claim`, blocked by SH-03 for `3186.725s`

Decision:

- Rejected and reverted.
- Waiting vehicles must not contribute route-wide demand signals to taskless clearing / active-route blockers unless that signal is modeled as a bounded, queue-owned lease with FIFO and TTL.
- The next valid Step 3 should not restore waiting-route lookahead directly. It should instead reduce duplicate route ownership by making planned-route leases shorter and more explicit, especially on shared spine nodes.

## 12h Step 2 Long-Window Verification

Date: 2026-06-19

Current verified code state:

- Step 2 retained.
- Step 3 demand-signal experiment reverted.

Run:

```bash
npx tsx scripts/run-physical-24h-amr-audit.ts --hours 12 --out output/review/physical-12h-shadow-ledger-step2-audit.json --checkpoint-dir output/review/physical-12h-shadow-ledger-step2-checkpoints --audit-every-sec 30 --quiet-critical
npx tsx scripts/render-amr-24h-report.mjs output/review/physical-12h-shadow-ledger-step2-audit.json output/review/physical-12h-shadow-ledger-step2-report.html
```

Result:

- File: `output/review/physical-12h-shadow-ledger-step2-audit.json`

## Step 4 Experiment: Planned Route Hard Claims Rejected

Date: 2026-06-20

Question:

- The 6h service-lane run still showed frequent `duplicate-resource-owner` shadow warnings, mostly from overlapping `plannedRouteNodeIds`.
- We tested whether near-term planned-route claims on yellow-grid service nodes should become real runtime blockers.

Experiment:

- Temporarily made top-lift no-parking / queue / spine / service nodes treat near planned-route claims as hard node claims.
- This aligned runtime blocking with the shadow ledger in a direct way.

Result:

- Rejected.
- The 20-minute smoke immediately regressed:
  - At `600s`: total PPH `414`, anomalies `1`.
  - At `1200s`: total PPH `291`, anomalies `7`.
- The run was stopped early because the hard-claim approach serialized too much traffic and created early AMR risk windows.

Decision:

- `plannedRouteNodeIds` must remain a shadow warning / planning signal, not a global hard lock.
- The correct next step is not to block on all planned overlap. It is to model only bounded, queue-owned leases with FIFO/TTL for specific resources where physical order matters.

## Step 4a: Current Wait Duration Diagnostics

Date: 2026-06-20

Behavior change:

- No simulation routing or dispatch behavior changed.
- `scripts/run-physical-24h-amr-audit.ts` now writes `currentWaitSec` into compact checkpoint and final vehicle rows.
- `currentWaitSec` is derived from `traffic.waitingVehicles.waitingSinceSec`, so reports can distinguish:
  - `blockedTimeSec`: cumulative blocked time across the run.
  - `currentWaitSec`: how long the AMR has been continuously waiting right now.

Validation commands:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "no-parking blocker|shadow resource ledger|stale local-route|blocked waiters|reservation-blocked|waiting route fields"
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.1 --out output/review/physical-0p1h-current-wait-script-smoke-audit.json --checkpoint-dir output/review/physical-0p1h-current-wait-script-smoke-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 1.5 --out output/review/physical-1p5h-current-wait-diagnostics-audit.json --checkpoint-dir output/review/physical-1p5h-current-wait-diagnostics-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/render-amr-24h-report.mjs output/review/physical-1p5h-current-wait-diagnostics-audit.json output/review/physical-1p5h-current-wait-diagnostics-report.html
```

1.5h result:

- File: `output/review/physical-1p5h-current-wait-diagnostics-audit.json`
- Report: `output/review/physical-1p5h-current-wait-diagnostics-report.html`
- Total PPH: `512.667`
- Inbound PPH: `196.667`
- Outbound PPH: `316.000`
- AMR anomalies: `0`
- Critical anomalies: `0`
- Deadlocks: `0`
- Physical violations: `0`
- Final waiting vehicles: `0`
- Final max `currentWaitSec`: `0`

Interpretation:

- The bad planned-route hard-claim experiment was fully reverted.
- The current behavior returned to the previous healthy 1.5h baseline.
- Future analysis should use `currentWaitSec` for live stuck/queue interpretation, while treating `blockedTimeSec` as cumulative history.
- Report: `output/review/physical-12h-shadow-ledger-step2-report.html`
- Wall clock: `4,835,169 ms`
- Final 12h PPH: total `493.167`, inbound `239.083`, outbound `254.083`
- AMR anomalies: `0`
- Critical anomalies: `0`
- Flagged windows: `0`
- Physical violations: `0`
- Deadlocks / livelocks: `0 / 0`
- Final shadow-ledger invariant total: `0`
- Max blocked-waiter future claim: `0`
- Max stale local-route claim: `0`
- Passed the previous danger point at `8h` with `0` anomalies:
  - 8h PPH: total `494.250`, inbound `236.375`, outbound `257.875`
  - 8h waiting/blocking: `1 / 1`
  - 8h new risk windows: `0`

AMR 10-minute task matrix:

- Every shuttle has `72 / 72` OK windows.
- `zeroTaskMovingWindows = 0` for all 8 shuttles.
- `riskWindows = 0` for all 8 shuttles.
- Minimum completed tasks per 10-minute window by shuttle:
  - SH-01: `7`
  - SH-02: `8`
  - SH-03: `5`
  - SH-04: `6`
  - SH-05: `8`
  - SH-06: `6`
  - SH-07: `5`
  - SH-08: `6`

Interpretation:

- The Step 2 version does not reproduce the previous 8h-plus long-dropout pattern in a 12h audit.
- The remaining concern is throughput: 12h total PPH stabilizes near `493`, below the Step 1 6h baseline `504.333`.
- The next improvement should focus on duplicate future ownership / route horizon on shared spine nodes, without letting waiting vehicles own or signal route-wide future claims.

## Step 3a Experiment: Immediate Waiting Target Signal Rejected

Date: 2026-06-19

Experiment:

- Keep Step 2 real ownership rules unchanged: `waiting-blocked` vehicles do not own future target/route resources.
- Allow only a waiting vehicle's immediate `targetNodeId` to act as a taskless clearing demand signal.
- Do not allow waiting vehicles' planned/local route tails as demand signals.

Result:

- File: `output/review/physical-6h-shadow-ledger-step3a-immediate-target-audit.json`
- Report: `output/review/physical-6h-shadow-ledger-step3a-immediate-target-report.html`
- Final 6h PPH: total `493.500`, inbound `232.167`, outbound `261.333`
- AMR anomalies: `0`
- Critical anomalies: `0`
- Physical violations: `0`
- Max blocked-waiter future claim: `0`
- Max stale local-route claim: `0`

Decision:

- Rejected and reverted because it produced no measurable PPH improvement over Step 2.
- It was safe, but not useful.
- Continue with a different Step 3: reduce route-wide duplicate planned ownership or improve lift FIFO / route-unavailable behavior directly, not by adding waiting-route demand signals.

## Step 4b: Deadlock Count Severity Uses Current Wait

Date: 2026-06-20

Behavior change:

- No simulation routing or dispatch behavior changed.
- `deadlock-count-increased` audit findings now include `activeCandidates` and `maxCurrentWaitSec`.
- A deadlock-count increase is treated as `watch` unless the current live wait reaches the long-wait threshold.
- This avoids treating cumulative/self-recovered deadlock-counter movement as a critical AMR dropout.

Validation:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 6 --out output/review/physical-6h-current-wait-deadlock-watch-audit.json --checkpoint-dir output/review/physical-6h-current-wait-deadlock-watch-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/render-amr-24h-report.mjs output/review/physical-6h-current-wait-deadlock-watch-audit.json output/review/physical-6h-current-wait-deadlock-watch-report.html
```

6h result:

- File: `output/review/physical-6h-current-wait-deadlock-watch-audit.json`
- Report: `output/review/physical-6h-current-wait-deadlock-watch-report.html`
- Total PPH: `496.667`
- Inbound PPH: `234.333`
- Outbound PPH: `262.333`
- AMR anomalies: `2`
- Critical anomalies: `0`
- Ten-minute AMR risk windows: `0`
- Final waiting/blocking vehicles: `1 / 1`
- Final live wait: SH-04 at `25.6s` with `inbound-column-predecessor-wait`

Hourly shape:

- H1: total `521`, inbound `172`, outbound `349`
- H2: total `500`, inbound `248`, outbound `252`
- H3: total `494`, inbound `250`, outbound `244`
- H4: total `487`, inbound `244`, outbound `243`
- H5: total `475`, inbound `237`, outbound `238`
- H6: total `503`, inbound `255`, outbound `248`

Interpretation:

- The cumulative PPH line declines mainly because H1 starts above steady state, especially from outbound seeded-inventory advantage.
- The run does not show monotonic degradation: H5 is a low hour, then H6 recovers to `503`.
- The remaining real issue is intermittent local inefficiency, visible as high loopiness windows and short wait/block tails, not a confirmed long AMR dropout in this 6h run.
- Next engineering work should target queue-owned bounded leases / FIFO release on specific shared resources and reduce target/route oscillation, rather than turning all planned-route overlap into hard locks.

## Step 4c: H5 PPH Dip Diagnosis

Date: 2026-06-20

Question:

- The 6h run visually looks strong in the first few hours, then the cumulative PPH trend drifts downward.
- Need to determine whether this is a real late-run degradation, AMR dropout, a loopiness problem, or normal warm-up-to-steady-state behavior.

Diagnostic tooling change:

- `scripts/diagnose-vehicle-window.ts` now accepts:
  - `--initial-fill-policy`
  - `--storage-selection-policy`
  - `--sample-sec`
  - `--task-sample-sec`
  - `--fast-forward-chunk-sec`
  - `--progress-sec`
- The script now fast-forwards with `advanceByInPlace` before the target window, then samples only inside the window.
- This avoids cloning the full simulation state every `0.2s` from time zero just to inspect a late window.

Validation:

```bash
./node_modules/.bin/tsx scripts/diagnose-vehicle-window.ts --start-sec 0 --end-sec 2 --dt-sec 0.2 --sample-sec 1 --task-sample-sec 0 --progress-sec 0 --vehicles SH-01 --initial-fill-policy zone-balanced-50 --storage-selection-policy sequential --out output/review/vehicle-window-diagnosis-smoke.json
```

H5 trace run:

```bash
./node_modules/.bin/tsx scripts/diagnose-vehicle-window.ts --start-sec 18000 --end-sec 19800 --dt-sec 0.2 --sample-sec 1 --task-sample-sec 0 --progress-sec 1800 --fast-forward-chunk-sec 30 --vehicles SH-01,SH-03,SH-05 --initial-fill-policy zone-balanced-50 --storage-selection-policy sequential --out output/review/h5-loopiness-vehicle-window-diagnosis.json
```

Trace result:

- File: `output/review/h5-loopiness-vehicle-window-diagnosis.json`
- Window: `18,000s` to `19,800s`
- Vehicles: SH-01, SH-03, SH-05
- Samples: `5,400`
- Events: `2,745`
- Route-signature changes: `2,629`
- Axis turnbacks under 8s: `116`
- Final status: `completed`
- Physical violations: `0`

Interpretation:

- The high `route-signature-changed` count is mostly normal route progress; it is not by itself a defect because active route signatures change as vehicles consume route nodes.
- High `loopinessIndex` windows are not automatically AMR dropouts. In this trace, the high-loop vehicles still completed many tasks:
  - SH-01: `35` distinct tasks in 30 minutes.
  - SH-03: `33` distinct tasks in 30 minutes.
  - SH-05: `37` distinct tasks in 30 minutes.
- Axis turnbacks exist and are visually relevant, but they are distributed short reversals, not a single long lockup.

H5 vs H6 evidence:

- H5 hourly total: `475`.
- H6 hourly total: `503`.
- H5 fleet idle seconds: `4,350`.
- H6 fleet idle seconds: `3,450`.
- H5 fleet blocked seconds: `1,920`.
- H6 fleet blocked seconds: `2,520`.
- Therefore H5 is not lower because it had more blocked time. It is lower mostly because productive task time was lower and idle/taskless gaps were higher.

10-minute H5 pattern:

- `14,400-15,000s`: `75` tasks, `990s` idle.
- `15,000-15,600s`: `83` tasks, `540s` idle.
- `15,600-16,200s`: `77` tasks, `1,020s` idle.
- `16,200-16,800s`: `80` tasks, `630s` idle.
- `16,800-17,400s`: `84` tasks, `750s` idle.
- `17,400-18,000s`: `76` tasks, `420s` idle.

Decision:

- Do not treat the cumulative PPH decline as monotonic late-run degradation.
- Do not treat high loopiness alone as a critical anomaly unless it also has low task completion, long current wait, or a confined run.
- The next behavior change should focus on reducing taskless/waste reposition and assignment gaps, while preserving the current no-dropout behavior.
- The next tooling change should add hourly deltas for `blockedTimeByReasonSec` and task-state counts directly into the audit output; cumulative blocked reasons are not enough to explain hour-specific dips.

## Step 4d: Hourly Delta Diagnostics Added

Date: 2026-06-20

Behavior change:

- No simulation routing or dispatch behavior changed.
- `scripts/run-physical-24h-amr-audit.ts` now adds the following fields to each hourly row:
  - `activeTasks`
  - `queuedTasks`
  - `hourlyBlockedReasons`
  - `taskStates`
  - `taskWaitReasons`
- `scripts/render-amr-24h-report.mjs` now shows queued tasks, top hourly blocked reasons, and task wait reasons in the hourly table.

Why:

- H5 diagnosis showed that cumulative `blockedTimeByReasonSec` is not enough to explain hour-specific PPH dips.
- Future 6h / 12h / 24h reports need direct per-hour reason deltas so H5-like dips can be explained without ad hoc `jq`.

Validation:

```bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.1 --hourly-sec 300 --out output/review/physical-0p1h-hourly-delta-smoke-audit.json --checkpoint-dir output/review/physical-0p1h-hourly-delta-smoke-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/render-amr-24h-report.mjs output/review/physical-0p1h-hourly-delta-smoke-audit.json output/review/physical-0p1h-hourly-delta-smoke-report.html
```

Result:

- File: `output/review/physical-0p1h-hourly-delta-smoke-audit.json`
- Report: `output/review/physical-0p1h-hourly-delta-smoke-report.html`
- Final time: `360s`
- Total PPH: `560`
- Critical anomalies: `0`
- Hourly rows now include `hourlyBlockedReasons`, `taskStates`, and `taskWaitReasons`.

## Step 4e: Standby Origin Relaxed Experiment

Date: 2026-06-20

Question:

- The user observed that PPH looks stable in the first 3-4 hours, then the cumulative trend drifts downward.
- Need to determine whether the drop is caused by long AMR dropouts, lack of vehicles, or a queue/resource model that slowly loses efficient lift handoff.

Diagnostic evidence:

- Baseline file: `output/review/physical-6h-current-wait-deadlock-watch-hourly-delta-audit.json`
- Baseline report: `output/review/physical-6h-current-wait-deadlock-watch-hourly-delta-report.html`
- Baseline hourly total PPH: `521`, `500`, `494`, `487`, `475`, `503`
- H5 top hourly blocked reasons:
  - `inbound-lift-fifo-wait`: `8461.469s`
  - `vehicle-unavailable`: `7349.4s`
  - `route-unavailable`: `3126s`
  - `storage-empty`: `1961.6s`
  - `inbound-lift-source-assigned`: `1807.224s`
- H5 task wait reasons: `inbound-lift-fifo-wait` x4, `route-unavailable` x1

Interpretation:

- The cumulative PPH decline is real, but it is not a confirmed monotonic AMR dropout in the 6h baseline.
- H1 starts high because of warm-up / seeded outbound advantage, then the system settles closer to steady state.
- The later-hour dip is mostly from lift handoff and route availability inefficiency, not from all vehicles becoming idle.
- The active fleet remains heavily utilized, but too much of that utilization is spent on waiting, route churn, and taskless/waste reposition.

Behavior experiment:

- Relaxed `tasklessInboundQueueStandbyRouteOriginAllowed()` so a taskless vehicle may route toward an inbound queue standby slot from any legal route origin, instead of only from top-lift/top-queue nodes.
- Existing route safety checks still apply through local-route clear checks and active top-lift outbound dock blockers.

Validation commands:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/tsx scripts/diagnose-queue-reserve-efficiency.ts --duration-sec 7200 --sample-sec 60 --progress-sec 1800 --initial-fill-policy zone-balanced-50 --storage-selection-policy sequential --out output/review/queue-reserve-efficiency-2h-standby-origin-relaxed.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 2 --out output/review/physical-2h-standby-origin-relaxed-audit.json --checkpoint-dir output/review/physical-2h-standby-origin-relaxed-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/render-amr-24h-report.mjs output/review/physical-2h-standby-origin-relaxed-audit.json output/review/physical-2h-standby-origin-relaxed-report.html
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 6 --out output/review/physical-6h-standby-origin-relaxed-audit.json --checkpoint-dir output/review/physical-6h-standby-origin-relaxed-checkpoints --audit-every-sec 30 --quiet-critical
./node_modules/.bin/tsx scripts/render-amr-24h-report.mjs output/review/physical-6h-standby-origin-relaxed-audit.json output/review/physical-6h-standby-origin-relaxed-report.html
```

2h queue reserve diagnosis:

- File: `output/review/queue-reserve-efficiency-2h-standby-origin-relaxed.json`
- Total PPH: `519`
- `averageStandbyDepth`: `0`
- `averageReserveVehicles`: `0`
- `queueReserveTravelPct`: `0.039`
- `wasteRepositionPct`: `5.794`
- Physical violations: `0`

2h audit:

- File: `output/review/physical-2h-standby-origin-relaxed-audit.json`
- Report: `output/review/physical-2h-standby-origin-relaxed-report.html`
- Total PPH: `519`
- Inbound PPH: `215.5`
- Outbound PPH: `303.5`
- AMR anomalies: `0`
- Critical anomalies: `0`
- Ten-minute risk windows: `0`

6h audit:

- File: `output/review/physical-6h-standby-origin-relaxed-audit.json`
- Report: `output/review/physical-6h-standby-origin-relaxed-report.html`
- Total PPH: `502.667`
- Inbound PPH: `237.167`
- Outbound PPH: `265.500`
- AMR anomalies: `0`
- Critical anomalies: `0`
- Ten-minute AMR risk windows: `0`
- Final waiting/blocking vehicles: `0 / 0`
- Final min vehicle separation: `4.032253m`
- Wall clock: `1,927,107 ms`

6h hourly comparison:

| Hour | Baseline total | Experiment total |
| --- | ---: | ---: |
| H1 | `521` | `537` |
| H2 | `500` | `501` |
| H3 | `494` | `502` |
| H4 | `487` | `491` |
| H5 | `475` | `491` |
| H6 | `503` | `494` |

6h shadow-ledger evidence:

- Final shadow invariant total: `3`
- Shadow samples with violations: `487 / 720`
- Max invariant total: `14`
- Top violation codes:
  - `duplicate-resource-owner`: `1381`
  - `lift-fifo-inversion`: `128`
  - `orphaned-yield-hold`: `75`
  - `conflict-session-without-yield-hold`: `22`
  - `column-mode-conflict`: `6`
- Top duplicate resources include shared spine nodes:
  - `node:module-01-spine-bottom-a`
  - `node:module-01-spine-middle`
  - `node:module-02-spine-middle`
  - `node:module-boundary-01-spine-middle`
  - `node:module-02-spine-top-b`

Decision:

- The experiment improves 6h PPH versus the current-wait baseline from `496.667` to `502.667`, with no AMR risk windows or critical anomalies.
- It does not solve the underlying reserve-queue problem: stable taskless standby depth remains essentially `0`.
- It also does not clean up shadow ownership: duplicate future ownership remains frequent.
- Treat this as a useful but incomplete improvement, not a final customer-review proof.

Next step:

- Do not add more shuttles.
- Do not make all planned-route overlap a hard lock.
- Implement an explicit queue-owned lease model for lift approach / shared spine handoff:
  - bounded FIFO queue slots,
  - short TTL ownership,
  - one clear owner per physical conflict resource,
  - direct handoff from completed lift task to the next standby vehicle.
- Success criteria for the next step:
  - 6h total PPH stays at or above `502.667`,
  - critical anomalies remain `0`,
  - ten-minute AMR risk windows remain `0`,
  - `averageStandbyDepth` becomes non-zero for inbound lift queues,
  - shadow duplicate owner samples on the top shared spine resources are materially reduced.

## 2026-06-21 read-purity fix and rejected queue identity experiment

Root cause confirmed:

- `getState()` and dashboard/audit reads could change simulation state by compacting or promoting inbound source-buffer loads while building diagnostics.
- The first observed divergence happened by `90s`: `source-load-00004` and `source-load-00011` swapped source buffer nodes depending on whether `getState()` was called every `30s`.
- This meant visual observation, audit sampling, and long-run reports could perturb the physical tick model.

Accepted fix:

- Added a diagnostic read-only guard around public state reads.
- Blocked inbound source buffer compaction and source-load promotion while `diagnosticReadOnlyDepth > 0`.
- Added regression test: `does not compact inbound source buffers while reading public state`.

Validation:

- Targeted test passed: `vitest ... -t "does not compact inbound source buffers while reading public state"`.
- Typecheck passed: `tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit`.
- Direct A/B proof at `600s`:
  - no-read and read-every-30s runs had identical `kpis`, `loads`, `tasks`, `vehicles`, and `reservations`.
  - `totalPph=516`, `inboundPph=210`, `outboundPph=306` in both runs.
- 30m physical audit after fix:
  - File: `output/review/current-0p5h-after-read-purity-audit.json`
  - Total PPH: `508`
  - Inbound PPH: `200`
  - Outbound PPH: `308`
  - AMR anomalies: `0`
  - Critical anomalies: `0`
  - Ten-minute risk windows: `0`

Remaining issue:

- Queue reserve diagnosis after the accepted fix still shows the lift-side reserve queue is not actually forming:
  - File: `output/review/local-queue-reserve-after-read-purity-0p5h.json`
  - `averageCoveredDepth=0.478`
  - `averageStandbyDepth=0`
  - `averageReserveVehicles=0`
  - `averageActiveInboundInTransitToQueue=1.022`
  - `farActiveInboundRouteSamples=97`
  - `offQueueWaitingSamples=90`
- Interpretation: the system still uses active inbound assignments from farther away instead of maintaining a true taskless FIFO queue resource near the lift.

Rejected experiment:

- Tried broad queue identity sync: taskless vehicles with a planned inbound queue goal were counted as queue standby resources.
- 30m physical audit regressed:
  - File: `output/review/current-0p5h-after-queue-identity-audit.json`
  - Total PPH: `474`
  - Inbound PPH: `204`
  - Outbound PPH: `270`
  - AMR anomalies: `1`
  - Critical anomalies: `0`
- Decision: rejected and reverted. It improved inbound pressure accounting too broadly and hurt total flow/outbound stability.

Rejected experiment:

- Tried local top-level queue staging route cap: only allow inbound queue standby staging when the route stays short and local to the top lift approach.
- Early 10m physical audit sample regressed badly:
  - File: `output/review/current-0p5h-after-local-queue-staging-audit.json`
  - Sample time: `600s`
  - Total PPH: `450`
  - Inbound PPH: `144`
  - Outbound PPH: `306`
  - AMR anomalies: `0`
- Decision: rejected, stopped early, and reverted. The cap prevented far fake queue tours, but it was too restrictive and starved inbound instead of creating a real FIFO reserve queue.

Rejected experiment:

- Tried delayed task binding for inbound queue standby dispatch: taskless shuttles could travel toward the inbound queue, but queued inbound tasks would only consume them once they were at or directly targeting a queue slot.
- Early 10m physical audit sample regressed badly:
  - File: `output/review/current-0p5h-after-taskless-queue-dispatch-audit.json`
  - Sample time: `600s`
  - Total PPH: `432`
  - Inbound PPH: `114`
  - Outbound PPH: `318`
  - AMR anomalies: `0`
- Decision: rejected, stopped early, and reverted. Delaying task binding created a cleaner theoretical queue but starved lift pickup dispatch in the current tick model.

Rejected experiment:

- Tried blocking lower-level direct task binding inside `assignQueuedInboundTaskToQueueStandby()`, so middle/bottom/storage routes could not bypass the lower-level inbound assignment guard when being sent to an inbound queue.
- 10m queue diagnosis did reduce far active inbound queue routes, but throughput regressed badly:
  - File: `output/review/local-queue-reserve-after-lower-level-queue-bind-guard-10m.json`
  - `farActiveInboundRouteSamples`: `2`
  - Total PPH: `438`
  - Inbound PPH: `132`
  - Outbound PPH: `306`
  - AMR anomalies: `0`
- Decision: rejected, stopped at 10m, and reverted. The current 8-shuttle high-load model relies on lower/middle/storage vehicles to replenish inbound; blocking that path reduces ugly routing but starves the lift.

Next step:

- Keep the accepted read-purity fix.
- Do not use broad planned-goal queue identity as a fix.
- The next queue attempt should be narrower: explicit queue-owned lease / handoff only for vehicles physically in or immediately entering a lift queue slot, with bounded TTL and no protection for long top-lane standby tours.

## Station-Owned Contract Shadow Mode

Date: 2026-06-22

Goal:

- Keep the existing 3D tick simulation as the high-fidelity source of physical movement.
- Add a station-owned shadow contract before changing behavior.
- Make inbound lift demand, AMR queue reservation, physical queue occupancy, and active inbound service visible as separate concepts.
- Use the shadow contract to prove whether a future station coordinator is needed before changing task assignment or pathing.

Implementation:

- Added `traffic.shadowLedger.stationContracts`.
- Added per-inbound-lift station snapshots with:
  - `demandCount`
  - `readyDemandCount`
  - `claimedDemandCount`
  - `sourceBufferOccupancy`
  - `targetDepth`
  - `physicalDepth`
  - `nearCoveredDepth`
  - `farForecastDepth`
  - `queueReservationCount`
  - `activeServiceDepth`
  - bounded demand and vehicle-commitment samples
- Added station invariant counters:
  - `demandWithoutCoverage`
  - `queueReservationOverTarget`
  - `physicalDepthOverTarget`
  - `activeServiceWithoutDemand`
  - `duplicateVehicleCommitment`
- Added tests that prove:
  - one inbound station can report claimed demand, an AMR queue reservation, and active service separately.
  - sampling the station contract within a 3D tick is read-only and does not change the engine snapshot hash.

Validation commands:

```bash
./node_modules/.bin/tsc -p packages/shuttle-schemas/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|station shadow contract sampling" --reporter verbose
./node_modules/.bin/tsx scripts/diagnose-queue-reserve-efficiency.ts --duration-sec 300 --sample-sec 10 --dt-sec 0.2 --progress-sec 0 --initial-fill-policy zone-balanced-50 --out output/review/station-contract-shadow-smoke-300s.json
```

300s smoke evidence:

- File: `output/review/station-contract-shadow-smoke-300s.json`
- Samples: `30`
- Average covered depth: `0.567`
- Average standby depth: `0`
- Average reserve vehicles: `0`
- Average active inbound empty vehicles: `1.433`
- Average active inbound in queue slot: `0.433`
- Average active inbound in transit to queue: `0.967`
- Far active inbound route samples: `14`
- Off-queue waiting samples: `12`
- Final total PPH: `528`
- Final inbound PPH: `204`
- Final physical violations: `0`
- Final deadlocks/livelocks: `0 / 0`

Station-contract finding:

- `lift-01-inbound`: `readyDemandCount=2`, `nearCoveredDepth=0`, `queueReservationCount=0`, `activeServiceDepth=2`.
- `lift-02-inbound`: `readyDemandCount=3`, `nearCoveredDepth=0`, `queueReservationCount=0`, `activeServiceDepth=1`.
- Final invariant counts: `demandWithoutCoverage=2`, total station-contract invariants `2`.

Interpretation:

- The current problem is now visible as a station contract failure: inbound lifts can have ready demand while no near AMR queue coverage exists.
- The current logic still services inbound by binding active inbound vehicles from farther away instead of maintaining a true lift-owned FIFO queue resource.
- This validates the ChatGPT Pro recommendation: the next behavior-changing step should be a station-owned coordinator / lease handoff, not another local path guard.

Next step:

- Keep station contracts in shadow mode as the comparison surface.
- Implement the smallest source-of-truth change at the lift station boundary:
  - station owns a bounded `queueReservation` target depth.
  - task assignment consumes station queue resources in FIFO order.
  - physical queue slot occupancy and AMR reservation are separate but reconciled by station invariants.
  - active inbound service must correspond to real station demand.
- Run 10m A/B first, compare against this smoke and the latest accepted baseline before attempting 30m/24h.

## Station Queue Candidate Diagnosis

Date: 2026-06-22

Diagnostic added:

- Script: `scripts/diagnose-station-queue-contract.ts`
- Output: `output/review/station-queue-contract-diagnosis-600s.json`
- Purpose: identify why available AMRs do not remain as station-owned inbound queue reservations.

Command:

```bash
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --progress-sec 0 --initial-fill-policy zone-balanced-50 --out output/review/station-queue-contract-diagnosis-600s.json
```

600s result:

- Samples: `61`
- Candidate blocker totals:
  - `busy-task`: `388`
  - `busy-moving`: `64`
  - `no-standby-route`: `26`
  - `no-station-target`: `8`
  - `route-origin-disallowed`: `2`
- Average ready demand per station sample: `2.484`
- Average near covered depth: `0.598`
- Average station queue reservation count: `0.049`
- Final station invariant total: `1`
- Final PPH: total `516`, inbound `210`, outbound-demand `0`
- Physical violations: `0`
- Deadlocks/livelocks: `0 / 0`

Finding:

- Queue reserve failure is not primarily caused by `route-origin-disallowed`; that only appears twice in this 600s sample.
- The dominant reason is `busy-task`: AMRs are consumed as assigned tasks before the station can preserve a FIFO queue resource.
- At `0s`, each inbound lift starts with too many queue occupants (`physicalDepth=3`, target `2`), but once inbound work begins, queueReservation quickly collapses to `0` while ready demand stays high.

Decision:

- A local path guard is the wrong next cut.
- The first source-of-truth behavior change should be at task assignment / station ownership:
  - station may consume a physically leading queue shuttle for active service.
  - station must retain or replenish bounded queue reservations instead of converting every nearby AMR into an active inbound task.
  - outbound and unrelated inbound work must not steal station-owned reserve depth while ready inbound demand exists.

Rejected source experiments:

- Experiment A: protect the full required reserve depth in `topLiftInboundQueueResourcesForTask` once a station had an active inbound task.
  - Output: `output/review/station-queue-contract-source-step1-600s.json`
  - Average queue reservation count improved from `0.049` to `0.172`.
  - Inbound PPH regressed from `210` to `186`.
  - Final station invariant total worsened to `2`.
  - Decision: rejected. It created some queue reserve signal but starved inbound service too aggressively.
- Experiment B: protect only one queue AMR while a station had active inbound service.
  - Output: `output/review/station-queue-contract-source-step1b-600s.json`
  - Average queue reservation count was `0.131`.
  - Inbound PPH regressed further to `168`; total PPH regressed to `498`.
  - Final station invariant total stayed `2`.
  - Decision: rejected and reverted. Holding the last queue AMR in the resource selector is still the wrong abstraction.

Updated next step:

- Move the source-of-truth cut one level earlier: station-owned active WIP and demand admission.
- The station should decide how many inbound tasks may be active versus how many AMRs must remain as queue reservations before `bestAvailableVehicleForTask()` sees the vehicles.
- Keep queue resource selection FIFO, but do not solve station ownership by hiding queue vehicles locally inside `topLiftInboundQueueResourcesForTask()`.

Rejected admission experiment:

- Experiment C: use station admission capacity for mixed inbound task creation only, with cap equal to `topLiftInboundQueueReplenishTargetDepth`.
  - 600s output: `output/review/station-admission-task-selection-cap-600s.json`
  - 600s result improved short-window total PPH from current baseline `516` to `534`, and inbound PPH from `210` to `222`.
  - Average ready demand improved from `2.484` to `0.738`.
  - Max active service per station dropped from `3` to `2`.
  - 30m output: `output/review/station-admission-task-selection-cap-0p5h-audit.json`
  - 30m current-head baseline: `output/review/station-admission-current-head-baseline-0p5h-audit.json`
  - 30m baseline PPH: total `508`, inbound `200`, outbound `308`, anomalies `0`, final shadow total `2`.
  - 30m experiment PPH: total `494`, inbound `194`, outbound `300`, anomalies `0`, final shadow total `4`.
  - Decision: rejected and reverted. Task admission capping helps the first 10 minutes but causes a 30m throughput regression and more final shadow ownership ambiguity.

Updated next step:

- Do not reduce inbound task admission globally.
- Focus on remote active-service route ownership: the remaining 30m regression is concentrated in duplicate future owners and middle/spine opposing claims, not in collision or AMR anomaly windows.
- The next source-of-truth cut should narrow or stage future claims for far inbound active-service routes before they enter the lift queue, while keeping station demand admission unchanged.

Rejected planned-claim source experiments:

- Experiment D: make active traffic claims use only the first `4` planned-route nodes for every vehicle, and mirror that in shadow planned-route leases.
  - 600s station diagnosis: `output/review/planned-claim-nearfield-station-diagnosis-600s.json`
  - 10m physical audit: `output/review/planned-claim-nearfield-10m-audit.json`
  - 30m physical audit: `output/review/planned-claim-nearfield-0p5h-audit.json`
  - 10m result looked promising: total `540`, inbound `228`, anomalies `0`, max shadow total `3`.
  - 30m result regressed: total `502`, inbound `190`, outbound `312`, anomalies `0`; baseline was total `508`, inbound `200`, outbound `308`.
  - Decision: rejected and reverted as behavior. A global near-field planned-claim cut removes too much useful coordination.
- Experiment E: narrow active planned-route claims only for remote active inbound service routes, using a `6` node claim window.
  - 600s station diagnosis: `output/review/remote-inbound-planned-claim-stage-station-diagnosis-600s.json`
  - 30m physical audit: `output/review/remote-inbound-planned-claim-stage-0p5h-audit.json`
  - 600s station result: invariant total `0`, total `540`, inbound `228`.
  - 30m result regressed further: total `496`, inbound `194`, outbound `302`, anomalies `0`.
  - Decision: rejected and reverted as behavior. Even the targeted active-claim staging delays useful inbound/outbound coordination enough to lose throughput by 30m.

Accepted shadow-only refinement:

- Keep runtime route arbitration unchanged.
- In shadow resource ledger only, stage planned-route leases for remote active inbound service routes with a `6` node window so far planned nodes are not counted as current shadow owners.
- Test added: `does not let far planned route nodes become active shadow owners`.
- 30m physical audit after this shadow-only change: `output/review/shadow-only-remote-inbound-planned-claim-stage-0p5h-audit.json`
  - PPH matches current-head baseline exactly: total `508`, inbound `200`, outbound `308`, anomalies `0`.
  - Shadow duplicate-resource-owner sample count decreased from `127` to `121`, while max duplicate-resource-owner remained `12`.

Updated next step:

- Do not change `activeTrafficClaimRouteCandidates()` by simply truncating planned routes.
- The next source cut needs an explicit station-owned route lease / release contract, not a generic planned-route horizon:
  - active service may own only the next physical approach segment until it reaches the station queue.
  - station queue slots should be leased by station coordinator and released on pickup/service transition.
  - middle/spine opposing-claim checks should consult those station leases instead of inferring ownership from full planned routes.

## Station Route Lease Shadow Contract

Change:

- Extended `shadowLedger.stationContracts.stations[]` with `routeLeases` and `routeLeaseCount`.
- Added lease kinds:
  - `physicalQueueSlot`: a vehicle physically occupies a station queue slot.
  - `queueSlotLease`: a vehicle targets or plans a station queue slot.
  - `approachSegmentLease`: a remote active inbound service owns only the short station approach segment represented in shadow.
- Added `duplicateRouteLease` to station invariant counts.
- Added tests:
  - `reports station-owned shadow contracts for inbound demand, queue reservation, and active service`
  - `reports duplicate station route leases before they become physical queue conflicts`

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|duplicate station route leases|station shadow contract sampling|far planned route nodes"
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-route-lease-shadow-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-route-lease-shadow-0p5h-audit.json --checkpoint-dir output/review/station-route-lease-shadow-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- 600s station diagnosis: total `516`, inbound `210`, physical violations `0`, station invariant total `1`, `duplicateRouteLease=0`.
- 30m physical audit: total `508`, inbound `200`, outbound `308`, anomalies `0`, critical anomalies `0`.
- Final station contract sample:
  - `lift-01-inbound`: `routeLeaseCount=0`, `queueReservationCount=0`, `activeServiceDepth=0`, `farForecastDepth=0`.
  - `lift-02-inbound`: `routeLeaseCount=1`, `queueReservationCount=0`, `activeServiceDepth=1`, `farForecastDepth=0`.

Decision:

- Accepted as shadow-only instrumentation.
- This does not change 3D tick behavior or PPH, but it gives the next source-of-truth cut a concrete station-owned resource list to consult.

Updated next step:

- Convert station route leases from shadow diagnostics into a runtime station coordinator table.
- First source cut should only read station-owned queue slot leases for inbound station entry and release them on pickup/service transition.
- Do not make middle/spine global planned-route ownership shorter until the station lease table can prove which station actually owns the contested route segment.

## Runtime Station Queue Slot Lease Read Cut

Change:

- Added a runtime `StationQueueSlotLease` view for inbound top-lift station queue slots.
- Centralized station queue slot claims from:
  - current physical node occupancy,
  - current target node,
  - planned goal node,
  - taskless inbound standby soft claims.
- Switched `inboundQueueSlotClaimedByOtherVehicle()` to read that station queue slot lease view instead of rebuilding the same slot-level claim scan locally.

Rejected during this cut:

- Do not replace `topLiftInboundQueueNodeHardClaimedByOtherVehicle()` with slot-level lease ownership.
- That function must remain exact-node semantics. A brief experiment showed that promoting all hard node claims to slot claims would incorrectly blur queue order / physical node ownership.
- The existing exact tests:
  - `keeps a trailing loaded outbound shuttle in its lift queue slot until the front dropoff clears`
  - `lets the physically leading inbound queue shuttle proceed when an earlier task is behind it`
  are already red on the current head before this cut, so they are tracked as baseline red items rather than regressions from this change.

Validation:

```bash
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "reports station-owned shadow contracts|reports duplicate station route leases|allows projected inbound queue vehicles|keeps upstream inbound queue slots available|lets real inbound work override far taskless standby queue claims|holds taskless inbound queue standby vehicles|compresses a taskless inbound queue standby forward|treats same-lift inbound queue vehicles|keeps a later same-lift inbound queue task|uses the next yellow queue slot|uses the tail projected queue slot|does not let a detached storage detour reserve every projected inbound queue slot" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-runtime-queue-lease-read-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-runtime-queue-lease-read-0p5h-audit.json --checkpoint-dir output/review/station-runtime-queue-lease-read-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Targeted runtime tests: `12 passed`.
- 600s station diagnosis:
  - File: `output/review/station-runtime-queue-lease-read-diagnosis-600s.json`
  - Total PPH `516`, inbound `210`, duplicate route lease `0`, physical violations `0`.
  - Station invariant total `1`, from `demandWithoutCoverage=1`.
- 30m physical audit:
  - File: `output/review/station-runtime-queue-lease-read-0p5h-audit.json`
  - Total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as the first minimal runtime read cut.
- This is behavior-equivalent at the 30m audit scale and gives later source-of-truth work one runtime station lease query to use.
- It does not solve the underlying inbound PPH imbalance or long-window AMR dropout risk yet.

Next step:

- Move from read-only claim lookup to an explicit station-owned queue slot lease lifecycle:
  - allocate the queue slot lease when the station admits an inbound queue resource,
  - release it on pickup / service transition,
  - keep exact node occupancy separate from station queue slot lease,
  - keep far route and middle/spine planned-route ownership unchanged until station leases prove which station owns the contested segment.

## Rejected Source Cut: Runtime Queue Slot Lease Lifecycle

Date: 2026-06-22

Experiment:

- Added a runtime `stationQueueSlotLeases` map.
- Wrote leases on inbound task assignment and taskless inbound-queue standby dispatch.
- Released leases when inbound pickup started and when taskless routes were cleared.
- Connected station lease ownership into open queue slot count and standby-node availability.

Hypothesis:

- A station-owned queue slot lease lifecycle would prevent duplicate queue-slot ownership before the physical queue becomes visibly blocked, while preserving exact node occupancy as a separate concept.

Validation:

```bash
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "runtime station queue slot lease|reports station-owned shadow contracts|reports duplicate station route leases|allows projected inbound queue vehicles|keeps upstream inbound queue slots available|lets real inbound work override far taskless standby queue claims|holds taskless inbound queue standby vehicles|compresses a taskless inbound queue standby forward|treats same-lift inbound queue vehicles|keeps a later same-lift inbound queue task|uses the next yellow queue slot|uses the tail projected queue slot|does not let a detached storage detour reserve every projected inbound queue slot" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-queue-lease-lifecycle-source-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-queue-lease-lifecycle-source-0p5h-audit.json --checkpoint-dir output/review/station-queue-lease-lifecycle-source-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Targeted tests passed: `15 passed` before the soft-standby adjustment, `14 passed` after narrowing the test pattern.
- 600s diagnosis:
  - File: `output/review/station-queue-lease-lifecycle-source-diagnosis-600s.json`
  - Total PPH `516`, inbound `204`, duplicate route lease `0`, physical violations `0`.
  - Station invariant total `2`, from `demandWithoutCoverage=2`.
- 30m physical audit:
  - File: `output/review/station-queue-lease-lifecycle-source-0p5h-audit.json`
  - Total PPH `490`, inbound `178`, outbound `312`.
  - AMR anomalies `0`, critical anomalies `0`.
- Softening taskless standby leases did not improve the 30m result:
  - File: `output/review/station-queue-lease-lifecycle-soft-standby-0p5h-audit.json`
  - Total PPH `490`, inbound `178`, outbound `312`.

Decision:

- Rejected and reverted as behavior.
- The lifecycle concept is still correct, but this source cut coupled queue leases into open-slot / standby availability too early and throttled inbound replenishment.
- Compared with the accepted read-cut baseline (`508 / 200 / 308` at 30m), this regressed total PPH by `18` and inbound PPH by `22`.

Updated next step:

- Keep the accepted runtime read view.
- Do not let taskless standby leases reduce open queue slot count.
- The next source cut should lease only station-admitted active inbound assignments first, then expose a shadow metric that compares:
  - active assignment lease count,
  - physical queue occupancy,
  - taskless standby soft reserves,
  before any of those counts are allowed to block replenishment.

## Shadow Split: Active Assignment Lease vs Soft Standby Reserve

Date: 2026-06-22

Change:

- Added station-contract shadow fields:
  - `activeAssignmentQueueLeaseCount`
  - `tasklessStandbySoftReserveCount`
  - `physicalQueueSlotLeaseCount`
- These are diagnostic-only and do not change task assignment, routing, collision avoidance, or queue admission.

Reason:

- The rejected runtime lifecycle cut proved that mixing active assignment leases and taskless standby soft reserves into one blocking count throttles inbound replenishment.
- The next source cut needs to see those three quantities separately before any one of them becomes controlling behavior.

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "reports station-owned shadow contracts|reports duplicate station route leases|keeps station shadow contract sampling|allows projected inbound queue vehicles|keeps upstream inbound queue slots available" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-contract-split-lease-metrics-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-contract-split-lease-metrics-0p5h-audit.json --checkpoint-dir output/review/station-contract-split-lease-metrics-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Targeted tests: `5 passed`.
- 600s station diagnosis:
  - File: `output/review/station-contract-split-lease-metrics-diagnosis-600s.json`
  - Total PPH `516`, inbound `210`, duplicate route lease `0`, physical violations `0`.
  - Example final split:
    - `lift-01-inbound`: active assignment queue lease `1`, taskless standby soft reserve `0`, physical queue slot lease `0`.
    - `lift-02-inbound`: active assignment queue lease `2`, taskless standby soft reserve `0`, physical queue slot lease `1`.
- 30m physical audit:
  - File: `output/review/station-contract-split-lease-metrics-0p5h-audit.json`
  - Total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as shadow-only instrumentation.
- This keeps the accepted read-cut behavior unchanged while giving the next source cut a safer metric boundary.

Updated next step:

- Try a source cut that only creates controlling leases for active inbound assignments already admitted to the station queue.
- Keep taskless standby reserves soft until the 30m and then 12h audits show they can safely control only duplicate standby, not inbound replenishment.

Observed split-metric signal:

- In the 600s diagnosis, ready demand was persistently higher than near-station AMR coverage:
  - `lift-01-inbound`: average ready demand `2.426`, average active assignment queue lease `0.754`, average physical queue slot lease `0.213`, average soft standby reserve `0.049`.
  - `lift-02-inbound`: average ready demand `2.541`, average active assignment queue lease `0.656`, average physical queue slot lease `0.180`, average soft standby reserve `0.049`.
- There are repeated samples where ready demand is `3-4` while `nearCoveredDepth=0`, `tasklessStandbySoftReserveCount=0`, and `physicalQueueSlotLeaseCount=0`.
- This supports a different next source cut: station admission should pull a near-field AMR earlier when ready demand is high, rather than making existing standby leases harder.

## Rejected Source Cut: Queue Target Depth 3

Date: 2026-06-22

Experiment:

- Changed `topLiftInboundQueueReplenishTargetDepth()` from `min(2, queueDepth)` to `min(3, queueDepth)`.
- Hypothesis: ready demand often reaches `3-4` while near coverage is `0`, so protecting a third queue slot might pull one more near-field AMR before outbound consumes the fleet.

Diagnostic enhancement:

- Extended `scripts/diagnose-station-queue-contract.ts` so each candidate vehicle records:
  - task id / kind / state,
  - task lift port,
  - whether an inbound busy vehicle contributes queue coverage.
- Baseline 600s busy-task breakdown from `output/review/station-coverage-gap-task-breakdown-600s.json`:
  - outbound busy tasks: `234`
  - inbound busy but not queue-covered: `88`
  - inbound busy and queue-covered: `66`

Validation:

```bash
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-target-depth-3-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-target-depth-3-0p5h-audit.json --checkpoint-dir output/review/station-target-depth-3-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- 600s station diagnosis:
  - total PPH `522`, inbound `180`, duplicate route lease `0`, physical violations `0`.
- 30m physical audit:
  - total PPH `510`, inbound `178`, outbound `332`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Rejected and reverted.
- The higher queue target improved apparent total throughput only by letting outbound dominate; inbound got materially worse versus the accepted 30m baseline (`508 / 200 / 308`).
- The next source cut should not increase reserve target depth globally. It should classify outbound assignment pressure when station ready demand is uncovered, and only defer outbound work when the same vehicle can become near-field inbound coverage without a long detour.

## Rejected Source Cut: Short Outbound Preempt For Uncovered Inbound Queue

Date: 2026-06-22

Experiment:

- Tried a narrow source cut that would release an unloaded outbound task and send that AMR to inbound queue standby when:
  - the AMR was stopped at a legal node,
  - the destination inbound lift had ready demand with zero near covered depth,
  - the released standby route was legal,
  - and the route length was at most `8` nodes.
- Hypothesis: when an inbound lift has uncovered ready demand, a nearby unloaded outbound AMR might be a better station-owned queue resource than letting it continue outbound.

Diagnostic enhancement retained:

- Kept read-only diagnostics in `scripts/diagnose-station-queue-contract.ts`:
  - `releasedStandbyRouteLength`
  - `releasedStandbyRouteEndNodeId`
  - `releasedStandbyRouteEndSlot`
  - `releasedStandbyRouteOriginAllowed`
- `routeToInboundQueueStandby(...)` now accepts a diagnostic-only `allowTaskedVehicle` option so the script can ask "what if this unloaded outbound assignment were released?" without changing normal runtime behavior.

Validation:

```bash
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "reports station-owned shadow contracts|reports duplicate station route leases|keeps station shadow contract sampling|allows projected inbound queue vehicles|keeps upstream inbound queue slots available|lets real inbound work override far taskless standby queue claims|holds taskless inbound queue standby vehicles|compresses a taskless inbound queue standby forward|treats same-lift inbound queue vehicles|keeps a later same-lift inbound queue task|uses the next yellow queue slot|uses the tail projected queue slot|does not let a detached storage detour reserve every projected inbound queue slot|does not let outbound work steal" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/outbound-preempt-short-inbound-coverage-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/outbound-preempt-short-inbound-coverage-0p5h-audit.json --checkpoint-dir output/review/outbound-preempt-short-inbound-coverage-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck: passed.
- Targeted queue contract tests: `14 passed`, `449 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, duplicate route lease `0`, physical violations `0`.
  - Candidate route evidence: `488` candidate records, `17` had a hypothetical released standby route, only `1` was origin-allowed, and `0` were origin-allowed with length `<= 8`.
- 30m physical audit:
  - total PPH `504`, inbound `200`, outbound `304`.
  - AMR anomalies `0`, critical anomalies `0`.
  - Shadow station invariant total `1`; shadow resource ledger watch violations `5`.
- After reverting the runtime preempt cut and keeping only diagnostics:
  - 600s diagnosis `output/review/current-diagnostic-only-station-contract-600s.json`: total PPH `516`, inbound `210`, duplicate route lease `0`, physical violations `0`.
  - 30m audit `output/review/current-diagnostic-only-0p5h-audit.json`: total PPH `508`, inbound `200`, outbound `308`, AMR anomalies `0`, critical anomalies `0`.

Decision:

- Rejected and reverted as runtime behavior.
- It did not improve inbound versus the accepted 30m baseline (`508 / 200 / 308`) and slightly reduced total/outbound.
- The evidence shows this is not a useful local preemption rule: legal near-field outbound-to-inbound opportunities are too rare under the current route-origin rules.
- Next source work should focus on station admission / queue ownership earlier in the lifecycle, not on stealing already-assigned outbound tasks after the fleet is committed.

## Accepted Shadow Refinement: Active Service Scope

Date: 2026-06-22

Problem:

- Station shadow contracts were counting any assigned or in-progress inbound task for the lift as `activeInboundService`.
- That mixed two different states:
  - an AMR still occupying or approaching the inbound queue / pickup point,
  - and an AMR that already picked the load and is delivering it to storage.
- The latter is no longer station service and should not make the station look covered.

Change:

- Demand accounting now keeps task-only station demand only for queued inbound tasks whose source load is not currently represented in the station source buffer.
- `activeInboundService` now requires:
  - inbound task assigned or in-progress for the station,
  - vehicle not loaded,
  - and the vehicle is at, targeting, or planning the station queue/pickup area.
- Added regression coverage: `does not report loaded inbound delivery as station active service`.
- Extended station queue diagnosis summary with:
  - busy task kind counts,
  - busy inbound queue coverage counts,
  - hypothetical released outbound standby route summary,
  - average claimed demand,
  - average active service depth,
  - average active assignment queue lease count,
  - average far forecast depth.

Validation:

```bash
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "reports station-owned shadow contracts|does not report loaded inbound delivery|reports duplicate station route leases|keeps station shadow contract sampling" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-contract-active-service-scope-summary-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-contract-active-service-scope-0p5h-audit.json --checkpoint-dir output/review/station-contract-active-service-scope-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck: passed.
- Targeted tests: `4 passed`, `460 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, duplicate route lease `0`, physical violations `0`.
  - Average ready demand `2.484`.
  - Average claimed demand `0.713`.
  - Average active service depth `0.557`.
  - Average active assignment queue lease count `0.549`.
  - Average far forecast depth `0.279`.
  - Busy task split: inbound `154`, outbound `234`.
  - Busy inbound coverage split: queue-covered `66`, not-queue-covered `88`.
- Before this refinement, the same 600s diagnosis reported average claimed demand `1.262`, average active service depth `1.262`, average active assignment queue lease count `0.705`, and average far forecast depth `0.434`.
- 30m physical audit:
  - total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as shadow-only semantics.
- This does not fix queue coverage by itself, but it makes the station contract truthful: loaded delivery work is no longer reported as inbound station service.
- The next source cut should use this cleaner station signal to decide when the coordinator lacks near-field AMR resources.

## Shadow Station Coordinator Admission Metrics

Date: 2026-06-22

Change:

- Added a shadow-only `coordinator` block to each inbound station contract snapshot.
- The coordinator records:
  - `decision`
  - `targetReserveDepth`
  - `queueCoverageGap`
  - `activeServiceGap`
  - `stationNeedsReservation`
  - `eligibleTasklessVehicleCount`
  - `dispatchableReserveCandidateCount`
  - `candidateReasonCounts`
- Added a diagnostic-only `liftNodeId` option to `routeToInboundQueueStandby(...)` and `topLiftInboundQueueStandbyTargetNodeId(...)` so analysis can ask whether a vehicle can reach a specific station queue. Normal runtime calls do not pass this option.
- Extended `scripts/diagnose-station-queue-contract.ts` with coordinator decision and candidate summaries.

Reason:

- The previous accepted shadow refinement proved that station demand is often uncovered, but it did not explain whether the missing replenishment was caused by lack of ready demand, lack of candidate AMRs, route infeasibility, hold timers, or busy fleet allocation.
- This is still shadow mode: it does not change task assignment, routing, collision avoidance, queue admission, or vehicle movement.

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|does not report loaded inbound delivery|reports duplicate station route leases|keeps station shadow contract sampling" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-shadow-coordinator-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-shadow-coordinator-0p5h-audit.json --checkpoint-dir output/review/station-shadow-coordinator-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck passed for schemas and sim-core.
- Targeted station tests passed: `4 passed`, `460 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - average coordinator queue coverage gap `1.328`.
  - average coordinator active service gap `1.959`.
  - average dispatchable reserve candidate count `0`.
  - coordinator decisions: `wait-for-reserve-candidate=102`, `hold-active-service=18`, `no-ready-demand=2`.
  - coordinator candidate reasons: `busy-task=651`, `busy-moving=117`, `no-station-route=27`, `assignment-hold=12`, `inbound-dropoff-standby-hold=8`, `no-open-station-target=1`.
- 30m physical audit:
  - total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.
  - physical violations `0`.

Decision:

- Accepted as shadow-only coordinator instrumentation.
- It is behavior-equivalent to the accepted 30m baseline while making the station-owned admission gap explicit.
- The important finding is that uncovered ready station demand is not currently waiting on a large pool of ignored idle AMRs. During uncovered samples the coordinator sees no dispatchable station-specific reserve candidate; the fleet is mostly busy or moving, with a smaller amount of route infeasibility / hold time.

Updated next step:

- Do not add another local queue hard guard.
- The next source cut should move matching ownership earlier:
  - keep `InboundDemand` separate from concrete task binding,
  - let the coordinator atomically convert the head station reservation plus ready demand into `activeInboundService`,
  - and only then experiment with bounded outbound throttling or near/far reservation policy.

## Rejected Source Cut: Reservation Before Service Binding Without Demand Ledger

Date: 2026-06-22

Experiment:

- Tried to keep vehicles moving to inbound queue as taskless `queueReservation` instead of binding the queued inbound task while the AMR was still remote.
- Added a service transition attempt at the physical queue slot so a parked queue reservation could bind a queued inbound demand only after reaching the station.

Hypothesis:

- This would align with the station coordinator model by avoiding premature `activeInboundService` for remote vehicles.

Validation:

```bash
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-reservation-before-service-source-diagnosis-600s.json
```

Results:

- 600s diagnosis:
  - total PPH dropped from the accepted shadow-coordinator baseline `516` to `450`.
  - inbound PPH dropped from `210` to `126`.
  - average near covered depth dropped from `0.598` to `0.246`.
  - average ready demand rose from `2.484` to `3.016`.
  - average active service depth dropped from `0.557` to `0.189`.
  - station invariant total worsened from `1` to `2`.

Decision:

- Rejected and reverted.
- This reproduces the Pro review warning: delaying concrete task binding without a separate authoritative `InboundDemand` / source-lift pipeline starves the lift service path.
- The source cut cannot be just "make queue routes taskless." It must first introduce a real demand ledger that can keep the lift/source pipeline alive while separating AMR reservation from concrete task binding.

Updated next step:

- Add a shadow `InboundDemand` ledger that is not merely inferred from task binding.
- Prove the demand ledger can explain waiting source loads, queued tasks, claimed loads, and completed loads without changing behavior.
- Only after that, retry the reservation-to-service source transition.

## Shadow InboundDemand Ledger

Date: 2026-06-22

Change:

- Added a shadow-only `inboundDemandLedger` block under `traffic.shadowLedger.stationContracts`.
- Added ledger entries for station/source-side inbound demand with:
  - `announced`: source load exists but is not yet at the front pickup position,
  - `ready`: source load or queued inbound task is ready for station service,
  - `claimed`: a vehicle/task has claimed the source-side demand but has not picked it yet,
  - `completed`: the station/source-side demand has been picked up, even if the full inbound storage delivery task is still in progress.
- Rewired station contract `demands` to be derived from this ledger instead of locally rebuilding source-load and task demand inside every station snapshot.
- Extended `scripts/diagnose-station-queue-contract.ts` with final and average inbound ledger counts.

Reason:

- The rejected source cut showed that keeping AMRs taskless until arrival starves the lift unless there is a separate authoritative source-side demand pipeline.
- This is the shadow proof for that pipeline. It separates "lift/source demand still needs pickup" from "loaded inbound delivery is still driving to storage."
- This remains diagnostic-only: it does not change task assignment, queue admission, routing, collision avoidance, vehicle motion, or source buffer replenishment.

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|does not report loaded inbound delivery|reports duplicate station route leases|keeps station shadow contract sampling" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-shadow-inbound-demand-ledger-diagnosis-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-shadow-inbound-demand-ledger-0p5h-audit.json --checkpoint-dir output/review/station-shadow-inbound-demand-ledger-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck passed for schemas and sim-core.
- Targeted station tests passed: `4 passed`, `460 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - station invariant total `1`, same as the accepted shadow-coordinator baseline.
  - final inbound ledger counts: `ready=5`, `claimed=3`, `completed=0`.
  - average inbound ledger counts: entry `8.967`, ready `4.967`, claimed `1.426`, completed `1.098`.
  - coordinator decisions remained `wait-for-reserve-candidate=102`, `hold-active-service=18`, `no-ready-demand=2`.
- 30m physical audit:
  - total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as shadow-only demand ledger instrumentation.
- The 600s and 30m behavior stays equivalent to the accepted baseline, while the state now exposes which inbound source demands are ready, claimed, or already picked.
- This proves the diagnostic model can represent station/source demand independently from loaded delivery WIP.

Updated next step:

- Retry the reservation-to-service source transition using this ledger as the source of truth in shadow comparison first.
- The coordinator should convert only a head station reservation plus a ready/claimed ledger demand into `activeInboundService`.
- Do not change 3D motion behavior until the shadow comparison shows which current implicit decision would change and why.

## Shadow Source Transition Preview

Date: 2026-06-22

Change:

- Added a shadow-only `serviceTransition` block to each inbound station contract snapshot.
- The preview records:
  - physical head taskless queue reservation,
  - head ready/claimed source-side demand,
  - current active inbound service vehicle/task,
  - whether a source transition could start immediately,
  - and a `gap` classification.
- Extended `scripts/diagnose-station-queue-contract.ts` with service transition gap counts and average ready-to-start count.

Reason:

- The previous step proved the source-side demand ledger can distinguish waiting, claimed, and picked demand without changing behavior.
- Before retrying any source cut, this preview asks a narrower question: do we actually have a taskless AMR physically at the station queue head while ready/claimed source demand is waiting?
- This stays shadow-only and does not bind tasks, move vehicles, reserve paths, or change collision avoidance.

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|previews unbound head reservation|does not report loaded inbound delivery|reports duplicate station route leases|keeps station shadow contract sampling" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-shadow-source-transition-preview-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-shadow-source-transition-preview-0p5h-audit.json --checkpoint-dir output/review/station-shadow-source-transition-preview-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck passed for schemas and sim-core.
- Targeted station tests passed: `5 passed`, `460 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - station invariant total `1`, same as the accepted baseline.
  - service transition gap counts: `none=57`, `waiting-for-head-reservation=63`, `waiting-for-demand=2`.
  - `ready-reservation-not-bound=0`.
  - average ready-to-start service count `0`.
- 30m physical audit:
  - total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as shadow-only source transition preview.
- This disproves the next naive fix: in the observed 600s window, the system is not usually sitting with a taskless AMR at the physical station head waiting to be bound.
- The dominant gap is upstream: ready source demand often exists while no physical head reservation exists.

Updated next step:

- Focus the next source cut on head-reservation supply, not task binding at the station.
- Add a shadow audit for why ready demand lacks a physical head reservation:
  - no reserve candidate,
  - reserve candidate moving but not yet at head,
  - route infeasible to station queue,
  - candidate blocked by outbound work,
  - hold timers / assignment holds.
- Only after this audit identifies a bounded source should we change queue-reserve dispatch behavior.

## Shadow Head Reservation Supply Audit

Date: 2026-06-22

Change:

- Added a shadow-only `headReservationSupply` block to each inbound station contract snapshot.
- The audit records:
  - physical head taskless queue reservation,
  - physical / approaching / forecast reservation counts,
  - ready and claimed source-side demand,
  - dispatchable reserve candidate count,
  - dominant candidate reason,
  - raw candidate reason counts,
  - and grouped candidate buckets: `dispatchable`, `busy`, `routeInfeasible`, `held`, `noTarget`, `unavailable`.
- Extended `scripts/diagnose-station-queue-contract.ts` with head-reservation supply gap counts and bucket counts.

Reason:

- The source transition preview showed `ready-reservation-not-bound=0`, so binding a task at the station head is not the observed missing step.
- This audit asks the upstream question: when source-side demand is ready/claimed, why is there no physical head reservation?
- It remains shadow-only and does not change queue dispatch, task assignment, routing, collision avoidance, or vehicle motion.

Validation:

```bash
pnpm --filter @four-way-shuttle/schemas exec tsc --noEmit
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
pnpm exec vitest run packages/shuttle-sim-core/src/index.test.ts -t "station-owned shadow contracts|previews unbound head reservation|classifies missing physical head reservation|does not report loaded inbound delivery|reports duplicate station route leases|keeps station shadow contract sampling" --reporter=dot
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-shadow-head-reservation-supply-audit-600s.json
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts --hours 0.5 --out output/review/station-shadow-head-reservation-supply-audit-0p5h.json --checkpoint-dir output/review/station-shadow-head-reservation-supply-audit-0p5h-checkpoints --audit-every-sec 30 --quiet-critical
```

Results:

- Typecheck passed for schemas and sim-core.
- Targeted station tests passed: `6 passed`, `460 skipped`.
- 600s station diagnosis:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - station invariant total `1`, same as accepted baseline.
  - head reservation supply gaps: `fleet-busy=63`, `active-service-present=57`, `no-ready-demand=2`.
  - average physical head reservation count `0.016`.
  - average physical reservation count `0.049`.
  - average approaching reservation count `0`.
  - average forecast reservation count `0`.
  - candidate buckets: `busy=904`, `routeInfeasible=30`, `held=22`, `noTarget=4`, `dispatchable=0`.
  - raw coordinator candidate reasons: `busy-task=776`, `busy-moving=128`, `no-station-route=30`, `assignment-hold=14`, `inbound-dropoff-standby-hold=8`, `no-open-station-target=4`.
- 30m physical audit:
  - total PPH `508`, inbound `200`, outbound `308`.
  - AMR anomalies `0`, critical anomalies `0`.

Decision:

- Accepted as shadow-only head-reservation supply instrumentation.
- The observed missing step is not an unbound physical queue head and not an immediately dispatchable idle AMR.
- The dominant explanation is that, when station demand is ready, the fleet is already busy or moving; route infeasibility and holds are secondary.

Updated next step:

- Do not patch station binding yet.
- Compare candidate busy tasks by kind and queue coverage, then design a bounded source-of-truth change:
  - protect at least one near-field taskless reserve before assigning lower-priority outbound work,
  - or let the station coordinator preempt/release selected empty outbound assignments only when it can produce a short, valid inbound reserve route.
- Any source cut must be A/B checked against this baseline before running longer 3D tests.

## Station-Specific Outbound Release Opportunity Audit

Date: 2026-06-22

Change:

- Extended `scripts/diagnose-station-queue-contract.ts` with `releaseOpportunities`.
- For every station sample with `headReservationSupply.gap=fleet-busy` or `serviceTransition.gap=waiting-for-head-reservation`, the script now checks:
  - how many AMRs are assigned to empty outbound work,
  - how many of those outbound-assigned AMRs are stationary,
  - whether releasing any of them would produce a station-specific inbound queue standby route,
  - whether that route is origin-allowed,
  - and whether any such route is short (`<=8` nodes).
- This remains script-only diagnostics. It does not affect `getState()`, UI playback, 3D tick speed, task assignment, or routing.

Validation:

```bash
pnpm --filter @four-way-shuttle/sim-core exec tsc --noEmit
./node_modules/.bin/tsx scripts/diagnose-station-queue-contract.ts --duration-sec 600 --sample-sec 10 --dt-sec 0.2 --out output/review/station-shadow-outbound-release-opportunity-600s.json
```

Results:

- Typecheck passed for sim-core.
- 600s station diagnosis stayed behavior-equivalent:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - station invariant total `1`.
- Station-specific release opportunity:
  - `totalStationGaps=63`.
  - `withStationSpecificReleaseRoute=0`.
  - `withShortStationSpecificReleaseRouteLe8=0`.
  - `shortestReleasedOriginAllowedLength=null`.
  - average empty outbound assignments during those gaps `1.937`.
  - average stationary empty outbound assignments during those gaps `0.270`.
- The global non-station-specific diagnostic still found only `1` origin-allowed release route, and no short route (`originAllowedLengthLe8=0`).

Rejected experiment:

- Tried a local, uncommitted outbound assignment hold source cut:
  - if an idle top-lane AMR was about to receive outbound work while an inbound station had ready/claimed demand and no physical head reservation, defer that outbound assignment.
- 600s diagnosis was identical to baseline:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - head-reservation gap distribution unchanged.
- The source cut was removed before commit because it did not reach the actual bottleneck.

Decision:

- Do not implement outbound preemption/release yet.
- The evidence says empty outbound AMRs are often not stationary, and when stationary they do not have a station-specific valid route to the missing inbound head reservation.
- Forcing preemption here would likely create exactly the kind of visible route churn and unsafe cross-flow behavior we are trying to eliminate.

Updated next step:

- The next source-of-truth cut should not be "steal an outbound AMR now."
- Focus instead on assignment admission before AMRs become committed:
  - measure when outbound assignments were created relative to inbound demand becoming ready,
  - add a shadow "would reserve instead of assigning outbound" decision at assignment time,
  - then A/B test a bounded admission rule only where the shadow decision actually fires.

## Assignment Admission Timing Audit

Date: 2026-06-22

Change:

- Added `scripts/diagnose-assignment-admission.ts`.
- The script advances the physical 3D tick simulation at `dt=0.2s`, watches `task-assigned` events, and records the pre-step station contract state for every assignment.
- For every assignment it captures:
  - task kind,
  - route length and level pattern,
  - pre-assignment ready/claimed station demand,
  - physical head reservation count,
  - head-reservation gap count,
  - affected station ids,
  - and whether an outbound assignment happened while a station already needed physical head reserve.
- This is script-only diagnostics. It does not change runtime behavior or UI performance.

Validation:

```bash
./node_modules/.bin/tsx scripts/diagnose-assignment-admission.ts --duration-sec 600 --dt-sec 0.2 --out output/review/assignment-admission-shadow-600s.json
```

Results:

- 600s assignment admission diagnosis:
  - total assignments `96`.
  - inbound assignments `38`.
  - outbound assignments `58`.
  - outbound assignments while a station had a head-reservation gap `34`.
  - outbound assignments while a station had a fleet-busy head-reservation gap `34`.
  - outbound-while-gap share `58.62%`.
  - average pre-assignment ready demand for outbound assignments `5.034`.
  - average pre-assignment head gap count for outbound assignments `0.828`.
  - affected stations: `lift-02-inbound=29`, `lift-01-inbound=19`.
  - final 600s behavior stayed at total PPH `516`, inbound `210`, physical violations `0`.

Rejected experiment:

- Tried a local, uncommitted source cut in the main assignment loop:
  - after selecting an outbound assignment candidate, if that same candidate could immediately take a legal inbound queue reserve route for a station needing physical head reserve, send it to reserve instead of assigning outbound.
- 600s station diagnosis and assignment diagnosis were identical to baseline:
  - total PPH `516`, inbound `210`, physical violations `0`.
  - outbound assignments while head gap stayed `34`.
  - head-reservation gap distribution stayed unchanged.
- The source cut was removed before commit.

Decision:

- Assignment timing is a real problem: many outbound assignments happen while inbound stations already need physical head reserve.
- But the first bounded admission cut did not fire because those outbound candidates are generally in bottom/storage flows, not in a location with a valid immediate inbound reserve route.
- Do not add a no-op source rule.

Updated next step:

- Move the admission decision earlier, before selecting the outbound task/candidate pair:
  - compare available vehicles against inbound reserve routes before considering outbound work,
  - classify available vehicles by top-lane reserve eligibility versus lower-level outbound suitability,
  - then reserve only vehicles that have a valid short inbound queue route and would otherwise be consumed by outbound work.
- The next source cut should operate on the available vehicle pool, not after outbound assignment selection.
