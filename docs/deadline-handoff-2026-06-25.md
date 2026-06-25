# 2026-06-25 Deadline Handoff

Local deadline set by the user: **2026-06-25 12:30 PDT**.

If the 3D tick simulator is not fully fixed and verified by that time, stop feature/debug work and commit the best usable repo state, this handoff, all known issues, validation outputs, and next-step recommendations to GitHub.

## Repo State At Handoff Start

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Remote tracking branch: `origin/codex/traffic-v2-flow-debug`
- Current HEAD before the current uncommitted fix batch: `8a86470 checkpoint: document shuttle traffic v2 diagnostics`
- This file was started at local time: `2026-06-25 00:16 PDT`

Known dirty tracked files at this checkpoint:

- `docs/chatgpt-pro-review-handoff-2026-06-24-round14.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round14.md`
- `packages/shuttle-schemas/src/index.ts`
- `packages/shuttle-sim-core/src/index.test.ts`
- `packages/shuttle-sim-core/src/index.ts`
- `scripts/run-physical-24h-amr-audit.ts`

Known untracked local handoff/evidence files:

- `docs/chatgpt-pro-review-handoff-2026-06-24-round7.md`
- `docs/chatgpt-pro-review-handoff-2026-06-24-round8.md`
- `docs/chatgpt-pro-review-handoff-2026-06-24-round9.md`
- `docs/chatgpt-pro-review-handoff-2026-06-24-round10.md`
- `docs/chatgpt-pro-review-handoff-2026-06-24-round12.md`
- `docs/chatgpt-pro-review-handoff-2026-06-24-round13.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round7.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round8.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round9.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round10.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round11.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round12.md`
- `docs/chatgpt-pro-review-response-2026-06-24-round13.md`
- `scripts/diagnose-reciprocal-storage-swap.ts`

Do not assume every dirty file is final or verified. Some are accumulated WIP from repeated diagnostics and ChatGPT Pro review rounds.

## User Goal

The user needs the existing high-fidelity physical/3D tick shuttle simulator to become stable, believable, and explainable for customer review.

The user does **not** want a pure DES rewrite as the final answer. A DES-style resource contract can be used as the organizing principle, but the final model must still support the 3D tick behavior and visual review.

The required evidence style is:

- every run logged in the rolling log
- why the run was repeated
- what changed
- elapsed simulation time
- hourly inbound/outbound/total PPH
- every-10-minute per-AMR task counts
- stuck / small-loop / long-wait metrics
- physical collision and minimum separation
- known failures and next decision

Rolling log outputs:

- `output/review/sim-run-rolling-log.json`
- `output/review/sim-run-rolling-log.html`

## What Is Actually Working Right Now

The latest completed 2h gate before this handoff:

- File: `output/review/physical-2h-after-audit-classification-v2.json`
- Checkpoints: `output/review/physical-2h-after-audit-classification-v2-checkpoints/`
- Final simulated time: `7200s`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `241.5`
- Outbound PPH: `205.5`
- Total PPH: `447`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `5.000544m`
- AMR anomalies: `2`
- Critical AMR anomalies: `0`

Hourly PPH from that run:

| Hour | Inbound | Outbound | Total | Waiting | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: |
| H1 | 262 | 199 | 461 | 0 | 0 |
| H2 | 221 | 212 | 433 | 1 | 1 |

The two anomalies in the 2h gate were not dead AMRs:

- `SH-02` at `5400s`: `long-wait-with-progress-window`, completed `6` tasks in that 10-minute window.
- `SH-04` at `6600s`: `long-wait-with-progress-window`, completed `5` tasks in that 10-minute window.

This matters because previous audit wording made productive long-wait windows look like AMR dropouts. The audit was changed to distinguish:

- `long-wait-no-task-window`: true risk, long blocked window with zero task completions.
- `long-wait-with-progress-window`: watch item, long blocked window but still productive.

## What Is Still Not Solved

The current blocker is not visible physical collision in the latest 2h gate. The latest 2h gate had `physicalViolations = 0`.

The remaining blocker is resource-contract ambiguity:

