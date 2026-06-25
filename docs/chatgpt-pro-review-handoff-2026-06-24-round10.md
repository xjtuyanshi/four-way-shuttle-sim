# ChatGPT Pro Review Handoff - 2026-06-24 Round 10

## Repo State

- Repo: `git@github.com:xjtuyanshi/four-way-shuttle-sim.git`
- Local path: `/Users/lukegogogo/codex projects/four-way-shuttle-sim-2.0`
- Branch: `codex/traffic-v2-flow-debug`
- Current HEAD: `c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0`
- Working tree: dirty WIP, not committed.
- Changed tracked files:
  - `packages/shuttle-schemas/src/index.ts`
  - `packages/shuttle-sim-core/src/index.ts`
  - `packages/shuttle-sim-core/src/index.test.ts`
  - `scripts/run-physical-24h-amr-audit.ts`
- New review docs from prior rounds are untracked:
  - `docs/chatgpt-pro-review-handoff-2026-06-24-round7.md`
  - `docs/chatgpt-pro-review-handoff-2026-06-24-round8.md`
  - `docs/chatgpt-pro-review-handoff-2026-06-24-round9.md`
  - `docs/chatgpt-pro-review-response-2026-06-24-round7.md`
  - `docs/chatgpt-pro-review-response-2026-06-24-round8.md`
  - `docs/chatgpt-pro-review-response-2026-06-24-round9.md`

This handoff is for external review before more local patching. Do not treat the WIP as ready to commit.

## User Goal

The user needs a high-fidelity 3D tick four-way shuttle simulation suitable for customer review:

- Vehicles must stay on the yellow feasible grid.
- Collision avoidance must prevent AMR overlap / pass-through in 2D and 3D.
- Lift queue behavior should be simple and DES-like: lifts call shuttle resources, shuttles queue in order, and station/lift ownership should be explicit rather than emergent from ad hoc route patches.
- Every simulation run must update `output/review/sim-run-rolling-log.html` with why it was rerun, what problem was observed, what was fixed or validated, PPH, anomalies, and output path.
- Long validation needs hourly PPH and per-10-minute per-AMR task counts; if AMRs get stuck, loop, or complete zero tasks in a 10-minute window, that must be recorded.

## Previous Pro Round 9 Conclusion

Round 9 requested changes and warned that the project was not missing another local path patch. It identified three core contract gaps:

1. Assignment results are not atomic: `assigned` can coexist with no route and no explicit wait/hold contract.
2. Station shadow and control ownership are mixed: observer-derived leases can feed control.
3. Deadlock detection mixes observation, recovery side effects, and confirmed accounting.

Round 9 also warned that `getState()` must be read-only before long A/B is trusted, and suggested separating `wait-cycle-observed`, `recovery-issued`, and `deadlock-confirmed`.

## WIP Since Round 9

### 1. Observer purity

- Removed mutating station-kernel reconciliation from `getState()`.
- Added a test that monkey-patches `reconcileStationKernelShadowState`, calls `getState()` / `getEventLog()`, and asserts observer calls are read-only.

### 2. Explicit queue hold after inbound assignment

- Added `installAssignedInboundQueueHoldIfNeeded(vehicle, task, route)`.
- If assignment installs a self-route and `topLiftInboundQueueHoldActive()` is true, it writes an explicit `waiting-blocked` queue hold rather than leaving `assigned + route=[current] + waitReason=null`.
- Focused test passed.

### 3. Deadlock accounting split

- Recovery can still trigger at `deadlockDetectSec`.
- `deadlockCount` now requires a confirmed wait-cycle age of at least 30 seconds.
- Short recovered cycles no longer increment confirmed deadlock count.
- Focused test passed.

### 4. FIFO audit eligibility

- `queuedTaskEligibleForLiftFifoAudit()` now excludes queued tasks blocked by assignment priority or station capacity (`taskAssignmentBlockReason()`).
- This removed `lift-fifo-inversion` from the short gate where older outbound tasks were not actually eligible because a station visit was full.

### 5. Conflict session lifecycle fixes

Observed after FIFO fix:

- `conflict-session-without-yield-hold` samples remained.
- At 330s, a yielder had already departed a pocket edge, but the session still stayed `holding-pocket`.
- At 1280s and 1980s, sessions were still `yielding`, but vehicles had resumed non-yield main routes and had no local route or yield hold.

