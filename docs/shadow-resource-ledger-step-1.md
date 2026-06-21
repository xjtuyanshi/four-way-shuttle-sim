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