- shadow ledger sampled `1440` times in the 2h gate
- samples with violations: `112`
- top sampled violation codes:
  - `orphaned-yield-hold`: `107`
  - `planned-route-overlap`: `15`
  - `intent-without-route-or-hold`: `3`
  - `lift-fifo-inversion`: `2`

Interpretation:

- Vehicles often wait under `local-yield-hold`.
- The simulator state has a timed yield hold (`yieldHoldUntilSec`) and a wait reason, but the shadow resource ledger did not previously express that hold as an explicit resource lease.
- That makes the system hard to audit: the vehicle is waiting for a reason, but the resource model cannot prove who owns what and why the wait should eventually release.
- This is why repeated local patches feel like an endless loop: each symptom is fixed, but hidden waits and hidden ownership keep reappearing in long runs.

## Current WIP Direction

Current intended fix:

- represent valid timed `local-yield-hold` as an explicit `yield-hold` resource lease in the shadow ledger
- keep this diagnostic first; do not make it a broad behavior-changing movement rule until a short gate proves the ledger improves without creating duplicate owners

Current code WIP in `packages/shuttle-sim-core/src/index.ts`:

- `ShadowResourceLease.kind` now includes `yield-hold`
- active timed yield holds can add a `yield-hold` lease for the held node

This is not yet fully verified at the time this document was started.

Required validation before treating this WIP as useful:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "yield holds|shadow resource ledger|stale local-route|blocked waiters" --maxWorkers=1
pnpm -r --if-present typecheck
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 1800 \
  --out output/review/physical-30m-after-yield-hold-lease.json \
  --checkpoint-dir output/review/physical-30m-after-yield-hold-lease-checkpoints \
  --change-note yield-hold-shadow-lease-30m-gate \
  --why-rerun "2h audit-classification-v2 completed with no physical violations or critical anomalies, but shadow ledger reported orphaned-yield-hold in 107 samples; this gate checks whether timed local-yield-hold is now represented as an explicit yield-hold lease." \
  --problems-found "Valid local-yield-hold had a wait reason and timer but no explicit shadow resource lease, creating orphaned-yield-hold audit noise." \
  --solutions-applied "Add yield-hold lease expression for active timed yield holds in shadow resource ledger." \
  --baseline output/review/physical-2h-after-audit-classification-v2.json \
  --stop-on-critical