Changes:

- `holding-pocket` now recognizes yielder departure when the vehicle is on an edge whose target is no longer the pocket.
- Added `conflictSessionYielderHasActiveYieldIntent()`:
  - active local yield route, or
  - active yield hold, or
  - the session clearance route still matches the vehicle's active route.
- `updateConflictSessions()` now closes stale `yielding` / `holding-pocket` sessions as `yield-intent-ended`.
- Shadow ledger uses the same helper, so a valid route-continuation session is not falsely reported.

### 6. Shadow duplicate-owner semantics

Remaining 150s short-gate sample:

- `SH-05` had a hard `targetNodeId=column-middle-c08`.
- `SH-03` was taskless, `targetNodeId=null`, `currentEdgeId=null`, with only `plannedRouteNodeIds` including `column-middle-c08`.
- No waiting, no blocked vehicles, no conflict session, min separation 1.34945m.

Change:

- `duplicate-resource-owner` now counts hard shadow leases only.
- `planned-route-claim` remains in diagnostics but no longer constitutes a hard owner by itself.
- Added a direct regression test for this exact shape.

## Validation Results

## Post-Review Local Progress

After receiving the round10 review, one narrow P1 observer-purity fix was applied:

- `createSnapshot()` no longer calls `reconcileStationKernelShadowState()`.
- `createSnapshot()` is now guarded by `diagnosticReadOnlyDepth`, matching `getState()` read-only behavior.
- The observer purity test now monkey-patches `reconcileStationKernelShadowState()` before calling `createSnapshot()`, `getState()`, and `getEventLog()`, then asserts no reconcile calls and stable snapshot hash.
- Added an observer-sampling determinism test: two restored sims start from the same snapshot; one runs without observers while the other calls `getState()`, `createSnapshot()`, and `getEventLog()` every tick. The final `stateHash` and `eventLogHash` must match.
- Added `plannedRouteOverlap` as a separate watch-only shadow ledger invariant. This preserves Pro's recommended split: hard duplicate owners exclude `planned-route-claim`, but soft planned-route overlap is still visible as evidence instead of being silently hidden.
- Added a regression test where one vehicle only has a planned route through another vehicle's occupied node. The ledger now reports `planned-route-overlap` without reporting `duplicate-resource-owner`.

Validation:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "diagnostic observers read-only|station shadow contract sampling read-only|observer sampling frequencies|planned route overlap|shared post-target planned routes" --reporter=dot
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

Both passed on 2026-06-24. This only clears the observer-purity/determinism and planned-route-overlap diagnostics slices; the full core suite is still not green and no long run should be treated as validated yet.

### Station Kernel Refresh Progress

The next narrow architecture step moved more station-control reads to the station-owned kernel instead of legacy/observer-derived state:

- `assignTaskToVehicle()` now refreshes station kernel / outbound station runtime at the end of a real task assignment, so assignment writes immediately produce the corresponding queue/service lease state.
- `bestAvailableVehicleForTask()` refreshes control state when it is used as a control query outside diagnostic read-only mode. This fixes the case where outbound assignment did not see that SH-01 must be protected for inbound queue reserve, while SH-02 was still valid for outbound work.
- `stationKernelReserveAdmissionCoverageGap()` now uses station-kernel queue lease coverage, not the legacy physical standby coverage. This keeps admission decisions aligned with the station-owned lease ledger.
- Tests that directly mutate private vehicle fields now explicitly call `reconcileControlStateAfterMutation()` before asserting station kernel state. That keeps observer calls read-only instead of relying on `getState()` to repair a manually staged internal state.