```

Pass expectation for the 30m gate:

- `orphaned-yield-hold` should drop materially, ideally to `0`.
- `duplicate-resource-owner` must not spike as a side effect.
- physical violations remain `0`.
- critical anomalies remain `0`.
- PPH should remain in the same range as the current 2h/3h gates.

### 30m Gate Result

Run completed at local time `2026-06-25 00:30 PDT`.

- File: `output/review/physical-30m-after-yield-hold-lease.json`
- Checkpoints: `output/review/physical-30m-after-yield-hold-lease-checkpoints/`
- Final simulated time: `1800s`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `290`
- Outbound PPH: `178`
- Total PPH: `468`
- AMR anomalies: `0`
- Critical AMR anomalies: `0`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `4.45m`

Shadow ledger result:

- Samples: `360`
- Samples with violations: `5`
- `orphaned-yield-hold`: `0`
- `duplicate-resource-owner`: `0`
- Remaining top violation: `planned-route-overlap` with `5` samples
- Max invariant total: `1`

Interpretation:

- The narrow `yield-hold` lease expression worked in the 30m gate.
- It did not introduce duplicate hard owners.
- This does not prove 24h stability. It only proves the previous `orphaned-yield-hold` audit gap is closed over 30m.
- Next gate should be 2h with the same baseline comparison before any further behavior changes.

### 2h Gate Result

Run completed at local time `2026-06-25 00:43 PDT`.

- File: `output/review/physical-2h-after-yield-hold-lease.json`
- Checkpoints: `output/review/physical-2h-after-yield-hold-lease-checkpoints/`
- Final simulated time: `7200s`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `241.5`
- Outbound PPH: `205.5`
- Total PPH: `447`
- AMR anomalies: `2`
- Critical AMR anomalies: `0`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `5.000544m`

Hourly PPH:

| Hour | Inbound | Outbound | Total | Waiting | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: |
| H1 | 262 | 199 | 461 | 0 | 0 |
| H2 | 221 | 212 | 433 | 1 | 1 |

Shadow ledger comparison against `output/review/physical-2h-after-audit-classification-v2.json`:

| Metric | Baseline | After yield-hold lease |
| --- | ---: | ---: |
| Samples | 1440 | 1440 |
| Samples with violations | 112 | 20 |
| `orphaned-yield-hold` samples | 107 | 0 |
| `planned-route-overlap` samples | 15 | 15 |
| `intent-without-route-or-hold` samples | 3 | 3 |
| `lift-fifo-inversion` samples | 2 | 2 |
| Max duplicate owner | 0 | 0 |
| Max orphaned yield hold | 2 | 0 |
| Max total invariant count | 2 | 1 |

AMR watch windows remained identical in character:

- `SH-02` at `5400s`: `long-wait-with-progress-window`, completed `6` tasks, blocked `305s`.
- `SH-04` at `6600s`: `long-wait-with-progress-window`, completed `5` tasks, blocked `340s`.

Interpretation:

- The `yield-hold` lease fix is useful and verified through 2h.
- It is a diagnostic/resource-contract cleanup, not a throughput improvement.
- It does not solve the remaining long-wait inefficiency.
- The next unresolved resource-contract issues are `planned-route-overlap`, `intent-without-route-or-hold`, and `lift-fifo-inversion`.
- Before changing behavior again, run a longer validation or inspect the remaining 20 shadow samples to decide whether they are transient benign overlap or the next cause of later-hour degradation.

### 2h Planned-Route Intent Gate Result

Run completed at local time `2026-06-25 00:53 PDT`.

- File: `output/review/physical-2h-after-shadow-planned-route-intent.json`
- Checkpoints: `output/review/physical-2h-after-shadow-planned-route-intent-checkpoints/`
- Final simulated time: `7200s`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `241.5`
- Outbound PPH: `205.5`
- Total PPH: `447`
- AMR anomalies: `2`
- Critical AMR anomalies: `0`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `5.000544m`

Change tested:

- Shadow vehicle intent now falls back to a valid adjacent `plannedRouteNodeIds` route when the active `routeNodeIds` tail is temporarily not runnable.
- This addresses assignment handoff gaps where a loaded task is already in progress, `plannedRouteNodeIds` has a legal dropoff route, but `targetNodeId` is temporarily `null`.

Shadow ledger result:

| Metric | After yield-hold lease | After planned-route intent |
| --- | ---: | ---: |
| Samples | 1440 | 1440 |
| Samples with violations | 20 | 17 |
| `orphaned-yield-hold` samples | 0 | 0 |
| `intent-without-route-or-hold` samples | 3 | 0 |
| `planned-route-overlap` samples | 15 | 15 |
| `lift-fifo-inversion` samples | 2 | 2 |
| Max duplicate owner | 0 | 0 |
| Max total invariant count | 1 | 1 |

Interpretation:

- The planned-route shadow intent change is a diagnostic fix, not a movement behavior change.
- It removed the false/transition-state `intent-without-route-or-hold` warnings without changing PPH or AMR anomaly count.
- Remaining 2h shadow warnings are now only:
  - `planned-route-overlap`: `15` samples
  - `lift-fifo-inversion`: `2` samples
- The two AMR watch windows remain `long-wait-with-progress-window`, so the long-wait inefficiency is still not solved.

### 6h Gate Result

Run completed at local time `2026-06-25 01:39 PDT`.

- File: `output/review/physical-6h-after-shadow-intent-cleanup.json`
- Checkpoints: `output/review/physical-6h-after-shadow-intent-cleanup-checkpoints/`
- Final simulated time: `21600s`
- Wall clock: `2415033ms`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `224.333`
- Outbound PPH: `217`
- Total PPH: `441.333`
- AMR anomalies: `3`
- Critical AMR anomalies: `0`
- Physical violations: `0`
- Deadlocks: `1`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `2.677679m`

Hourly PPH:

| Hour | Inbound | Outbound | Total | Waiting | Blocked | Shadow Violations | Deadlocks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| H1 | 262 | 199 | 461 | 0 | 0 | 0 | 0 |
| H2 | 221 | 212 | 433 | 1 | 1 | 0 | 0 |
| H3 | 211 | 213 | 424 | 1 | 1 | 1 | 0 |
| H4 | 204 | 225 | 429 | 3 | 3 | 0 | 1 |
| H5 | 233 | 220 | 453 | 1 | 1 | 0 | 1 |
| H6 | 215 | 233 | 448 | 1 | 1 | 0 | 1 |

6h shadow ledger:

- Samples: `4320`
- Samples with violations: `45`
- `orphaned-yield-hold`: `0`
- `blocked-waiter-future-claim`: `0`
- `stale-local-route-claim`: `0`
- `duplicate-resource-owner`: `0`
- `planned-route-overlap`: `34`
- `lift-fifo-inversion`: `10`
- `intent-without-route-or-hold`: `3`

6h anomalies:

- `SH-02` at `5400s`: `long-wait-with-progress-window`, completed `6` tasks, blocked `305s`.
- `SH-04` at `6600s`: `long-wait-with-progress-window`, completed `5` tasks, blocked `340s`.
- `11185s`: `deadlock-count-increased`, `SH-02` and `SH-08`.

Deadlock watch detail:

- Checkpoint: `output/review/physical-6h-after-shadow-intent-cleanup-checkpoints/0018-11185s.json`
- `SH-02`: loaded, at `column-middle-c02`, target `column-middle-c01`, wait `node-occupied`, blocker `SH-08`.
- `SH-08`: empty, at `column-middle-c01`, target `column-middle-c02`, wait `node-occupied`, blocker `SH-02`.
- This is a real adjacent node swap conflict, not a shadow-ledger false positive.
- It recovered later, so the run completed and did not become critical.

6h interpretation:

- Current version is more diagnosable and no longer dominated by `orphaned-yield-hold`.
- It can run 6h with no physical collisions and no critical AMR anomaly.
- It is still not fully solved:
  - PPH drops from H1 `461` to H3/H4 `424/429`, then partially recovers.
  - At least one real adjacent-swap deadlock is still counted.
  - Later-hour `intent-without-route-or-hold` still appears for outbound tasks around `column-bottom-b-c08`, so the earlier planned-route handoff fix does not cover every route gap.
  - Long-wait-with-progress windows remain.
  - 24h stability is not proven.

### C01/C02 Adjacent Faceoff Recovery WIP

Started after the 6h gate above. The next concrete failure to isolate was the
counted deadlock around `11185s` in
`output/review/physical-6h-after-shadow-intent-cleanup.json`.

Root failure pattern:

- `SH-02`: loaded inbound, at `column-middle-c02`, wants `column-middle-c01`.
- `SH-08`: empty outbound, at `column-middle-c01`, wants `column-middle-c02`.
- Both are in the yellow-line middle aisle and block each other as an adjacent node swap.
- A third vehicle (`SH-05`) can clear the escape side, but the deadlock detector counted the pair before the active conflict arbitration had timed out.

Code changes currently uncommitted:

- `packages/shuttle-sim-core/src/index.ts`
  - Added loaded-inbound vs empty-adjacent faceoff handling in top-lift swap recovery.
  - If the empty vehicle has no legal side escape, the loaded inbound first tries to retarget to another reachable inbound dropoff.
  - If retargeting is not possible, the code proactively clears an unloaded third-party blocker from the loaded inbound escape side.
  - `deadlockCandidateHasActiveRecovery` now treats an unexpired candidate-pair conflict session as active recovery, instead of confirming a deadlock while arbitration is still inside its timeout window.
  - It still allows later deadlock confirmation once the conflict session times out and the same cycle persists.
- `packages/shuttle-sim-core/src/index.test.ts`
  - Added focused regression coverage for loaded-inbound retarget, third-party middle-aisle yielder recognition, unexpired pair conflict sessions, and proactive escape-blocker clearance.

Focused verification already passed:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "(deadlock recovery|third-party middle-aisle yielder|third-party escape blocker|pair conflict session has not timed out)" \
  --maxWorkers=1

pnpm -r --if-present typecheck
```

Intermediate runs that did **not** solve the 6h failure:

| Run | Duration | Result |
| --- | ---: | --- |
| `output/review/physical-6h-after-c01-deadlock-retarget.json` | 21600s | Completed, PPH `441.333`, physical violations `0`, but deadlocks still `1`. |
| `output/review/physical-12000s-after-third-party-active-recovery.json` | 12000s | Completed, PPH `436.5`, critical anomalies `0`, but deadlocks still `1`. |
| `output/review/physical-12000s-after-proactive-c01-escape-clearance.json` | 12000s | Completed, PPH `435.9`, critical anomalies `0`, but deadlocks still `1`. |

Latest target gate after adding the conflict-session recovery window:

- File: `output/review/physical-12000s-after-conflict-session-recovery-window.json`
- Checkpoints: `output/review/physical-12000s-after-conflict-session-recovery-window-checkpoints/`
- Final simulated time: `12000s`
- Run status: `completed`
- Stop reason: `reached-duration`
- Inbound PPH: `228.3`
- Outbound PPH: `207.6`
- Total PPH: `435.9`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `0`
- Minimum vehicle separation: `1.325473m`
- AMR anomalies: `2`
- Critical AMR anomalies: `0`
- Shadow samples: `2400`
- Shadow samples with violations: `27`
- Remaining shadow top violations:
  - `planned-route-overlap`: `21`
  - `lift-fifo-inversion`: `5`
  - `intent-without-route-or-hold`: `1`