Validation:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "diagnostic observers read-only|station shadow contract sampling read-only|observer sampling frequencies|planned route overlap|shared post-target planned routes|uses outbound station envelope passes|drains foreign occupants before granting|holds outbound station envelope ownership|station-owned shadow contracts|station shadow surfaces|station kernel models source supply|station kernel tracks true inbound task demand|protects taskless shuttles for inbound queue reserve|admits a short station reserve route" --reporter=dot
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts --reporter=json --outputFile=output/review/core-full-suite-after-station-kernel-refresh-v3.json
```

Results on 2026-06-24:

- Focused gate: 14 passed, 520 skipped.
- Typecheck: passed.
- Full core suite: 534 total, 499 passed, 35 failed.
- Before/after full-suite failure count: 42 -> 35.
- Newly introduced failures versus `output/review/core-full-suite-current.json`: 0.
- Failures removed:
  - `admits a short station reserve route before assigning ordinary outbound work`
  - `keeps a loaded outbound shuttle in the service lane moving toward dropoff instead of backing into queue`
  - `logs a station queue lease release when a reserve route is reset before service`
  - `reports station-owned shadow contracts for inbound demand, queue reservation, and active service`
  - `station kernel models source supply as arrival intent without task demand`
  - `station kernel tracks true inbound task demand through snapshot restore`
  - `station shadow surfaces blocked active inbound service vehicles`

Remaining release blockers are still broad top-lift queue routing, outbound follower metering, side-yield, storage allocation, and one capacity tolerance edge. No 24h run should be treated as validated while the full suite is red.

### Focused tests

Passed:

- explicit inbound queue self-route hold
- observer purity
- no short recovered wait-for cycle counted as confirmed deadlock
- FIFO audit ignores station-capacity-blocked queued tasks
- conflict session pocket yielder on return edge
- valid active clearance route not flagged
- stale yielding session closes after yielder resumes non-yield route
- taskless inactive planned route vs moving target claim
- related shadow planned-route tests

### Typecheck

Passed:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
```

### Short gate A/B progression

All runs used the 8-shuttle physical 3D tick audit path and wrote to the rolling log.

1. `output/review/physical-2100s-after-fifo-audit-eligibility-5s.json`
   - Final sim time: 2100s
   - PPH: total 456, inbound 325.714, outbound 130.286
   - Deadlocks: 0
   - Physical violations: 0
   - Anomalies: 0
   - Shadow samples with violations: 13
   - Top codes: `conflict-session-without-yield-hold` 12, `duplicate-resource-owner` 1

2. `output/review/physical-2100s-after-conflict-return-lifecycle-5s.json`
   - PPH unchanged: total 456, inbound 325.714, outbound 130.286
   - Shadow samples with violations: 7
   - `conflict-session-without-yield-hold`: 6
   - `duplicate-resource-owner`: 1

3. `output/review/physical-2100s-after-yield-intent-lifecycle-5s.json`
   - PPH unchanged: total 456, inbound 325.714, outbound 130.286
   - Shadow samples with violations: 1
   - Remaining code: `duplicate-resource-owner` 1

4. `output/review/physical-2100s-after-hard-shadow-owner-5s.json`
   - PPH unchanged: total 456, inbound 325.714, outbound 130.286
   - Deadlocks: 0
   - Livelocks: 0
   - Physical violations: 0
   - Min separation: 1.2m
   - Anomalies: 0
   - Final waiting vehicles: 0
   - Shadow samples: 420
   - Shadow samples with violations: 0
   - Top violation codes: none

### Rolling log

The latest run was recorded in `output/review/sim-run-rolling-log.html` and `output/review/sim-run-rolling-log.json` with:

- why rerun: validate planned-route soft lease no longer counts as hard physical owner
- observed problem: 150s duplicate owner between taskless `target=null` planned route and moving target claim
- solved problem: duplicate owner now counts hard leases only
- PPH: total 456, inbound 325.714, outbound 130.286
- anomalies: 0
- output path: `output/review/physical-2100s-after-hard-shadow-owner-5s.json`

### Full core test suite

Command:

```bash
./node_modules/.bin/vitest packages/shuttle-sim-core/src/index.test.ts
```

Result:

- 532 tests total
- 490 passed
- 42 failed
- 1 Vitest worker timeout / unhandled error
- Runtime about 113s

The failures are broad and not limited to the latest small lifecycle/audit changes. They cluster around:

- station shadow contract expected counts
- station kernel demand token expectations
- inbound queue reserve staging
- outbound station queue/dropoff routing expectations
- side-yield tests where expected reroute/session did not appear
- some top-lift inbound allocation and queue successor expectations
- one theoretical capacity tolerance edge

Representative failures:

- `reports station-owned shadow contracts for inbound demand, queue reservation, and active service`
- `station shadow surfaces blocked active inbound service vehicles`
- `station kernel models source supply as arrival intent without task demand`
- `station kernel tracks true inbound task demand through snapshot restore`
- `admits a short station reserve route before assigning ordinary outbound work`
- `logs a station queue lease release when a reserve route is reset before service`
- `stages the next inbound column after the current FIFO column pickup is released`
- `dispatches bounded prefetch top-lift inbound work at startup`
- `clears empty outbound dropoff shuttles from the lift-side service dock before reassignment`
- `does not assign a primed top-lift inbound task after near-full seeding occupies its dropoff` timed out
- `blocks unloaded vehicles from entering an active outbound dock protected node`
- several outbound station follower/dropoff expected-goal tests now expect old dock/buffer routes
- several side-yield tests expect a yield event/session that no longer appears

Because of these failures, the current WIP should not be committed as a verified branch even though the short 2100s audit gate is clean.

## Post-Review Local Progress: Outbound Meter / Dispatch V4

After the station-kernel observer/read-only refresh, I isolated one outbound station follower group instead of continuing broad local patching.

Focused gate:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "stages outbound lift queues|redirects a loaded outbound follower|meters a loaded outbound follower|drops an obsolete station-entry sticky goal|routes loaded outbound dropoff to the lift service drop point" --reporter=dot
```

Result:

- Before V4: 5 failed.
- After V4: 5 passed.

Changes made:

- `stationCoordinatorOutboundDispatchGoalNodeId()` no longer makes every non-head loaded outbound follower skip the nearest meter slot. It only skips the first meter slot when the current head lease actually targets that first meter slot.
- Outbound service-lane dropoff target chaining now routes from `column-bottom-a-cXX` through `column-bottom-b-cXX` before the lift entry/service nodes.
- `outboundStationAuthoritativeGoalNodeId()` / `outboundStationAwaitingTransition()` no longer use a default station boundary when the concrete dropoff cannot produce an `OutboundStationPlan`. This prevents an explicit service-lane dropoff from being hijacked to the generic pass/gate node.
- The focused queue staging test now models a physically real loaded predecessor instead of allowing an unpicked outbound task to hold the loaded dropoff queue.

Validation:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts --reporter=json --outputFile=output/review/core-full-suite-after-outbound-meter-v4.json
```

Full-suite comparison:

- V3 `output/review/core-full-suite-after-station-kernel-refresh-v3.json`: 534 total, 499 passed, 35 failed.
- V4 `output/review/core-full-suite-after-outbound-meter-v4.json`: 534 total, 505 passed, 29 failed.
- Resolved failures: 6.
- New failures: 0.

Resolved in V4:

- `does not let an unpicked outbound task hold the loaded dropoff queue`
- `drops an obsolete station-entry sticky goal and re-meters the outbound follower`
- `meters a loaded outbound follower before a yellow-grid dropoff while the earlier dropoff is active`
- `redirects a loaded outbound follower from occupied station entries to an approach meter`
- `routes loaded outbound dropoff to the lift service drop point without entering the buffer`
- `stages outbound lift queues on upstream yellow-grid approach nodes outside the service lane`

Current status remains **not ready for commit / not ready for 24h** because 29 full-suite failures remain, mostly around inbound FIFO / column reserve, side-yield behavior, empty blocker movement, and a top-lift capacity expectation.

## Post-Review Local Progress: Inbound FIFO / Queued Retarget V6

After V4, I isolated the inbound FIFO / column reserve / queued retarget group. This was intentionally scoped to station/resource-contract behavior, not a physical 24h run.

Focused gate:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "leases the alternate-side storage prefix|stages the next inbound column|dispatches bounded prefetch|moves a later same-lift task|clears an unready inbound pickup|keeps top-lift inbound allocation bounded|does not assign a primed top-lift inbound|lets the physically leading inbound queue|lets later inbound column tasks|lets a staged inbound lift follower|lets a same-column inbound successor" --reporter=dot
```

Result:

- Before V6: the inbound subgroup still had 10 failing cases.
- After V6: 11/11 focused cases passed, including the access-lease regression guard.

Changes made:

- Queued inbound retarget is now limited to the intended case: an empty reserved dropoff whose access gap is no longer reachable. If the reserved dropoff is physically occupied by another stored load, the task remains `storage-full` and does not suddenly retarget and steal the lift source front.
- Same-column inbound successors can reserve the yellow queue while a loaded-away predecessor is still moving toward its deeper cell. They are no longer retargeted into a different column just because the predecessor's access lease temporarily makes the target unreachable.
- A storage-full queued predecessor no longer starves a later staged follower by being retargeted and reassigned before the follower can proceed.
- `addLoadsForTest()` was added for near-full seed setup. The prior timeout was caused by the test helper calling `getState()` and station reconciliation hundreds of times; the actual 5-second simulation window remained millisecond-scale.
- Access-lease semantics were split: diagnostics/protection still include active inbound dropoff access leases by default, while storage selection / queued retarget / assignment-block checks explicitly ignore uncommitted access leases so early assigned-but-unloaded tasks do not over-lock a column.
- The physically-leading inbound queue test was corrected to match its name and business semantics: when the later vehicle is physically at the front queue slot and its load is ready, while the earlier task is behind and not ready, the front vehicle should proceed to pickup, not hold on FIFO.

Validation:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts --reporter=json --outputFile=output/review/core-full-suite-after-inbound-retarget-v6.json
```

Full-suite comparison:

- V4 `output/review/core-full-suite-after-outbound-meter-v4.json`: 534 total, 505 passed, 29 failed.
- V6 `output/review/core-full-suite-after-inbound-retarget-v6.json`: 534 total, 515 passed, 19 failed.
- Resolved failures: 10.
- New failures: 0.

Resolved in V6:

- `clears an unready inbound pickup stop into adjacent storage even when that column is active`
- `dispatches bounded prefetch top-lift inbound work at startup`
- `does not assign a primed top-lift inbound task after near-full seeding occupies its dropoff`
- `keeps top-lift inbound allocation bounded while a SKU column is active`
- `lets a same-column inbound successor reserve the yellow queue when its predecessor is loaded away`
- `lets a staged inbound lift follower pass a storage-full queued predecessor`
- `lets later inbound column tasks stage in the yellow queue while deeper predecessors pick`
- `lets the physically leading inbound queue shuttle proceed when an earlier task is behind it`
- `moves a later same-lift task off the pickup point when the earlier load is still first`
- `stages the next inbound column after the current FIFO column pickup is released`

Current status remains **not ready for commit / not ready for 24h** because 19 full-suite failures remain. Remaining failures are concentrated around outbound dock protection, loaded/empty blocker relocation, agent-refresh side-yield, storage-row swap behavior, and one top-lift theoretical capacity tolerance expectation.

## Questions for ChatGPT Pro

Please review as an external senior simulation / material-flow / controls reviewer. The user explicitly does not want more blind local patches.

1. Given the short 2100s gate is clean but the full unit suite has 42 failures, should the next step be:
   - revert/split some WIP,
   - update stale tests to the new station contract,
   - or stop and implement the explicit `VehicleIntent` / station-resource boundary suggested in Round 9?
2. Is the latest `conflictSessionYielderHasActiveYieldIntent()` lifecycle model conceptually correct, or does it risk hiding missing yield installation?
3. Is counting only hard leases for `duplicate-resource-owner` the right shadow ledger semantics, or should soft planned-route overlaps be preserved under a separate invariant class?
4. How should the project split observer diagnostics vs enforceable control state so `getState()` and audit frequency cannot affect simulation behavior?
5. What is the minimum next architecture step to avoid another week of single-case queue/yield patches?
6. Before a 24h run, what exact validation ladder should be required? For example:
   - focused tests
   - typecheck
   - 2100s clean shadow gate
   - 2h clean gate
   - 8h degradation gate
   - then 24h audit with hourly PPH and per-10-minute per-AMR task matrix.
7. Which parts of the current WIP should be preserved, and which should be treated as dangerous because they alter behavior without a clear contract?

## Review Prompt To Submit