Interpretation:

- This is the first target gate where the known `11185s` c01/c02 faceoff is not counted as a confirmed deadlock.
- The fix appears to correct a too-early deadlock classification, not magically remove every inefficiency.
- This is still **not** enough to call the simulator solved. It only proves the targeted 12000s window.
- Next gate must be a 6h run with the same stop conditions. If that passes, run the 24h audit. If either fails, document the exact failing window and do not hide it.

### 6h Gate After Conflict-Session Recovery Window

Run started after the 12000s target gate above.

- File: `output/review/physical-6h-after-conflict-session-recovery-window.json`
- Checkpoints: `output/review/physical-6h-after-conflict-session-recovery-window-checkpoints/`
- Intended duration: `21600s`
- Actual final simulated time: `16200s`
- Run status: `stopped-critical`
- Stop reason: `critical-evidence`
- Inbound PPH at stop: `218.222`
- Outbound PPH at stop: `204.667`
- Total PPH at stop: `422.889`
- Physical violations: `0`
- Deadlocks: `0`
- Livelocks: `0`
- Station contract critical violations: `2`
- AMR anomalies: `15`
- Critical AMR anomalies: `9`

What improved:

- The previous `11185s` c01/c02 adjacent faceoff did not recur as a confirmed deadlock.
- The run passed that known failure window and reached `16200s`.

What failed:

- At `16200s`, several AMRs were stationary for a full 10-minute window with zero completed tasks.
- Critical vehicles:
  - `SH-01`: `column-bottom-a-c21`, waits `node-occupied`, blocker `SH-05`.
  - `SH-02`: `column-bottom-b-c19`, waits `outbound-station-await-transition`.
  - `SH-05`: `module-02-spine-bottom-a`, state `loaded-moving`, target `column-bottom-a-c22`, but `currentEdgeId=null`, `legRemainingM=0`, `waitReason=null`, and zero movement.
  - `SH-07`: `column-bottom-b-c21`, waits `node-occupied`, blocker `SH-08`.
  - `SH-08`: `module-02-spine-bottom-b`, waits `node-occupied`, blocker `SH-05`.
- `lift-02-outbound` had critical station contract violations:
  - `station-exclusive-lease-has-foreign-occupant`: active pass for `SH-07` includes `module-02-spine-bottom-b`, occupied by `SH-08`.
  - `station-lease-progress-timeout`: active pass for `SH-07` exceeded `expectedCompleteBySec=15122.8`.

Interpretation:

- The c01/c02 deadlock classifier/recovery fix helped one specific failure class.
- The deeper unresolved issue is the station/throat ownership contract around `lift-02-outbound` and `lift-02-inbound`.
- A vehicle can end up visually/physically stationary with `state=loaded-moving` and no wait reason. That is a state-machine classification bug and makes downstream blockers hard to clear.
- The next fix should focus on outbound station pass ownership, active/requested visit ordering, and bottom throat drain/clearance progress, not on general pathfinding.