```text
请作为外部资深 reviewer 审查这个 GitHub 项目和当前分支/本地 WIP。

Repo: git@github.com:xjtuyanshi/four-way-shuttle-sim.git
Branch: codex/traffic-v2-flow-debug
HEAD: c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0
Handoff doc: docs/chatgpt-pro-review-handoff-2026-06-24-round10.md

重要：当前 WIP 未提交，GitHub 上可能只能看到 HEAD，不一定能看到 dirty diff。请优先基于 handoff 中描述的失败面、验证结果和代码路径给架构 review。如果需要具体代码，我可以继续贴关键片段。

背景：
用户需要一个真实的 3D tick four-way shuttle simulation，用于客户 review。核心要求是 yellow feasible grid 内运行、无穿模、lift queue 语义简单、8 台 shuttle 默认、能够长跑 24h，并输出 hourly PPH 与每 10 分钟每台 AMR 完成任务数。用户明确要求不要继续盲目本地 patch；卡住时必须找 ChatGPT Pro/Extended Pro review。

当前状态：
短 2100s gate 已经通过，shadow violations 从 13 -> 7 -> 1 -> 0，PPH 不变，deadlock=0，physical violation=0，anomaly=0。随后本地又做了两个 scoped validation gate：outbound meter/dispatch V4 把 full suite 从 35 fail 降到 29 fail；inbound FIFO / queued retarget V6 把 full suite 从 29 fail 降到 19 fail，新增失败 0。完整 core test suite 仍然是红的：534 total, 515 passed, 19 failed。剩余失败集中在 outbound dock protection、loaded/empty blocker relocation、agent-refresh side-yield、storage-row swap 和 top-lift capacity tolerance。

请重点回答：
1. 这是不是系统架构/资源契约问题，而不是单点路径规划 bug？
2. 现在应该继续局部修测试，还是先建立明确 VehicleIntent / StationLease / ConflictSession 边界？
3. 最新 lifecycle 和 hard lease shadow owner 语义是否正确？
4. 哪些 WIP 应该保留，哪些应该暂停或拆分？
5. 下一步最小可行重构与验证 ladder 是什么？
6. 在 24h 长跑前，必须满足哪些 gate？

请给出可执行、优先级明确的 review 结论，尤其说明“不要做什么”。
```

## Post-Review Local Progress: Side-Yield / First-Target Blocker V7

After V6, I isolated the remaining agent-refresh side-yield / first-target blocker group. This was intentionally kept as a unit-test contract gate, not a physical 24h run.

Focused gate:

```bash
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts -t "clears a loaded outbound bottom-a meter blocker|moves an empty top-lift queue blocker deeper|agent-refresh makes the lower-priority empty shuttle side-yield|agent-refresh makes a lower-priority loaded shuttle side-yield|agent-refresh blocks an empty shuttle from using stored load cells|agent-refresh blocks an empty shuttle from using another active inbound dropoff" --reporter=dot
```

Result:

- Before V7: 6 focused cases were failing or unstable in this group.
- After V7: 6/6 focused cases passed.

Changes made:

- `agentRefreshFirstTargetClaimBlocker()` no longer causes an immediate wait before `agentRefreshHandleMoveBlock()` can install a side-yield. This fixed the generic lower-priority empty/loaded side-yield cases.
- `bottom-lane-meter-clearance` now has a narrow bypass for `outbound-station-await-transition` only when the clearance move is from the current node to the opposite bottom lane node. This avoids holding a local clearance route behind the station transition gate while preserving normal outbound station transition waits.
- Top-lift queue blocker deeper movement can infer a projected yellow-grid queue node and route to the deeper parking slot through real adjacent hops, rather than relying on an impossible direct parking shortcut.

Validation:

```bash
./node_modules/.bin/tsc -p packages/shuttle-sim-core/tsconfig.json --noEmit
./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts --reporter=json --outputFile=output/review/core-full-suite-after-side-yield-first-target-v7.json
```

Full-suite comparison:

- V6 `output/review/core-full-suite-after-inbound-retarget-v6.json`: 534 total, 515 passed, 19 failed.
- V7 `output/review/core-full-suite-after-side-yield-first-target-v7.json`: 534 total, 522 passed, 12 failed.
- Resolved failures: 8.
- New failures: 1.

Resolved in V7:

- `agent-refresh blocks an empty shuttle from using another active inbound dropoff as a temporary pocket`
- `agent-refresh blocks an empty shuttle from using stored load cells as temporary pockets`
- `agent-refresh clears loaded storage-row swaps through the nearest side aisle`
- `agent-refresh makes a lower-priority loaded shuttle side-yield after an adjacent main-aisle faceoff`
- `agent-refresh makes the lower-priority empty shuttle side-yield instead of reversing`
- `breaks a persisted loaded middle-spine swap before the long-run blocked signature trips`
- `clears a loaded outbound bottom-a meter blocker into bottom-b when it blocks loaded inbound cross travel`
- `moves an empty top-lift queue blocker deeper when a loaded shuttle exits the lift service lane`

New failure introduced in V7:

- `proactively clears reciprocal storage swaps before moving same-column queue followers`

Remaining failures after V7:

- `blocks unloaded vehicles from entering an active outbound dock protected node`
- `clears empty outbound dropoff shuttles from the lift-side service dock before reassignment`
- `displaces an idle storage shuttle blocking an empty task route`
- `exits a filled top-lift storage column from the opposite side before returning to inbound work`
- `keeps a trailing loaded outbound shuttle in its lift queue slot until the front dropoff clears`
- `lets a loaded outbound shuttle clear top-b when an inbound lift departure is waiting for that exact node`
- `moves an empty access blocker into storage to open a loaded inbound column entry chain`
- `moves an empty storage exit blocker to an adjacent pocket before loaded inbound column entry`
- `parks inbound-only idle shuttles inside storage cells before using aisle-side pads`
- `reports top-lift theoretical capacity as four physical bounds instead of the legacy inbound-only formula`
- `reroutes a loaded inbound shuttle around an occupied non-target storage transit column`

Decision:

V7 has a real net improvement, but the single new reciprocal-storage-swap failure triggers the user's stop rule. Do not continue local patching blindly. Freeze this evidence and ask ChatGPT Pro Extended to review whether the remaining failures and the new regression are symptoms of one missing resource/intent boundary, rather than separate pathing bugs.

## Updated Questions For ChatGPT Pro

Please review V4/V6/V7 as one sequence, with special attention to the new V7 regression.

1. Did V7's first-target side-yield bypass fix a real bug while exposing a stale reciprocal-storage-swap expectation, or did it introduce an unsafe priority inversion?
2. Are the remaining 12 failures mostly symptoms of one missing explicit `VehicleIntent` / `StationLease` / `ConflictSession` boundary?
3. Should the next step be to continue small contract groups, or pause and implement a minimal controlling intent/resource layer before any more side-yield patches?
4. Which V7 changes should be preserved, and which should be reverted or guarded before physical 3D long-window testing?
5. What validation ladder should be required before returning to 2h/8h/24h physical runs?

## Post-Pro Local Progress: Reciprocal Storage Swap P0-A Diagnosis

After ChatGPT Pro Round 11, I did not continue local waitReason/node-id patching. I implemented a first-divergence diagnosis script:

```bash
./node_modules/.bin/tsx scripts/diagnose-reciprocal-storage-swap.ts --out output/review/reciprocal-storage-swap-first-divergence-v7.json
```

This script reproduces the V7 new failure fixture and runs two variants:

- `current`: current V7 behavior.
- `forced-loaded-storage-swap-first`: manually installs the loaded-storage-swap break before the normal tick.

Result summary:

- `current`
  - first replan: `agent-refresh-storage-column-queue-yield`
  - final waiting vehicles: 1
  - active unresolved conflict sessions: 1
  - physical violations: 0
  - hard fail reasons: `unresolved-conflict-session`, `repeated-conflict-session-resource`
- `forced-loaded-storage-swap-first`
  - first replan: `agent-refresh-loaded-storage-swap-clearance`
  - final waiting vehicles: 0
  - active unresolved conflict sessions: 1
  - physical violations: 0
  - hard fail reasons: `unresolved-conflict-session`, `repeated-conflict-session-resource`

Interpretation:

- The old failing assertion (`routeReplans[0] must be loaded-storage-swap-clearance`) is too sequence-specific by itself.
- But the fixture is not safe to reclassify as a stale test yet. Even when loaded-storage-swap clearance is forced first, the run still develops repeated SH-01/SH-02 conflict sessions and leaves an unresolved session by 15s.
- Therefore this is a real P0 evidence item for the missing `VehicleIntent` / `StationLease` / `ConflictSession` boundary. It should not be solved by changing the expected first event or adding another local bypass.

Updated decision:

- Keep V7 direction, but do not enter 2h/8h/24h physical runs.
- Do not simply update the reciprocal-storage-swap test to accept the current sequence.
- Next implementation should start P0-B/P0-C: include station runtime / intent / lease / session sequences in snapshots and implement atomic VehicleIntent assignment, then retest this diagnosis.