### Failed Attempt Reverted: Fully Authoritative Outbound Station Goal

Tried change:

- For loaded outbound tasks controlled by an outbound station, make `outboundStationAuthoritativeGoalNodeId()` the only source of truth.
- If the station coordinator returned `null`, the vehicle would hold at `outbound-station-await-transition` instead of falling back to ordinary dropoff routing.

Validation:

- File: `output/review/physical-16500s-after-station-controlled-outbound-goal.json`
- Intended duration: `16500s`
- Actual final simulated time: `3000s`
- Run status: `stopped-critical`
- Inbound PPH at stop: `192`
- Outbound PPH at stop: `205.2`
- Total PPH at stop: `397.2`
- Critical anomalies: `8`

Why it was rejected:

- It failed much earlier than the previous version.
- `SH-02` and `SH-05` became stationary at inbound top queue nodes with `inbound-column-predecessor-wait` / `inbound-lift-fifo-wait`.
- `SH-04` and `SH-08` entered a node-occupied stationary pair around `column-middle-c28` / `storage-r08-c28`.
- The attempted rule was too broad: it made station coordinator absence of a goal behave like a hard stop in early flow, not just at the failing bottom outbound throat.

Action taken:

- The attempted code and test were reverted.
- The failing output file is kept as evidence so this path is not retried blindly.

### Failed Attempt Reverted: Honor Outbound Clearance Local Route As Goal

Tried change:

- Let `agentGoalNodeId()` honor `localRouteReason = outbound-station-await-transition-clearance` the same way it already honors `bottom-lane-meter-clearance`.
- Rationale: in the `16200s` checkpoint, `SH-05` appeared to be repeatedly installed onto a local clearance route from `module-02-spine-bottom-a` to `column-bottom-a-c22`, then losing that route before movement.

Validation:

- File: `output/review/physical-16500s-after-outbound-clearance-goal.json`
- Intended duration: `16500s`
- Actual final simulated time: `3600s`
- Run status: `stopped-critical`
- Inbound PPH at stop: `222`
- Outbound PPH at stop: `139`
- Total PPH at stop: `361`
- Critical anomalies: `11`

Why it was rejected:

- It failed earlier than the previous best usable version.
- At `3600s`, six vehicles had stationary/no-task risk windows, including:
  - `SH-01` blocked by `SH-03` at `column-bottom-a-c18`.
  - `SH-02` in `local-yield-hold` at `storage-r14-c21`.
  - `SH-03` stationary at `column-bottom-a-c19` with no wait reason.
  - `SH-07` and `SH-08` in `outbound-station-await-transition`.
- The local clearance route was probably a symptom, not a safe root-level fix. Letting it execute changed early queue dynamics and made the system worse.

Action taken:

- The attempted code and test changes were reverted.
- Keep the output file as evidence. Do not retry this narrow local-route goal change without a broader station-throat ownership model.

## If The Deadline Arrives Before Full Fix

At **2026-06-25 12:30 PDT**, if the full problem is not fixed and verified:

1. Stop new feature/debug changes.
2. Run `git status --short --branch`.
3. Make sure this file includes:
   - best usable output files
   - latest validation result
   - exact unresolved issue
   - whether current WIP is verified or not
4. Commit all relevant code, docs, and review handoff files.
5. Push branch `codex/traffic-v2-flow-debug` to GitHub.
6. Tell the user exactly which commit to hand to the next AI.

Suggested final commit message if unresolved:

```text
checkpoint: document shuttle traffic v2 unresolved handoff
```

Suggested final commit message if resolved:

```text
fix: stabilize shuttle traffic v2 resource contracts
```

## Recommended Next AI Entry Point

Start with these files:

1. `docs/deadline-handoff-2026-06-25.md`
2. `docs/shadow-resource-ledger-step-1.md`
3. `docs/chatgpt-pro-review-handoff-2026-06-24-round14.md`
4. `docs/chatgpt-pro-review-response-2026-06-24-round14.md`
5. `scripts/run-physical-24h-amr-audit.ts`
6. `packages/shuttle-sim-core/src/index.ts`
7. `packages/shuttle-sim-core/src/index.test.ts`

Do not trust a 10m run alone. Previous short-window improvements repeatedly failed in longer windows.
